#!/usr/bin/env bash
# tfstate の退避と、退避物から復元できることの確認（Issue #4・infra/terraform/README.md §3）。
#
#   infra/scripts/tfstate-backup.sh backup <env> <label>   # 今の state を別キーへ退避し、読み戻して一致を確かめる
#   infra/scripts/tfstate-backup.sh verify <env> <key>     # 退避物を一時キーに置き、そこから plan して No changes になることを確かめる
#   infra/scripts/tfstate-backup.sh list   <env>           # 退避物の一覧
#
# なぜ要るか：R2 はバケットのバージョニングに対応していない。apply が state を壊しても、S3 のように前の版へは戻せない。
# だから apply の前後に、同じバケットの別キー（backups/<env>/<UTC>-<label>.tfstate）へ写しておく。
#
# ── verify は本物の state に触れない ─────────────────────────────────────────
# 退避物を一時キー（restore-check/<env>/…）へ置き、別の作業領域（TF_DATA_DIR）でその一時キーを backend にして
# `terraform plan -detailed-exitcode` を実行する。exit 0（No changes）なら、その退避物は「実物の資源と過不足なく対応する
# state」であり、本物のキーへ戻せば元どおりに動く。最後に一時キーを消す。本物のキーには読み書きしない。
#
# ── 本当に戻すとき（手で行う。スクリプトにしない）────────────────────────────
# state の上書きは取り返しがつかないので、人が立ち会って次を実行する（README §3）。
#   1. 今の state もまず backup で退避する（戻し先を失わないため）
#   2. 退避物を手元に取り出し、`terraform -chdir=infra/terraform/envs/<env> state push <file>` で戻す
#   3. `terraform plan -detailed-exitcode` が exit 0 になることを確かめる
#
# ── 資格情報 ─────────────────────────────────────────────────────────────
# backup / list は tfstate の backend（R2）の3つだけを使う：AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_ENDPOINT_URL_S3。
# verify は plan のために provider の認証も要る：CLOUDFLARE_API_TOKEN と TF_VAR_account_id（production は TF_VAR_account_id_prod）。
#
# ── 安全面 ─────────────────────────────────────────────────────────────────
# - 秘密はコマンド引数に載せない。curl へは設定を標準入力で渡す（プロセス一覧に出ない）
# - endpoint URL はアカウント ID を含むので表示しない。curl と terraform のエラーは 32 桁の16進を伏せてから出す
# - state 本体（account_id を含む）は表示しない。出すのはキー・sha256・serial・資源数だけ
# - 手元に作る一時ファイルは mktemp の中に置き、終了時に消す
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUCKET="musubi-tfstate"
export CHECKPOINT_DISABLE=1

usage() {
  sed -n '3,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

redact() { sed -E 's/[0-9a-fA-F]{32}/<REDACTED>/g'; }
die() { echo "NG  $*" >&2; exit 1; }

need_backend_env() {
  local v
  for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3; do
    [ -n "${!v:-}" ] || die "${v} が無い（backend の資格情報。README §2 の手順で読み込む）"
  done
}

check_env_name() {
  case "${1:-}" in
    dev | staging | production) ;;
    *) die "env は dev / staging / production のどれか" ;;
  esac
  [ -d "${ROOT}/infra/terraform/envs/$1" ] || die "infra/terraform/envs/$1 が無い"
}

TMP="$(mktemp -d)"
chmod 700 "${TMP}"
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

# s3 <METHOD> <path> [curl の設定行 ...] → HTTP ステータスを標準出力に出す。
# path は "<key>" か "?<query>"。設定（URL・鍵）は標準入力で curl に渡す。
s3() {
  local method=$1 path=$2 url cfg opt status
  shift 2
  if [ "${path:0:1}" = "?" ]; then url="${AWS_ENDPOINT_URL_S3%/}/${BUCKET}${path}"; else url="${AWS_ENDPOINT_URL_S3%/}/${BUCKET}/${path}"; fi
  cfg="url = \"${url}\""$'\n'"user = \"${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}\""$'\n'"aws-sigv4 = \"aws:amz:auto:s3\""$'\n'"request = \"${method}\""
  for opt in "$@"; do cfg+=$'\n'"${opt}"; done
  if ! status="$(printf '%s\n' "${cfg}" | curl -q --silent --show-error --max-time 60 --config - --write-out '%{http_code}' 2>"${TMP}/curl.err")"; then
    redact <"${TMP}/curl.err" >&2
    die "${method} ${path}: curl が失敗（ネットワーク）"
  fi
  printf '%s' "${status}"
}

sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

# state の要約（本体は出さない）
describe_state() {
  # shellcheck disable=SC2016 # JS のテンプレート文字列。シェルに展開させない
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const n = (s.resources ?? []).reduce((a, r) => a + (r.instances?.length ?? 0), 0);
    process.stdout.write(`serial=${s.serial} terraform=${s.terraform_version} 資源インスタンス=${n}`);
  ' "$1"
}

cmd_backup() {
  local env=$1 label=$2 key status
  check_env_name "${env}"
  [[ "${label}" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || die "label は英小文字・数字・ハイフン（例 pre-apply / post-apply）"
  need_backend_env

  # 本物の backend で init 済みの .terraform を使う（README §2 の手順で apply した作業ディレクトリ）
  if ! terraform -chdir="${ROOT}/infra/terraform/envs/${env}" state pull >"${TMP}/state.tfstate" 2>"${TMP}/tf.err"; then
    redact <"${TMP}/tf.err" >&2
    die "envs/${env}: state pull に失敗（init 済みか・資格情報を読み込んだか）"
  fi
  if [ ! -s "${TMP}/state.tfstate" ]; then
    echo "OK  envs/${env}: state がまだ無い（初回の apply 前）。退避するものは無い"
    return 0
  fi

  key="backups/${env}/$(date -u +%Y%m%dT%H%M%SZ)-${label}.tfstate"
  status="$(s3 PUT "${key}" "upload-file = \"${TMP}/state.tfstate\"" "output = \"${TMP}/put.out\"")"
  [ "${status}" = "200" ] || die "PUT ${key}: HTTP ${status}"

  # 読み戻して一致を確かめる（書けたつもりで消えている、を防ぐ）
  status="$(s3 GET "${key}" "output = \"${TMP}/readback.tfstate\"")"
  [ "${status}" = "200" ] || die "GET ${key}: HTTP ${status}"
  [ "$(sha256_of "${TMP}/state.tfstate")" = "$(sha256_of "${TMP}/readback.tfstate")" ] || die "${key}: 読み戻した内容が一致しない"

  echo "OK  退避した: ${key}"
  echo "    sha256=$(sha256_of "${TMP}/state.tfstate") $(describe_state "${TMP}/state.tfstate")"
}

cmd_verify() {
  local env=$1 key=$2 check_key status code var
  check_env_name "${env}"
  [[ "${key}" =~ ^backups/${env}/[0-9]{8}T[0-9]{6}Z-[a-z0-9-]+\.tfstate$ ]] || die "key は backups/${env}/<UTC>-<label>.tfstate の形（list で確かめる）"
  need_backend_env
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN が無い（verify は plan で資源を読む）"
  if [ "${env}" = "production" ]; then var=TF_VAR_account_id_prod; else var=TF_VAR_account_id; fi
  [ -n "${!var:-}" ] || die "${var} が無い"

  status="$(s3 GET "${key}" "output = \"${TMP}/backup.tfstate\"")"
  [ "${status}" = "200" ] || die "GET ${key}: HTTP ${status}"
  echo "..  退避物: sha256=$(sha256_of "${TMP}/backup.tfstate") $(describe_state "${TMP}/backup.tfstate")"

  check_key="restore-check/${env}/$(date -u +%Y%m%dT%H%M%SZ).tfstate"
  status="$(s3 PUT "${check_key}" "upload-file = \"${TMP}/backup.tfstate\"" "output = \"${TMP}/put.out\"")"
  [ "${status}" = "200" ] || die "PUT ${check_key}: HTTP ${status}"
  # 一時キーは成否にかかわらず消す（本物のキーではないので、残っても害は無いが散らかさない）
  trap 's3 DELETE "'"${check_key}"'" "output = \"'"${TMP}"'/del.out\"" >/dev/null || true; cleanup' EXIT

  # 本物の .terraform に触れない作業領域で、一時キーを backend にする
  if ! TF_DATA_DIR="${TMP}/tfdata" terraform -chdir="${ROOT}/infra/terraform/envs/${env}" init -input=false -reconfigure \
      -lockfile=readonly -backend-config="key=${check_key}" -no-color >"${TMP}/init.log" 2>&1; then
    redact <"${TMP}/init.log" >&2
    die "一時キーでの init に失敗"
  fi

  set +e
  TF_DATA_DIR="${TMP}/tfdata" terraform -chdir="${ROOT}/infra/terraform/envs/${env}" plan -input=false -lock=false \
    -detailed-exitcode -no-color >"${TMP}/plan.log" 2>&1
  code=$?
  set -e
  case "${code}" in
    0) echo "OK  退避物から復元した state で plan が No changes（exit 0）。${key} は復元に使える" ;;
    2)
      grep -E '^\s*# |^Plan:' "${TMP}/plan.log" | redact >&2 || true
      die "退避物から復元した state では差分が出る（exit 2）。${key} は今の資源と一致しない"
      ;;
    *)
      redact <"${TMP}/plan.log" >&2
      die "plan が失敗（exit ${code}）"
      ;;
  esac
}

cmd_list() {
  local env=$1 status
  check_env_name "${env}"
  need_backend_env
  status="$(s3 GET "?list-type=2&prefix=backups/${env}/" "output = \"${TMP}/list.xml\"")"
  [ "${status}" = "200" ] || die "LIST backups/${env}/: HTTP ${status}"
  grep -oE '<Key>[^<]+</Key>' "${TMP}/list.xml" | sed -E 's#</?Key>##g' || echo "（退避物は無い）"
}

case "${1:-}" in
  backup) [ $# -eq 3 ] || usage; cmd_backup "$2" "$3" ;;
  verify) [ $# -eq 3 ] || usage; cmd_verify "$2" "$3" ;;
  list) [ $# -eq 2 ] || usage; cmd_list "$2" ;;
  *) usage ;;
esac
