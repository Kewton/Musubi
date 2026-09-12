# 01：リポジトリ初期化 — monorepo骨格 ＋ GitHub Flow

> 対応DoD：**M0-1 ブランチ戦略＋Issueドリブン**
> プラン前提：Cloudflare Free（$0）→ [`06-plan-and-limits.md`](./06-plan-and-limits.md)
> 前提：🧑 H-06（可視性判断）が済んでいること。それ以外の人間タスクとは並走可。
> 担当：🤖（§5 のみ 🧑🤖）

---

## 1. ディレクトリ構成（企画書21章の構成に準拠）

企画書21章の構成を**そのまま採用**する。ここから逸脱しない。

```
Musubi/
├─ apps/                        # 外部から到達するWorker
│  ├─ host/                     #   PWA Host Shell（TanStack Start ＋ Vite・**SPAシェル配信**／→ 03 §2）
│  └─ gateway/                  #   Community Gateway（認証・AppGrant検査の入口）
├─ packages/                    # ライブラリ ＋ Service Binding経由でのみ到達する内部Worker
│  ├─ appspec-schema/           #   ★正本（entities由来の型の源泉）
│  ├─ control-plane/            #   Better Auth / User / Community / Membership / AppGrant
│  ├─ data-api/                 #   ★唯一の権限強制点（Worker）
│  ├─ spec-engine/              #   L2 Spec実行
│  ├─ app-do/                   #   Durable Object（SQLite＋WS）
│  ├─ connector/                #   EXT（M6まで空）
│  └─ sdk/                      #   @musubi/sdk — データ・通知への唯一の扉
├─ templates/
│  └─ tanstack-start/           # M1で中身。M0はREADMEのみ
├─ e2e/                         # Form A統合スモーク（M1）。M0は貫通スモークのみ
├─ infra/
│  ├─ terraform/                # アカウント単位資源（→ 02）
│  └─ scripts/                  # sync-bindings 等（→ 03）
├─ pins/
│  └─ commandagent.json         # 封緘artifactのピン（M1で使用・M0はプレースホルダ）
├─ docs/
│  └─ runbook/                  # rollback.md 等（→ 04）
├─ workspace/                   # 企画・計画ドキュメント（現状のまま）
├─ .github/
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ package.json
└─ CLAUDE.md
```

**`apps/` と `packages/` の線引き**（企画書9章「顔は軽く・力は本体に」の物理的表現）
- `apps/*` … インターネットから直接到達するWorker（host, gateway）
- `packages/*` … **Service Binding 経由でしか到達できない**内部Worker（data-api）と、純粋なライブラリ
- `data-api` が `packages/` にあるのは意図的。**外部ルートを持たせない**という規律をディレクトリで表現する

---

## 2. ツールチェーンの固定

```bash
# Node（.node-version / .nvmrc でピン）
node -v            # v24.1.0 を確認
echo "24.1.0" > .node-version

# pnpm（package.json の packageManager で固定 → corepack が従う）
corepack enable
pnpm -v            # 10.13.1

# Terraform（tfenv でピン）
brew install tfenv
tfenv install 1.13.0    # ※着手時の最新安定版に読み替え、.terraform-version に固定
tfenv use 1.13.0
echo "1.13.0" > .terraform-version
```

> **wrangler はグローバルに入れない。** monorepo の devDependency として入れ、`pnpm exec wrangler` で叩く。CIとローカルでバージョンが割れるのを防ぐ（企画書11章「本番同一エンジン workerd で9割をローカル再現」の前提）。

---

## 3. monorepo の初期化

### 3.1 ルート設定ファイル

```bash
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - "apps/*"
  - "packages/*"
  - "templates/*"
  - "e2e"
EOF
```

```jsonc
// package.json（ルート）
{
  "name": "musubi",
  "private": true,
  "packageManager": "pnpm@10.13.1",
  "engines": { "node": ">=24" },
  "scripts": {
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "build": "turbo run build",
    "check": "pnpm lint && pnpm typecheck && pnpm test",

    "infra:sync": "tsx infra/scripts/sync-bindings.ts",
    "deploy:dev": "turbo run deploy --filter=./apps/* --filter=./packages/data-api -- --env dev",
    "deploy:staging": "turbo run deploy --filter=./apps/* --filter=./packages/data-api -- --env staging",
    "deploy:production": "turbo run deploy --filter=./apps/* --filter=./packages/data-api -- --env production",
    "smoke": "tsx infra/scripts/smoke.ts"
  },
  "devDependencies": {
    "turbo": "^2",
    "typescript": "^5.7",
    "wrangler": "^4",
    "@cloudflare/workers-types": "^4",
    "vitest": "^3",
    "@cloudflare/vitest-pool-workers": "^0.8",
    "oxlint": "^1",
    "prettier": "^3",
    "tsx": "^4"
  }
}
```

> **バージョンは着手時点の最新安定版に読み替えること。** `^` の実解決は `pnpm-lock.yaml` で固定される（企画書13章「依存はlockfile固定＋許可リスト」）。

```jsonc
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".output/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      {},
    "test":      { "dependsOn": ["^build"] },
    "deploy":    { "dependsOn": ["build"], "cache": false }
  }
}
```

```jsonc
// tsconfig.base.json —— 「entities由来の型を端から端まで通す」（企画書9章）の土台
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "types": ["@cloudflare/workers-types"]
  }
}
```

> `composite: true` ＋ **project references** にすることで、`appspec-schema` の型変更が SDK / spec-engine / data-api / app-do に**typecheckで即伝播する**。企画書12章の「typecheckがverifierの検出力を上げる」を、プラットフォーム側でも効かせる。

### 3.2 パッケージの雛形生成

各パッケージに最小の `package.json` / `tsconfig.json` / `src/index.ts` を置く。**M0では中身は空でよい**が、**依存の向きだけは正しく張る**。

```
appspec-schema  ←  sdk  ←  data-api  ←  gateway  ←  host
       ↑                      ↑
   spec-engine            app-do
       ↑
  control-plane
```

**禁止する依存（M0時点でlintルール化）**
- `gateway` → `app-do` / D1 / R2 の直接参照（**data-api を必ず経由**）
- `host` → `data-api` 以下への直接参照
- `packages/*` から `cloudflare:workers` の直接import（**`app-do` のみ例外**）

`eslint`/`oxlint` の `no-restricted-imports` で機械強制する。企画書13章の二層化に倣い、これは **Capabilities（build時強制）** 側に置く。

---

## 4. Git / コミット規約

```bash
git checkout -b main 2>/dev/null || git switch main
git add -A && git commit -m "chore: bootstrap musubi monorepo skeleton"
git push -u origin main
```

- **GitHub Flow**：`main` 保護／`feat/<issue番号>-<slug>` ブランチ／**squash merge のみ**
- **Conventional Commits**：`feat:` `fix:` `chore:` `docs:` `ci:` `refactor:` `test:`
  - PRタイトルに強制（`.github/workflows/ci.yml` に PRタイトル検査を1ジョブ追加）
- squash merge のコミットメッセージ = PRタイトル になるよう設定（§5）

`.gitignore`（要点）

```
node_modules/
.turbo/
dist/
.output/
.wrangler/
.dev.vars
*.tfstate
*.tfstate.*
.terraform/
```

> **`.terraform.lock.hcl` は ignore せずコミットする**（provider の SHA 固定＝企画書21章の「封緘ピン」思想と同じ）。CIとローカルで provider のハッシュが割れるのを防ぐ。

---

## 5. 🧑🤖 GitHub リポジトリ設定（AI代行実行可・内容は人間が承認）

```bash
REPO=Kewton/Musubi

# --- マージ方式：squash のみ ---
gh api -X PATCH repos/$REPO \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY

# --- main ブランチ保護 ---
gh api -X PUT repos/$REPO/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint-typecheck-unit", "terraform-plan"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true,
  "required_conversation_resolution": true
}
JSON

# --- Environments ---
# staging: 承認なし・自動デプロイ
gh api -X PUT repos/$REPO/environments/staging

# production: あなたの承認必須
gh api -X PUT repos/$REPO/environments/production --input - <<'JSON'
{
  "wait_timer": 0,
  "reviewers": [{ "type": "User", "id": null }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
# ↑ reviewers の id は `gh api user --jq .id` の値に置換すること
gh api repos/$REPO/environments/production/deployment-branch-policies -X POST -f name='v*' -f type=tag

# --- Milestone ---
for M in M0 M1 M2 M3; do
  gh api -X POST repos/$REPO/milestones -f title="$M" >/dev/null 2>&1 || true
done

# --- Label ---
gh label create "area:infra"    --color 0E8A16 --repo $REPO
gh label create "area:platform" --color 1D76DB --repo $REPO
gh label create "area:ci"       --color 5319E7 --repo $REPO
gh label create "human-only"    --color D93F0B --description "🧑 人間にしかできない作業" --repo $REPO
gh label create "blocked"       --color B60205 --repo $REPO
```

> **`required_approving_review_count: 0`** … 現在は1人開発のため。人が増えたら1に上げる。ただし **status checks は必須のまま**にすること（機械の検問は外さない＝企画書13章「信頼は書き手でなく検収に置く」）。
> **`enforce_admins: false`** … 緊急時のhotfix経路を残す。使ったら必ずIssueに理由を残す運用にする。

---

## 6. Issue テンプレート ＋ PR テンプレート

```
.github/ISSUE_TEMPLATE/task.yml     # Milestone必須・DoD必須・担当区分（🧑/🧑🤖/🤖）必須
.github/ISSUE_TEMPLATE/bug.yml
.github/ISSUE_TEMPLATE/config.yml   # blank_issues_enabled: false
.github/pull_request_template.md    # Closes #N / DoD確認 / 影響環境 / ロールバック手順
```

`task.yml` に**必ず入れる項目**（Issueドリブンを形骸化させないため）

| 項目 | 理由 |
|---|---|
| Milestone（M0〜M7） | 企画書21章「全IssueをMilestoneに紐付け」 |
| **DoD（完了条件）** | ゲート駆動の最小単位。曖昧なIssueを起票させない |
| **担当区分**（🧑 / 🧑🤖 / 🤖） | 人間待ちのタスクが埋もれるのを防ぐ |
| 依存Issue | クリティカルパスを可視化 |

---

## 7. CLAUDE.md（AIエージェント向けの規律）

**M0で必ず書く。** 以後のAI作業がこれを読む。

```markdown
# Musubi monorepo — 作業規律

## 不変条件（破ったらPRを落とす）
- Data API が唯一の権限強制点。gateway/host から D1・R2・DO を直接触らない
- D1 は Control Plane 専用。アプリのデータは Durable Object（SQLite）
- IaC二層：アカウント単位資源は infra/terraform、サービス単位は wrangler.jsonc。越境しない
- リクエスト経路は TypeScript のみ
- Cloudflare 固有APIは adapter 層に閉じ込める（app-do を除く）
- Builder Plane（CommandAgent）のコードをこのリポジトリに持ち込まない。接点は headless契約 と pins/ のみ
- **Cloudflare Free 前提（M0〜M2前半）**：host は SSR にしない（CPU 10ms／SPAシェル＋Static Assets）。
  Workers for Platforms を使わない。Logpush を使わない（observability.enabled で代替）。
  `schedule:` トリガのワークフローを作らない。
  ただし**アーキテクチャを課金プランに売らない**——枠が足りなければ層を潰すのではなく $5 払う

## 手順
- 作業は必ず Issue から。ブランチは feat/<issue番号>-<slug>
- コミットは Conventional Commits
- 出典を示すとき：企画書は章番号だけで参照する（本体は非公開リポジトリ Kewton/Musubi-workspace の proposal/。本リポジトリは public なので内容を引き写さない）
```

---

## 8. 完了条件（このステップのDoD）

- [ ] `pnpm install && pnpm check` がローカルで green（空パッケージでも通る）
- [ ] `main` が保護され、直接pushが拒否されることを実際に確認した
- [ ] Milestone `M0`〜`M3` が存在し、`issues.md` のIssueが `M0` に紐づいて起票済み
- [ ] Issue/PR テンプレートが動作する（新規Issue画面で選択肢が出る）
- [ ] `CLAUDE.md` がコミット済み
- [ ] 🧑 H-06 の可視性判断が反映済み
