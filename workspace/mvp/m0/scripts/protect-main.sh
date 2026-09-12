#!/usr/bin/env bash
# H-07 の残り：main ブランチ保護。
# 空リポジトリには掛けられないため、01-repo-bootstrap.md の骨格を push した「直後」に実行する。
#
#   ./protect-main.sh                        # 既定: lint-typecheck-unit のみ必須
#   ./protect-main.sh lint-typecheck-unit terraform-plan   # 02 完了後はこちら
#
# ⚠️ 存在しないチェック名を contexts に入れないこと。
#    GitHub はそのチェックを「永久に pending」として扱い、PR が一切マージできなくなる。
#    terraform-plan は 02-terraform.md の成果物なので、それが入るまで足さない。
set -euo pipefail
REPO=${REPO:-Kewton/Musubi}
CONTEXTS=("$@")
[ ${#CONTEXTS[@]} -eq 0 ] && CONTEXTS=("lint-typecheck-unit")

gh api "repos/$REPO/branches/main" >/dev/null 2>&1 || {
  echo "main がまだ存在しない。最初のコミットを push してから実行すること。"; exit 1; }

CTX_JSON=$(printf '%s\n' "${CONTEXTS[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
echo "必須チェック: $CTX_JSON"

gh api -X PUT "repos/$REPO/branches/main/protection" \
  -H "Accept: application/vnd.github+json" --input - <<JSON
{
  "required_status_checks": { "strict": true, "contexts": $CTX_JSON },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true,
  "required_conversation_resolution": true
}
JSON

echo "適用結果:"
gh api "repos/$REPO/branches/main/protection" \
  --jq '{checks: .required_status_checks.contexts, linear: .required_linear_history.enabled, force_push: .allow_force_pushes.enabled, admins: .enforce_admins.enabled}'
