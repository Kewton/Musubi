#!/usr/bin/env bash
# Terraform の検証ゲート（verify.yaml の tf-fmt / tf-validate、ci.yml の同名ステップ）。
#
#   bash .commandmate/scripts/check-terraform.sh fmt
#   bash .commandmate/scripts/check-terraform.sh validate
#
# verify.yaml と ci.yml は両方ともこのファイルを呼ぶ。コマンドを2か所に書くと、
# verify-parity（gate id の並びしか見ない）が捕まえられない「中身のズレ」が起きるため。
# .commandmate/ に置くのは、ワーカーが「常に通る」ように書き換えられないようにするため。
#
# ── 資格情報を一切使わない ─────────────────────────────────────────
# validate は `terraform init -backend=false` で provider だけ取得する。state にも Cloudflare にも触れない。
# だから fork からの PR でも、公開ログでも、秘密が要らない（04 §3.1）。
#
# ── TF_DATA_DIR を分ける理由 ──────────────────────────────────────
# 実 backend で `terraform init` 済みの環境ディレクトリ（README の手順で apply した worktree）には
# s3 backend を向いた .terraform/ が残る。そこで素直に -backend=false を実行すると、
# 残った backend 設定が資格情報を探して `No valid credential sources found` で落ちる（2026-09-13 実測）。
# 検証用の作業領域を .terraform-validate/ に分けると、実 backend の .terraform/ に触れずに済む。
#
# ── バージョンのピンを検査する ────────────────────────────────────
# hashicorp/setup-terraform に `terraform_version_file` という入力は無い。書いても無視されて
# 最新版が入り、ピンが黙って効かなくなる。だから「入った版が .terraform-version と一致するか」を
# ここで確かめる。一致しなければ落とす。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="${ROOT}/infra/terraform"
WANT="$(tr -d '[:space:]' < "${ROOT}/.terraform-version")"

if ! command -v terraform >/dev/null 2>&1; then
  echo "NG  terraform が見つからない（.terraform-version = ${WANT}。ローカルは tfenv install で入れる）" >&2
  exit 1
fi

HAVE="$(terraform version | head -n1 | sed -E 's/^Terraform v//')"
if [ "${HAVE}" != "${WANT}" ]; then
  echo "NG  terraform のバージョンが .terraform-version と一致しない（入っている: ${HAVE} / 期待: ${WANT}）" >&2
  exit 1
fi

case "${1:-}" in
  fmt)
    # -diff: 落ちたときに直すべき差分をそのまま出す（.tf に秘密は無い）
    if terraform fmt -check -recursive -diff "${TF_DIR}"; then
      echo "OK  terraform fmt（v${HAVE}）"
    else
      echo "NG  terraform fmt に差分がある。\`terraform fmt -recursive infra/terraform\` で直すこと" >&2
      exit 1
    fi
    ;;

  validate)
    ng=0
    for env_dir in "${TF_DIR}"/envs/*/; do
      name="$(basename "${env_dir}")"
      log="$(mktemp)"
      if ! ( cd "${env_dir}" \
             && TF_DATA_DIR=.terraform-validate terraform init -backend=false -input=false -lockfile=readonly -no-color >"${log}" 2>&1 ); then
        echo "NG  envs/${name}: init に失敗（-lockfile=readonly。lock に linux_amd64 / darwin_arm64 の hash があるか）" >&2
        grep -iE 'error|hash|checksum|lock' "${log}" | head -n 8 >&2 || true
        ng=$((ng + 1)); rm -f "${log}"; continue
      fi
      if ( cd "${env_dir}" && TF_DATA_DIR=.terraform-validate terraform validate -no-color >"${log}" 2>&1 ); then
        echo "OK  envs/${name}: validate"
      else
        echo "NG  envs/${name}: validate に失敗" >&2
        cat "${log}" >&2
        ng=$((ng + 1))
      fi
      rm -f "${log}"
    done
    [ "${ng}" -eq 0 ] || exit 1
    ;;

  *)
    echo "使い方: $0 fmt|validate" >&2
    exit 2
    ;;
esac
