#!/usr/bin/env bash
# H-08: GitHub Secrets / Variables を対話で登録する。
# 値は端末→gh へ直行し、AIの文脈にもシェル履歴にも残らない。
# 使い方（Claude Code なら先頭に ! を付けて自分の手で実行）:
#   ./workspace/mvp/m0/scripts/setup-github-secrets.sh
set -uo pipefail
REPO=${REPO:-Kewton/Musubi}

gh auth status >/dev/null 2>&1 || { echo "gh 未認証"; exit 1; }
echo "対象リポジトリ: $REPO"
read -rp "H-14 でアカウントを分けた？ (Y/n) [2026-09-12 決定=案A なので既定 Y]: " SPLIT; SPLIT=${SPLIT:-Y}
SPLIT_LC=$(printf %s "$SPLIT" | tr "[:upper:]" "[:lower:]")

set_secret() { # $1=name $2=説明
  local v
  read -rsp "  $1 ($2、空Enterでスキップ): " v; echo
  [ -z "$v" ] && { echo "    skip"; return; }
  printf '%s' "$v" | gh secret set "$1" --repo "$REPO" && echo "    set"
}
set_var() { # $1=name $2=説明
  local v
  read -rp "  $1 ($2、空Enterでスキップ): " v
  [ -z "$v" ] && { echo "    skip"; return; }
  gh variable set "$1" --repo "$REPO" --body "$v" && echo "    set"
}

echo
echo "== Secrets =="
set_secret CLOUDFLARE_API_TOKEN     "H-02 ② CI用"
set_secret TF_CLOUDFLARE_API_TOKEN  "H-02 ① Terraform用"
set_secret R2_ACCESS_KEY_ID         "H-03 tfstate用"
set_secret R2_SECRET_ACCESS_KEY     "H-03 tfstate用"
if [ "$SPLIT_LC" = "y" ]; then
  set_secret CLOUDFLARE_API_TOKEN_PROD    "H-02 ② production用"
  set_secret TF_CLOUDFLARE_API_TOKEN_PROD "H-02 ① production用"
fi

echo
echo "== Variables =="
set_var CLOUDFLARE_ACCOUNT_ID "H-01 dev/staging 用"
if [ "$SPLIT_LC" = "y" ]; then
  set_var CLOUDFLARE_ACCOUNT_ID_PROD "H-01 production 用"
else
  A=$(gh variable get CLOUDFLARE_ACCOUNT_ID --repo "$REPO" 2>/dev/null)
  [ -n "$A" ] && gh variable set CLOUDFLARE_ACCOUNT_ID_PROD --repo "$REPO" --body "$A" && echo "  CLOUDFLARE_ACCOUNT_ID_PROD = 同値でコピー"
fi
set_var CLOUDFLARE_ZONE_ID "H-04、未取得なら空Enter"
gh variable set TFSTATE_BUCKET --repo "$REPO" --body "musubi-tfstate" && echo "  TFSTATE_BUCKET = musubi-tfstate"
A=$(gh variable get CLOUDFLARE_ACCOUNT_ID --repo "$REPO" 2>/dev/null)
[ -n "$A" ] && gh variable set R2_S3_ENDPOINT --repo "$REPO" --body "https://$A.r2.cloudflarestorage.com" && echo "  R2_S3_ENDPOINT = 自動生成"

echo
echo "== 登録済み一覧 =="
gh secret list --repo "$REPO"
gh variable list --repo "$REPO"
