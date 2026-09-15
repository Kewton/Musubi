# MUSUNEST monorepo — 作業規律

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

- 公開しない文書（企画書・商標・名称検討）は **非公開リポジトリ `Kewton/Musunest-workspace`** にある
- 出典を示すとき：企画書は**章番号だけ**で参照する。**内容を引き写さない**
- 商標の結論（リスク評価・先行権利者名）、価格、moat 仮説、名称の代替候補を**ここに書かない**
- **CIログ・PRコメント・アーティファクトもすべて公開される。** Variables はマスクされない
  （`terraform plan` の扱いは `workspace/mvp/m0/04-cicd.md` §3.1）

### 資格情報の置き場所（2026-09-14）

| 置き場所 | 置くもの |
|---|---|
| リポジトリ Secret | dev/staging のトークン、R2 の鍵、**`CLOUDFLARE_ACCOUNT_ID`**、**`R2_S3_ENDPOINT`** |
| **`production` 環境 Secret** | **`CLOUDFLARE_API_TOKEN_PROD`**、**`CLOUDFLARE_ACCOUNT_ID_PROD`**、**`SMOKE_BASE_URL`**（production の host の workers.dev のオリジン）、**`MUSUNEST_PROBE_TOKEN`**（production の `/healthz` の合言葉。32 文字以上） |
| **`staging` 環境 Secret** | **`SMOKE_BASE_URL`**（staging の host の workers.dev のオリジン。`deploy-staging` の貫通スモークの宛先） |
| GitHub に置かない | `TF_CLOUDFLARE_API_TOKEN_PROD`（production への apply は人が手元から） |
| リポジトリ Variable | 公開してよい値だけ（`TFSTATE_BUCKET` など） |

- **Account ID と、それを含む値（R2 のエンドポイント URL）を Variable にしない。** ログに平文で出る
- **本番の資格情報をリポジトリ全体の Secret にしない。** `pull_request` のワークフローは PR 側のブランチの定義で
  動くので、ワークフローを書き換えた PR から届いてしまう。`production` 環境（`v*` タグ・承認必須）に閉じ込める
- **PR で production の plan を回さない**（`04` §3）
- **workers.dev の URL を Variable にも CI のコマンド行にも出さない。** サブドメインがログに載る。貫通スモークの宛先は Secret から環境変数で渡し
  （`--base-url` を使わない）、`wrangler deploy` の出力は `infra/scripts/deploy-worker.ts` を通してホスト名を伏せる（`04` §4）
- **`MUSUNEST_PROBE_TOKEN` は `production` 環境の Secret の1か所だけに置く。** `deploy-production` が deploy のたびに
  `--secrets-file` で host と gateway に載せ（`deploy-worker.ts` が一時ファイルに書いてすぐ消す）、貫通スモークには `SMOKE_PROBE_TOKEN` として渡す。
  **手で `wrangler secret put` をしない**（`04` §5）
- **`production` 環境を宣言するのは `deploy-production.yml` だけ。** 他のワークフローに本番の Secret の名前を書かない（`deploy-worker.test.ts` が走査する）

## 手順

- 作業は必ず Issue から。ブランチは `feat/<issue番号>-<slug>`
- **監督側（人・オーケストレーター）の運用文書・CI・設定の変更も Issue を立ててから出す。** PR は `Closes #N` で Issue を閉じる。
  Issue を閉じない途中の PR は `Refs #N` でよいが、**その Issue を閉じる PR が必ず `Closes` を持つ**（2026-09-15・M0 清算 `workspace/mvp/m0/05-acceptance.md` §6）
- コミットは **Conventional Commits**（`feat:` `fix:` `chore:` `docs:` `ci:` `refactor:` `test:`）
- PR は **squash merge のみ**。squash のコミットメッセージ = PRタイトル
- `main` は保護。直接 push しない。緊急時の管理者バイパスは可能だが、**使ったら Issue に理由を残す**

## コマンド

```bash
pnpm install          # corepack 経由で pnpm 10.13.1 が使われる
pnpm check            # verify-parity → lint → typecheck → test（PR前に必ず通す）
pnpm build
terraform version     # .terraform-version（1.16.2）を tfenv がピンする
```

## 検証ゲート（誰が何を直すか）

**合格の定義は [`.commandmate/verify.yaml`](.commandmate/verify.yaml) と `.github/workflows/ci.yml` の
`lint-typecheck-unit` の2か所にあり、7段（deps / verify-parity / lint / typecheck / unit / tf-fmt / tf-validate）が順序まで一致する。**

| | 直せる人 | 理由 |
|---|---|---|
| **`.commandmate/` 配下**（verify.yaml・scripts・profiles） | **人（監督側）だけ** | CommandMate がワーカーの編集範囲から外す。**審判を書き換えられる被審判は審判されていない** |
| `.github/workflows/ci.yml` | ワーカーも可 | ただしゲートを足すと verify-parity が落ちる（↓） |

- **ゲートの追加・削除は、人が `verify.yaml` と `ci.yml` を1コミットで同時に直す。**
- ワーカーが `ci.yml` だけにゲートを足すと、`pnpm check:verify-parity` が落ちて PR はマージできない。
  **それが「人の手が要る」ことの合図である。** ワーカーは止まって人に返すこと。`verify.yaml` を直そうとしない。
- `ci.yml` の `lint-typecheck-unit` で `run:` を持つステップには、**直前の1行**に目印が要る。
  **目印の無い run ステップを足しても落ちる**（`- run:` 形式も `- name:` の次行に `run:` を書く形式も数える）。
  - ゲートなら `# verify-gate: <id>`（verify.yaml の gate id と順序まで照合される）
  - ゲートではない準備なら `# verify-setup: <理由>`（理由は必須。照合の対象外になる）
  - 目印とステップの間に別のコメントを挟むと、目印として効かない
- 照合するのは「どのゲートがどの順で走るか」まで。コマンドの文字列の一致までは見ない。
  **だからゲートの中身は `.commandmate/scripts/` に1本だけ置き、verify.yaml と ci.yml の両方から同じものを呼ぶ**
  （同じコマンドを2か所に書くと、中身だけがズレても parity check は気づかない）。

### Terraform のゲート（tf-fmt / tf-validate）

- `.commandmate/scripts/check-terraform.sh` が実体。**資格情報を一切使わない**（`init -backend=false`）
- 入っている terraform が `.terraform-version` と一致しなければ落ちる。**ローカルでは tfenv が要る**
- 検証用の作業領域は `.terraform-validate/`（ignore 済み）。実 apply 用の `.terraform/` とは分けてあるので、
  実 backend で init 済みの環境ディレクトリでもゲートは落ちない

## git worktree で並列作業するとき

**`.env` は追跡していないので worktree には存在しない。** Terraform も
`verify-cf-tokens.py` も、そのままでは動かない。worktree を作ったら最初にこれを実行する。

```bash
./infra/scripts/link-env.sh    # primary checkout の .env へ symlink を張る
```

コピーではなく symlink なのは、トークンが 2026-12-07 に失効するため。
primary の `.env` を1回直せば全 worktree に効く。

`.commandmate/profiles/musubi.json` の `baseline` に入れてあるので、
`cmate-worktree-setup` 経由なら自動で走る。**手で worktree を切ったときは自分で実行すること。**

> `.claude/skills` と `.agents/skills` を追跡しているのも同じ理由である。
> **worktree には tracked なファイルしか複製されない。**
