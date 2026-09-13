# M0 進捗チェックリスト（一枚もの）

凡例：🧑 人間のみ ／ 🧑🤖 人間の権限・承認が必要 ／ 🤖 AI単独可

---

> **費用目標：Workers Free＋R2無料枠内で $0。** R2 は利用申込みと超過時課金の判断が必要。→ [`06-plan-and-limits.md`](./06-plan-and-limits.md)。今回の実測は [`00e-execution-status.md`](./00e-execution-status.md)。

## Day 1：🧑 人間タスク（ここが律速。まとめて片付ける／正味 約1.5時間）

- [x] 🧑 **H-14 決定済（2026-09-12）**：**案A**＝①dev+staging（既存アカウント）／②production（新規作成）
      — 後続の H-01/H-02/H-08 の作る数が変わる。**prodを後から分離するとデータ移行になる**
- [x] 🧑 H-01 **完了（2026-09-12）**：2FA有効化・アカウント②作成・Account ID 2つを登録
- [ ] 🧑 H-02 APIトークン発行 — **テンプレート「Edit Cloudflare Workers」を土台に**（1本2〜3分）
      — ① Terraform用：テンプレ ＋ `D1` `Queues` `Turnstile`（＋H-04後に Zone `DNS: Edit`）
      — ② CI用：テンプレ ＋ `D1` のみ。**`DNS: Edit` は絶対に足さない**
      — **`Workers for Platforms: Edit` は不要**（有償・M5〜M6へ延期）
      — Account Resources を**対象アカウント1つに限定**・**TTL 90日**・発行直後に `curl .../tokens/verify` で検証
      — **合計4本**（`musubi-tf-dev` / `musubi-ci-dev` / `musubi-tf-prod` / `musubi-ci-prod`）
- [ ] 🤖 ローカルは `wrangler login`（OAuth）でトークン不要にする
- [ ] 🧑🤖 H-03 R2利用申込み判断・`musubi-tfstate` 作成＋S3キー発行 ※アカウント①に1つ。R2バージョニングは未対応のため、state別キー退避・復元検証を `02` で実装する
      — **2026-09-08：R2契約・バケット・期限付きキー発行・S3疎通は完了**。残りはstateバックアップ・復元検証
- [ ] 🧑 H-06 **リポジトリ可視性の判断**（現状 PUBLIC・空）— 決まるまで企画書をpushしない
- [ ] 🧑 H-08 GitHub Secrets / Variables 登録（`!` プレフィックスで自分の手で打つ）
      — **R2 Secrets 2件・Variables 3件はAI代行で登録済み**。残りはH-02トークン・production向け設定
- [x] 🧑 H-13 **完了（2026-09-12）**：$0 宣言・昇格トリガー8件承認・即決者=本人・週次確認は毎週月曜
- [ ] 🧑 H-05 商標クリアランス（9類・42類）の調査を**発注**（結果待ちは並走）
- [ ] 🧑 H-04 ドメイン取得＋ゾーン委任（H-05次第。未定なら `custom_domain_enabled=false` で先へ）

**未承認のまま行わないこと**：Workers Paid への加入／WfP の有効化／R2契約の確定／支払い手段の新規登録

## 先行取得（M0のブロッカーではないが、M0期間中に済ませる）

- [ ] 🧑 H-10 LINE Developers アカウント＋dev用 Login チャネル
- [ ] 🧑 H-11 Google Cloud プロジェクト＋OAuth同意画面・devクライアント
- [ ] 🧑 H-12 CommandAgent 接点・ピン対象（schema版・テンプレSHA・headless契約版）の確定
- [ ] 🧑 ~~H-09 WfP有効化~~ → **M5〜M6へ延期。M0では「要らないこと」を確定させるだけ**

---

## M0-1：ブランチ戦略＋Issueドリブン（`01`）

- [ ] 🤖 monorepo骨格（`apps/` `packages/` `templates/` `e2e/` `infra/` `pins/` `docs/`）
- [ ] 🤖 pnpm workspace / turbo / tsconfig **project references**
- [ ] 🤖 ツールチェーン固定（`.node-version` / `packageManager` / `.terraform-version`）
- [ ] 🤖 越境import禁止 lint（gateway→D1/R2/DO、host→data-api、`cloudflare:workers` は app-do のみ）
- [ ] 🤖 `.gitignore`（**`.terraform.lock.hcl` はコミットする**）
- [ ] 🧑🤖 H-07 main保護（PR必須・squashのみ・linear history・required checks）
- [ ] 🧑🤖 Environments：`staging`（自動）／`production`（**あなたの承認必須**）
- [ ] 🤖 Milestone `M0`〜`M3` ／ Label（`area:*` `human-only` `blocked`）
- [ ] 🤖 Issue / PR テンプレート（Milestone・DoD・**担当区分**の欄を必須に）
- [ ] 🤖 `CLAUDE.md`（不変条件7項目）
- [ ] 🤖 `issues.md` の33件を起票

## M0-3a：Terraform（`02`）— **Issue #1**

- [ ] 🤖 tfenv導入・バージョン固定
- [ ] 🤖 backend（R2 / S3互換）で `terraform init` が通る
- [ ] 🤖 provider を v5系にピン＋`.terraform.lock.hcl` コミット
- [ ] 🤖 **リソース名・属性名を固定バージョンの公式ドキュメントで照合**（v4→v5で大改名あり）
- [ ] 🤖 モジュール `musubi-env`：D1 / R2×2 / Queue /（WfP＝`count=0` 固定）/（Turnstile）/（DNS）
- [ ] 🤖 **Logpush リソースを作らない**（有償）。観測は wrangler の `observability.enabled`
- [ ] 🤖 **H-14=A 確定**：`envs/production` の `account_id` をアカウント②に（backend はアカウント①のまま）
- [ ] 🤖 `outputs.bindings` を定義（`infra:sync` の入力契約）
- [ ] 🤖 `envs/dev` apply 成功
- [ ] 🤖 **destroy → apply の往復成功（Issue #1 クローズ）**
- [ ] 🤖 R2 空化 pre-hook（`infra:empty-buckets`）
- [ ] 🧑🤖 `envs/staging` / `envs/production` apply（人間承認）
- [ ] 🤖 3環境すべて `terraform plan` が **No changes**
- [ ] 🤖 `infra/terraform/README.md`（二層の境界表）

## M0-3b / M0-4：Workers ＋ Service Bindings（`03`）

- [ ] 🤖 `infra:sync`（terraform output → wrangler.jsonc の ID 同期・**冪等**）
- [ ] 🤖 `packages/app-do`：`AppInstanceDO` ＋ **`new_sqlite_classes`** migration
- [ ] 🤖 `packages/data-api`：D1 / R2 / DO バインド・`/healthz`・**外部ルートなし**
- [ ] 🤖 `apps/gateway`：SB → data-api・**D1/R2/DO を持たない**
- [ ] 🤖 `apps/host`：**SPAシェル（Static Assets）＋薄いWorker**・SB → gateway
      — SSRにしない（CPU 10ms／静的配信は無償枠を消費しない）
- [ ] 🤖 `pnpm smoke`：host→gateway→data-api→{D1,R2,DO} が全 `ok`
- [ ] 🤖 production の `/healthz` は構成情報を返さない
- [ ] 🤖 スモークに **CPU時間・チェーン合計の記録**を入れる（`06` 要確認 #1 を潰す）
- [ ] 🤖 `wrangler dev` マルチワーカー起動の確定手順 → `docs/runbook/local-dev.md`
- [ ] 🤖 D1 migration 機構 → `docs/runbook/d1-migration.md`（**前方互換のみ・2段階リリース**）
- [ ] 🤖 `pins/commandagent.json` プレースホルダ

## M0-2：CI/CD（`04`）

- [ ] 🤖 `ci.yml`：lint / typecheck / unit / PRタイトル（≤5分）。**infra:sync の乖離チェックはデプロイ直前に置く**（2026-09-13 決定・`03` §3）
- [ ] 🤖 `infra-plan.yml`：3環境の `terraform plan` をPRコメント（**apply は自動化しない**）
- [ ] 🤖 `deploy-staging.yml`：main → D1 migration → **data-api→gateway→host の順** → smoke（≤10分）
- [ ] 🧑🤖 `deploy-production.yml`：tag `v*` → **承認** → deploy → smoke
- [ ] 🧑🤖 `rollback.yml` ＋ `docs/runbook/rollback.md`（コード／D1／Terraform）
- [ ] 🧑🤖 **ロールバックを1回実演し、記録を残す**
- [ ] 🤖 CIトークンの権限が最小（DNS・アカウント資源の作成権限を持たない）
- [ ] 🤖 **`schedule:` トリガのワークフローを1つも作らない**（無償枠の消費源）
- [ ] 🤖 全 wrangler.jsonc に `observability: { enabled: true }`（Logpush の代替）

## 受入（`05`）

- [ ] 🤖 試験A：dev destroy→apply→sync→deploy→smoke（**≤15分・手作業0回**）
- [ ] 🤖 試験B：Service Bindings 結線＋**越境importでCIが落ちること**を実証
- [ ] 🧑🤖 試験C：CI/CD 一周（C-1〜C-9）
- [ ] 🤖 試験D：Issueドリブン運用の確認
- [ ] 🤖 試験E：ドキュメント6点の実在確認
- [ ] 🤖 **試験F：無償枠の実測**（CPU独立/合算・SBのリクエストカウント・静的アセット・課金 $0）
- [ ] 🧑 **清算表を記入**（宣言 vs 実測・未達の処置・帰属分析）
- [ ] 🧑 Milestone `M0` を close ／ `v0.1.0` を production へ
- [ ] 🧑 **M1のゲートを事前宣言**（「封緘済みgolden割り勘が staging のスマホで動く」の判定方法・判定者・期限）

---

## 「要確認」項目（closeする前に一次情報で確定させる）

| # | 項目 | 手順書 | 優先 |
|---|---|---|---|
| 1 | **Service Bindings で CPU時間は各Worker独立か合算か** | `06` §7 / `03` §5 / `05` F-1 | ★最優先 |
| 2 | **SB 呼び出しが課金リクエストとして別カウントされるか**（実効予算が 100k か 33k か） | `06` §7 / `05` F-3 | ★最優先 |
| 3 | ~~1ログインで複数 Cloudflare アカウントを持てるか~~ **✅ 2026-09-12 実測で可（「＋ Create Account」あり）。エイリアスメール不要** | `00` H-14 | 完了 |
| 4 | Static Assets へのリクエストが 100k/日 を消費しないこと | `06` §7 / `05` F-4 | 高 |
| 5 | Cloudflare Terraform provider v5 のリソース名・属性名（v4から大改名あり） | `02` §4 | 高 |
| 6 | TanStack Start × `@cloudflare/vite-plugin` の**SPAモード**出力パス／`assets` 統合 | `03` §2 | 高 |
| 7 | R2 backend での `skip_s3_checksum` 等の動作（Terraform版依存） | `02` §3 | 中 |
| 8 | `wrangler dev` マルチワーカー同時起動の指定方法（版依存） | `03` §6 | 中 |
| 9 | `wrangler rollback` の挙動（一次ロールバック手段にできるか） | `04` §6.1 | 中 |
| 10 | Free の subrequest 上限と本構成の消費数 | `06` §7 / `05` F-5 | 中 |
| 11 | Workers Logs の無償保持期間 | `06` §7 / `05` F-6 | 中 |
| 12 | Queues の Free 提供条件（2026-02 追加の現行仕様） | `06` §7 | 低（M1） |
| 13 | Free で Workers Custom Domain / Routes が使えるか | `06` §7 | 低（M1） |
| 14 | 課金額が実際に $0 であること（初月） | `05` F-7 | 清算時 |
