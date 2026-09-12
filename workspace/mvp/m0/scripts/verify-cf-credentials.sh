#!/usr/bin/env bash
# H-02 / H-03 の発行直後検証を1発で回す。
# 使い方:  ./verify-cf-credentials.sh
# トークンは画面に表示されず、AIの文脈にも入らない（このスクリプトは値を出力しない）。
set -uo pipefail

command -v jq >/dev/null || { echo "jq が必要です"; exit 1; }

read -rp "CLOUDFLARE_ACCOUNT_ID: " ACCOUNT_ID
read -rsp "API TOKEN (入力は非表示): " TOKEN; echo

api() { curl -s "https://api.cloudflare.com/client/v4/$1" -H "Authorization: Bearer $TOKEN"; }

pass=0; fail=0
check() { # $1=ラベル $2=パス $3=必須か(req/opt)
  local out ok
  out=$(api "$2")
  ok=$(printf '%s' "$out" | jq -r '.success' 2>/dev/null)
  if [ "$ok" = "true" ]; then
    printf '  \033[32mOK\033[0m   %s\n' "$1"; pass=$((pass+1))
  else
    if [ "$3" = "req" ]; then printf '  \033[31mNG\033[0m   %s  -> %s\n' "$1" "$(printf '%s' "$out" | jq -c '.errors' 2>/dev/null)"; fail=$((fail+1));
    else printf '  \033[33m--\033[0m   %s (任意)\n' "$1"; fi
  fi
}

echo
echo "== トークン自体 =="
status=$(api "user/tokens/verify" | jq -r '.result.status // "invalid"')
[ "$status" = "active" ] && printf '  \033[32mOK\033[0m   token status = active\n' \
  || { printf '  \033[31mNG\033[0m   token status = %s\n' "$status"; exit 1; }

echo
echo "== アカウントの参照疎通（GETのみ。Edit権限の証明ではありません） =="
check "Account Settings: Read" "accounts/$ACCOUNT_ID"            req
check "D1 一覧の参照"          "accounts/$ACCOUNT_ID/d1/database" req
check "R2 バケット一覧の参照"   "accounts/$ACCOUNT_ID/r2/buckets"  req
check "Workers Scripts 一覧の参照" "accounts/$ACCOUNT_ID/workers/scripts" req
check "Workers KV 一覧の参照"   "accounts/$ACCOUNT_ID/storage/kv/namespaces" req
check "Queues 一覧の参照"      "accounts/$ACCOUNT_ID/queues"      opt
check "Turnstile 一覧の参照"   "accounts/$ACCOUNT_ID/challenges/widgets" opt

echo
echo "== 結果 =="
if [ "$fail" -gt 0 ]; then
  echo "  必須の参照疎通が $fail 件失敗。権限・対象アカウント・R2契約状態・接続状態を確認してください。"
  exit 1
fi
echo "  必須の参照疎通はすべて通過（任意項目の -- は用途次第）。"
echo "  Edit権限は発行時の権限一覧と実際の適用時に別途確認してください。"
