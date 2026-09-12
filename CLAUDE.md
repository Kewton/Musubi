# Musubi monorepo — 作業規律

## 不変条件（破ったらPRを落とす）

- **Data API が唯一の権限強制点。** gateway / host から D1・R2・DO を直接触らない
- **D1 は Control Plane 専用。** アプリのデータは Durable Object（SQLite）
- **IaC二層**：アカウント単位資源は `infra/terraform`、サービス単位は `wrangler.jsonc`。越境しない
- リクエスト経路は **TypeScript のみ**
- Cloudflare 固有APIは adapter 層に閉じ込める（`packages/app-do` を除く）
- Builder Plane（CommandAgent）のコードをこのリポジトリに持ち込まない。接点は headless契約 と `pins/` のみ
- **Cloudflare Free 前提（M0〜M2前半）**：host は SSR にしない（CPU 10ms ／ SPAシェル＋Static Assets）。
  Workers for Platforms を使わない。Logpush を使わない（`observability.enabled` で代替）。
  `schedule:` トリガのワークフローを作らない。
  ただし **アーキテクチャを課金プランに売らない** — 枠が足りなければ層を潰すのではなく $5 払う
  （昇格トリガーは `workspace/mvp/m0/06-plan-and-limits.md` §5。触れたら議論せず即上げる）

## 依存の向き

`infra/scripts/dep-graph.mjs` が正本。`pnpm lint` が package.json と tsconfig references の
両方を照合して機械強制する。**図を変えるときは dep-graph.mjs を直す。**

```
appspec-schema ← sdk ← data-api ← gateway ← host
       ↑                  ↑
   spec-engine         app-do
       ↑
  control-plane
```

- `apps/*` … インターネットから直接到達する Worker（host, gateway）
- `packages/*` … **Service Binding 経由でしか到達できない**内部 Worker（data-api）と純粋なライブラリ
- `data-api` が `packages/` にあるのは意図的。**外部ルートを持たせない**規律をディレクトリで表現している

## このリポジトリは public である

- 公開しない文書（企画書・商標・名称検討）は **非公開リポジトリ `Kewton/Musubi-workspace`** にある
- 出典を示すとき：企画書は**章番号だけ**で参照する。**内容を引き写さない**
- 商標の結論（リスク評価・先行権利者名）、価格、moat 仮説、名称の代替候補を**ここに書かない**
- **CIログ・PRコメント・アーティファクトもすべて公開される。** Variables はマスクされない
  （`terraform plan` の扱いは `workspace/mvp/m0/04-cicd.md` §3.1）

## 手順

- 作業は必ず Issue から。ブランチは `feat/<issue番号>-<slug>`
- コミットは **Conventional Commits**（`feat:` `fix:` `chore:` `docs:` `ci:` `refactor:` `test:`）
- PR は **squash merge のみ**。squash のコミットメッセージ = PRタイトル
- `main` は保護。直接 push しない。緊急時の管理者バイパスは可能だが、**使ったら Issue に理由を残す**

## コマンド

```bash
pnpm install          # corepack 経由で pnpm 10.13.1 が使われる
pnpm check            # lint → typecheck → test（PR前に必ず通す）
pnpm build
```
