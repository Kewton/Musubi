#!/usr/bin/env bash
# git worktree に .env を引き継ぐ。
#
#   ./infra/scripts/link-env.sh
#
# なぜ要るか：
#   git worktree は **tracked なファイルしか複製しない**。.env は（当然ながら）
#   追跡していないので、worktree には存在しない。そのままでは Terraform も
#   verify-cf-tokens.py も動かない。
#
# なぜコピーではなく symlink か：
#   トークンは 2026-12-07 に失効する。コピーにすると worktree の数だけ更新箇所が増え、
#   「片方だけ古い」が起きる。symlink なら primary の .env を1回直せば全部に効く。
#
# 安全のため：
#   - 既に .env がある場合は何もしない（上書きしない）
#   - primary checkout 自身では何もしない
#   - .env が .gitignore で除外されていることを確認してから張る
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
HERE=$(pwd -P)

# worktree でも primary でも、共通の .git ディレクトリからprimary checkout を割り出す
COMMON_DIR=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
PRIMARY=$(dirname "${COMMON_DIR}")

if [ "${HERE}" = "${PRIMARY}" ]; then
  echo "ここは primary checkout（${HERE}）。何もしない。"
  exit 0
fi

if [ -e .env ] || [ -L .env ]; then
  echo ".env は既にある。上書きしない：${HERE}/.env"
  exit 0
fi

if [ ! -f "${PRIMARY}/.env" ]; then
  echo "primary に .env が無い：${PRIMARY}/.env" >&2
  echo "先に primary 側で .env を用意すること（中身は 00-human-tasks.md H-08 の表）。" >&2
  exit 1
fi

# 追跡対象になっていたら symlink を張らない（public リポジトリに秘密が入る事故を防ぐ）
if ! git check-ignore -q .env; then
  echo ".env が .gitignore で除外されていない。張る前に .gitignore を直すこと。" >&2
  exit 1
fi

ln -s "${PRIMARY}/.env" .env
echo "リンクした: ${HERE}/.env -> ${PRIMARY}/.env"

# 値は表示せず、鍵の名前が揃っているかだけ確認する
missing=0
for k in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID_PROD \
         TF_CLOUDFLARE_API_TOKEN CLOUDFLARE_API_TOKEN \
         TF_CLOUDFLARE_API_TOKEN_PROD CLOUDFLARE_API_TOKEN_PROD \
         R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY TFSTATE_BUCKET R2_S3_ENDPOINT; do
  grep -q "^${k}=" .env || { echo "  不足: $k" >&2; missing=$((missing + 1)); }
done
[ "$missing" -eq 0 ] && echo "必要な10件のキーが揃っている（値は確認していない）" || exit 1
