#!/usr/bin/env bash
# 試験A（05 §1）：dev を丸ごと消して、コマンドだけで元に戻す。①〜⑤を1本で流し、段ごとの所要時間を測る（Issue #67）。
#
#   infra/scripts/reproduce-dev.sh [--env-file <file>]
#
#   ① 空にする … empty-buckets.ts --env dev（R2 にオブジェクトが残っていると destroy が落ちる。README §4）
#   ① 消す     … terraform init → terraform destroy -auto-approve（infra/terraform/envs/dev）
#   ② 作り直す … terraform apply -auto-approve → terraform plan -detailed-exitcode が exit 0（No changes）
#   ③ 同期     … sync-bindings.ts --env dev（D1 の database_id が変わる）→ 同 --check が exit 0
#   ④ build    … CLOUDFLARE_ENV=dev pnpm build（host は build の時点で env が決まる。04 §4）
#   ④ 配る     … deploy-worker.ts --env dev の migrate → data-api → gateway → host（--sha は HEAD）
#   ⑤ smoke    … deploy-worker.ts --env dev --smoke --sha HEAD（宛先は API から組み立て、表示しない）
#
# 手作業の段は無い（確認のプロンプトも出ない）。1つでも落ちたらそこで止め、どの段で落ちたかと、そこまでの時間を出して exit 1。
# もう一度動かせば頭からやり直せる（empty-buckets はバケットが無ければ飛ばし、destroy は無い資源を消そうとしない）。
# 所要時間が宣言した線（15 分。README §5）を超えても、再現が通っていれば exit 0（超えたことは出す）。
#
# ── 前提（試験の「手作業」に数えない。05 §1）──────────────────────────────────
# H-01〜H-03（アカウント①・トークン・tfstate のバケット）、tfenv（.terraform-version）、pnpm install 済み。
#
# ── 資格情報 ─────────────────────────────────────────────────────────────
# リポジトリ直下の .env を読む（worktree では ./infra/scripts/link-env.sh の symlink）。--env-file で別のファイルを指せる。
# 既定の .env が無ければ、今のシェルの環境変数を使う。読んだら、資格情報の形の変数を**全部いったん環境から外し**、段ごとに要るものだけを渡す。
#   empty-buckets・terraform の provider … TF_CLOUDFLARE_API_TOKEN（Terraform 用トークン。Workers R2 Storage: Edit を含む）
#   terraform の backend・sync-bindings  … R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT（AWS_* として）
#   deploy-worker（wrangler・--smoke）   … CLOUDFLARE_API_TOKEN（CI 用トークン）
#   Cloudflare に触れる段               … CLOUDFLARE_ACCOUNT_ID（アカウント①）
# production の資格情報（*_PROD・MUSUBI_PROBE_TOKEN・SMOKE_*）はどの段にも渡さない。
# CLOUDFLARE_ACCOUNT_ID が CLOUDFLARE_ACCOUNT_ID_PROD と同じなら、何もせずに止める（empty-buckets と --smoke も同じ照合をする）。
# 値は環境変数でだけ渡す（コマンド行に載せない。プロセスの一覧に出ない）。
#
# ── 出力（公開の場に貼りうる。CLAUDE.md「このリポジトリは public である」）─────────────
# - 値を echo しない。set -x にしない
# - terraform と build の出力はログのファイルに受け、要約の行だけを出す（リソースのアドレスと Destroy / Apply の行）。
#   落ちたときは全文を出す（plan の差分はリソースのアドレスと Plan の行だけ。04 §3.1）。どれも 32 桁の 16 進（Account ID の形）と
#   workers.dev のホスト名を伏せ、terraform の [id=…] を外してから出す
# - pnpm run はスクリプトの見出しにリポジトリの絶対パスを出すので、TypeScript の道具は pnpm exec tsx で呼ぶ
# - empty-buckets・sync-bindings・deploy-worker・smoke は、それぞれ自分で値を伏せて出す（各ファイルの冒頭）
# - ログのファイル（wrangler と terraform の全文）は一時ディレクトリに残す。公開の場に貼らない
#
# ── 終わった後 ────────────────────────────────────────────────────────────
# ③ で packages/data-api/wrangler.jsonc の database_id が変わる。README §2 のとおりコミットする（再現の段ではなく、後始末）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="${ROOT}/infra/terraform/envs/dev"
# 宣言した線（README §5・05 §1）
LINE_SECONDS=900
export CHECKPOINT_DISABLE=1

say() { printf 'reproduce-dev: %s\n' "$*"; }
die() {
  printf 'reproduce-dev: NG  %s\n' "$*" >&2
  exit 1
}
usage() {
  sed -n '2,4p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}
# 32 桁の 16 進（Account ID の形。R2 の endpoint の URL も含む）と workers.dev のホスト名を伏せ、terraform の [id=…] を外す
redact() { LC_ALL=C sed -E 's/ \[id=[^]]*\]//g; s/[0-9a-fA-F]{32}/<REDACTED>/g; s/([A-Za-z0-9_-]+\.)+workers\.dev/<REDACTED>.workers.dev/g'; }

# ── 引数 ───────────────────────────────────────────────────────────────────
ENV_FILE="${ROOT}/.env"
ENV_FILE_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      ENV_FILE="$2"
      ENV_FILE_GIVEN=1
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

# ── 資格情報：読む → 取り分ける → 環境から外す ────────────────────────────────────
if [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090 # 資格情報のファイル。値は表示しない
  . "${ENV_FILE}"
elif [ "${ENV_FILE_GIVEN}" -eq 1 ]; then
  die "--env-file のファイルが無い"
fi

missing=""
for name in TF_CLOUDFLARE_API_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_S3_ENDPOINT; do
  [ -n "${!name:-}" ] || missing="${missing} ${name}"
done
[ -z "${missing}" ] || die "資格情報が無い:${missing}（.env か環境変数で渡す）。何もせずに止める"

tf_token="${TF_CLOUDFLARE_API_TOKEN}"
ci_token="${CLOUDFLARE_API_TOKEN}"
account_id="${CLOUDFLARE_ACCOUNT_ID}"
account_id_prod="${CLOUDFLARE_ACCOUNT_ID_PROD:-}"
r2_key="${R2_ACCESS_KEY_ID}"
r2_secret="${R2_SECRET_ACCESS_KEY}"
r2_endpoint="${R2_S3_ENDPOINT}"

# 資格情報の形の変数を全部外す（.env に後から足された名前も含める）。段ごとに要るものだけを、コマンドの前の代入で渡す
for name in $(compgen -v); do
  case "${name}" in
    CLOUDFLARE_* | TF_CLOUDFLARE_* | TF_VAR_* | R2_* | AWS_* | SMOKE_* | MUSUBI_* | *_PROD | *TOKEN* | *SECRET*) unset "${name}" ;;
  esac
done

lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
[[ "${account_id}" =~ ^[0-9a-fA-F]{32}$ ]] || die "CLOUDFLARE_ACCOUNT_ID が Account ID の形（32 桁の 16 進）でない（値は表示しない）"
if [ -n "${account_id_prod}" ] && [ "$(lower "${account_id}")" = "$(lower "${account_id_prod}")" ]; then
  die "CLOUDFLARE_ACCOUNT_ID が production のアカウント（CLOUDFLARE_ACCOUNT_ID_PROD）を指している。dev（アカウント①）でしか動かさない"
fi

# ── 道具 ───────────────────────────────────────────────────────────────────
cd "${ROOT}"
for tool in terraform pnpm git; do
  command -v "${tool}" >/dev/null 2>&1 || die "${tool} が見つからない"
done
[ -d "${TF_DIR}" ] || die "infra/terraform/envs/dev が無い"

# .commandmate/scripts/check-terraform.sh と同じ照合（違う版で apply すると state の形が変わりうる）。
# head で切らない（terraform が SIGPIPE で落ちる。check-terraform.sh の注意）
want="$(tr -d '[:space:]' <.terraform-version)"
tf_version_out="$(terraform version)"
have="${tf_version_out%%$'\n'*}"
have="${have#Terraform v}"
[ "${have}" = "${want}" ] || die "terraform のバージョンが .terraform-version と一致しない（入っている: ${have} / 期待: ${want}）"

sha="$(git rev-parse HEAD)"

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/reproduce-dev.XXXXXX")"
chmod 700 "${LOG_DIR}"

# ── 段ごとの呼び方（資格情報はコマンドの前の代入で、そのコマンドにだけ渡す）───────────────────────
tf() {
  CLOUDFLARE_API_TOKEN="${tf_token}" TF_VAR_account_id="${account_id}" \
    AWS_ACCESS_KEY_ID="${r2_key}" AWS_SECRET_ACCESS_KEY="${r2_secret}" AWS_ENDPOINT_URL_S3="${r2_endpoint}" \
    terraform -chdir="${TF_DIR}" "$@"
}

sync_bindings() {
  AWS_ACCESS_KEY_ID="${r2_key}" AWS_SECRET_ACCESS_KEY="${r2_secret}" AWS_ENDPOINT_URL_S3="${r2_endpoint}" \
    pnpm exec tsx infra/scripts/sync-bindings.ts --env dev "$@"
}

build_dev() { CLOUDFLARE_ENV=dev pnpm build; }

deploy_worker() {
  CLOUDFLARE_API_TOKEN="${ci_token}" CLOUDFLARE_ACCOUNT_ID="${account_id}" CLOUDFLARE_ACCOUNT_ID_PROD="${account_id_prod}" \
    pnpm exec tsx infra/scripts/deploy-worker.ts --env dev "$@"
}

# logged <ログの名前> <成功したときに出す行（ERE）> <コマンド…>
# 出力をログのファイルに受け、成功なら当たった行だけを、失敗なら全文を、伏せてから出す
logged() {
  local name=$1 pattern=$2 log code=0
  shift 2
  log="${LOG_DIR}/${name}.log"
  "$@" >"${log}" 2>&1 || code=$?
  if [ "${code}" -eq 0 ]; then
    { grep -E "${pattern}" "${log}" || true; } | redact | sed 's/^/  /'
    return 0
  fi
  say "${name}: exit ${code}。出力の全文を伏せて出す"
  redact <"${log}" | sed 's/^/  /' >&2
  return "${code}"
}

# ── 段 ─────────────────────────────────────────────────────────────────────
step_empty() {
  CLOUDFLARE_API_TOKEN="${tf_token}" CLOUDFLARE_ACCOUNT_ID="${account_id}" CLOUDFLARE_ACCOUNT_ID_PROD="${account_id_prod}" \
    pnpm exec tsx infra/scripts/empty-buckets.ts --env dev
}

step_destroy() {
  logged terraform-init '^Terraform has been successfully initialized' tf init -input=false -lockfile=readonly -no-color
  logged terraform-destroy '^(Destroy complete!|No changes\.|[^ ]+: Destruction complete)' tf destroy -auto-approve -input=false -no-color
}

step_apply() {
  logged terraform-apply '^(Apply complete!|[^ ]+: Creation complete)' tf apply -auto-approve -input=false -no-color
  local log="${LOG_DIR}/terraform-plan.log" code=0
  tf plan -detailed-exitcode -input=false -lock=false -no-color >"${log}" 2>&1 || code=$?
  case "${code}" in
    0) echo "  apply の後の plan: No changes（exit 0）" ;;
    2)
      # 差分の属性値は出さない。リソースのアドレスと Plan の行だけ（04 §3.1）
      { grep -E '^  # [^(]|^Plan: ' "${log}" || true; } | redact | sed 's/^/  /' >&2
      say "apply の後の plan に差分がある（exit 2）"
      return 1
      ;;
    *)
      say "terraform-plan: exit ${code}。出力の全文を伏せて出す"
      redact <"${log}" | sed 's/^/  /' >&2
      return 1
      ;;
  esac
}

step_sync() {
  sync_bindings
  sync_bindings --check
}

step_build() {
  logged build '^ *(Tasks|Cached|Time): ' build_dev
}

step_deploy() {
  deploy_worker --target migrate --log-dir "${LOG_DIR}"
  deploy_worker --target data-api --sha "${sha}" --log-dir "${LOG_DIR}"
  deploy_worker --target gateway --sha "${sha}" --log-dir "${LOG_DIR}"
  deploy_worker --target host --sha "${sha}" --log-dir "${LOG_DIR}"
}

step_smoke() {
  deploy_worker --smoke --sha "${sha}"
}

# ── 測りながら流す ──────────────────────────────────────────────────────────────
TIMES=""
started_all="$(date +%s)"

elapsed_all() { echo $(($(date +%s) - started_all)); }
minutes() { printf '%d 分 %02d 秒' $(($1 / 60)) $(($1 % 60)); }
print_times() {
  say "段ごとの所要時間"
  printf '%s' "${TIMES}"
}

# stage <見出し> <段の関数>。段は set -e のサブシェルで動かし、落ちたらそこで止める
stage() {
  local label=$1 fn=$2 start code=0 seconds
  say "── ${label} ──"
  start="$(date +%s)"
  set +e
  (
    set -e
    "${fn}"
  )
  code=$?
  set -e
  seconds=$(($(date +%s) - start))
  TIMES="${TIMES}  ${label}: ${seconds} 秒"$'\n'
  if [ "${code}" -ne 0 ]; then
    print_times
    die "${label} で止まった（exit ${code}）。①から $(minutes "$(elapsed_all)")。ログ: ${LOG_DIR}（全文を含む。公開の場に貼らない）"
  fi
}

say "dev を消して作り直す（試験A。05 §1）。commit ${sha}"
stage "① 空にする（R2）" step_empty
stage "① 消す（terraform destroy）" step_destroy
stage "② 作り直す（terraform apply）" step_apply
stage "③ 同期（infra:sync）" step_sync
stage "④ build（CLOUDFLARE_ENV=dev）" step_build
stage "④ 配る（migrate → data-api → gateway → host）" step_deploy
stage "⑤ 貫通スモーク" step_smoke

total="$(elapsed_all)"
print_times
if [ "${total}" -le "${LINE_SECONDS}" ]; then
  say "合計（①〜⑤）: ${total} 秒（$(minutes "${total}")）。宣言した線 ${LINE_SECONDS} 秒（15 分）以内"
else
  say "合計（①〜⑤）: ${total} 秒（$(minutes "${total}")）。宣言した線 ${LINE_SECONDS} 秒（15 分）を超えた"
fi

changed="$(git status --porcelain -- 'apps/*/wrangler.jsonc' packages/data-api/wrangler.jsonc)"
if [ -n "${changed}" ]; then
  say "infra:sync が書き換えたファイル（README §2 のとおりコミットする）:"
  printf '%s\n' "${changed}" | sed 's/^/  /'
else
  say "wrangler.jsonc は変わっていない"
fi
say "ログ: ${LOG_DIR}（wrangler と terraform の全文を含む。公開の場に貼らない）"
say "OK  dev を消して作り直し、貫通スモークが通った（commit ${sha}）"
