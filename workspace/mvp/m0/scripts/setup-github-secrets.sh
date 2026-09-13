#!/usr/bin/env bash
# H-08: GitHub の Secrets / Variables を登録する。
# 値は端末→gh の標準入力へ直行し、AIの文脈にもシェル履歴にもコマンド引数にも残らない。
# 使い方（Claude Code なら先頭に ! を付けて自分の手で実行）:
#   ./workspace/mvp/m0/scripts/setup-github-secrets.sh
#
# ── 置き場所の規則（2026-09-14 決定・04 §3・§3.1・§7）─────────────────────────
#
#   | 名前                          | 置き場所              | 理由                                                   |
#   |-------------------------------|-----------------------|--------------------------------------------------------|
#   | CLOUDFLARE_API_TOKEN          | リポジトリ Secret     | dev/staging の CI デプロイ                              |
#   | TF_CLOUDFLARE_API_TOKEN       | リポジトリ Secret     | dev/staging の PR plan                                  |
#   | R2_ACCESS_KEY_ID / _SECRET_*  | リポジトリ Secret     | tfstate の backend（3環境とも①の R2）                  |
#   | CLOUDFLARE_ACCOUNT_ID         | リポジトリ **Secret** | Variable はログに平文で出る。Account ID は公開しない    |
#   | R2_S3_ENDPOINT                | リポジトリ **Secret** | URL に Account ID を含む                                |
#   | CLOUDFLARE_API_TOKEN_PROD     | **production 環境**   | v* タグ・Kewton 承認のジョブからだけ届くようにする       |
#   | CLOUDFLARE_ACCOUNT_ID_PROD    | **production 環境**   | 同上                                                    |
#   | TF_CLOUDFLARE_API_TOKEN_PROD  | **GitHub に置かない** | production への apply は人が立ち会って手元から（#4）    |
#   | TFSTATE_BUCKET                | リポジトリ Variable   | バケット名は backend.tf に書かれていて公開済み           |
#   | CLOUDFLARE_ZONE_ID            | リポジトリ Variable   | H-04（保留中）。未取得なら空でよい                       |
#
# ★ 本番の資格情報をリポジトリ全体の Secret にしないこと。pull_request のワークフローは
#   PR 側のブランチに書かれた定義で動くので、ワークフローを書き換えた PR から届いてしまう。
set -uo pipefail
REPO=${REPO:-Kewton/Musubi}

gh auth status >/dev/null 2>&1 || { echo "gh 未認証"; exit 1; }
echo "対象リポジトリ: $REPO"

# $1=名前 $2=説明 $3=環境名（空ならリポジトリ全体）
set_secret() {
  local v where
  where=${3:+"production 環境"}; where=${where:-"リポジトリ"}
  read -rsp "  $1 [$where]（$2。空Enterでスキップ）: " v; echo
  [ -z "$v" ] && { echo "    skip"; return; }
  if [ -n "${3:-}" ]; then
    printf '%s' "$v" | gh secret set "$1" --repo "$REPO" --env "$3" && echo "    set"
  else
    printf '%s' "$v" | gh secret set "$1" --repo "$REPO" && echo "    set"
  fi
}
set_var() { # $1=名前 $2=説明（公開してよい値だけ）
  local v
  read -rp "  $1 [Variable・ログに平文で出る]（$2。空Enterでスキップ）: " v
  [ -z "$v" ] && { echo "    skip"; return; }
  gh variable set "$1" --repo "$REPO" --body "$v" && echo "    set"
}

echo
echo "== リポジトリ Secret =="
set_secret CLOUDFLARE_API_TOKEN     "H-02 ② CI用・アカウント①"
set_secret TF_CLOUDFLARE_API_TOKEN  "H-02 ① Terraform用・アカウント①"
set_secret R2_ACCESS_KEY_ID         "H-03 tfstate用"
set_secret R2_SECRET_ACCESS_KEY     "H-03 tfstate用"
set_secret CLOUDFLARE_ACCOUNT_ID    "H-01 アカウント①の ID"
set_secret R2_S3_ENDPOINT           "https://<アカウント①の ID>.r2.cloudflarestorage.com"

echo
echo "== production 環境 Secret（v* タグ・承認済みのジョブからだけ届く）=="
set_secret CLOUDFLARE_API_TOKEN_PROD  "H-02 ② CI用・アカウント②" production
set_secret CLOUDFLARE_ACCOUNT_ID_PROD "H-01 アカウント②の ID"    production
echo "  TF_CLOUDFLARE_API_TOKEN_PROD は GitHub に登録しない（手元の .env にだけ置く）"

echo
echo "== Variable（公開してよい値だけ）=="
gh variable set TFSTATE_BUCKET --repo "$REPO" --body "musubi-tfstate" && echo "  TFSTATE_BUCKET = musubi-tfstate"
set_var CLOUDFLARE_ZONE_ID "H-04。保留中なら空Enter"

echo
echo "== 置いてはいけない場所に残っていないか =="
bad=0
for n in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID_PROD R2_S3_ENDPOINT; do
  gh variable list --repo "$REPO" | awk '{print $1}' | grep -qx "$n" && { echo "  NG Variable に $n がある（ログに平文で出る）"; bad=1; }
done
for n in CLOUDFLARE_API_TOKEN_PROD CLOUDFLARE_ACCOUNT_ID_PROD TF_CLOUDFLARE_API_TOKEN_PROD; do
  gh secret list --repo "$REPO" | awk '{print $1}' | grep -qx "$n" && { echo "  NG リポジトリ全体の Secret に $n がある（PR から届く）"; bad=1; }
done
[ "$bad" -eq 0 ] && echo "  OK"

echo
echo "== 登録済み一覧 =="
echo "-- リポジトリ Secret --";    gh secret list   --repo "$REPO"
echo "-- production 環境 Secret --"; gh secret list --repo "$REPO" --env production
echo "-- Variable --";             gh variable list --repo "$REPO"
