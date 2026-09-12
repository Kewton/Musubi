#!/usr/bin/env bash
# H-07 の残り：main ブランチ保護。
# 空リポジトリには掛けられないため、01-repo-bootstrap.md の骨格を push した「直後」に1回実行する。
set -euo pipefail
REPO=${REPO:-Kewton/Musubi}

gh api "repos/$REPO/branches/main" >/dev/null 2>&1 || {
  echo "main がまだ存在しない。最初のコミットを push してから実行すること。"; exit 1; }

gh api -X PUT "repos/$REPO/branches/main/protection" \
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["lint-typecheck-unit", "terraform-plan"] },
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
