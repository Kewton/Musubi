# 04：CI/CD — PR検査 ／ main→staging ／ tag→production

> 対応DoD：**M0-2 CIパイプライン（PR検査＋staging/prod自動デプロイが通る）**
> 企画書21章：「PR時に lint＋typecheck＋unit。mainマージ→staging自動デプロイ、tag→production（**D1マイグレーション込み・ロールバック手順文書化**）」
> 前提：🧑 H-07（Environments）／H-08（Secrets）／H-14（アカウント分離の判断）
> 担当：🤖（production 承認は 🧑）
> **プラン前提：Cloudflare Free** — CIが無償枠を食わない規律は [`06-plan-and-limits.md`](./06-plan-and-limits.md) §6

---

## 1. ワークフロー構成

| ファイル | トリガ | 役割 | 必要な承認 |
|---|---|---|---|
| `.github/workflows/ci.yml` | PR / push to main | lint・typecheck・unit・PRタイトル検査 | なし |
| `.github/workflows/infra-plan.yml` | PR（`infra/**` 変更時） | `terraform plan` を3環境ぶん実行しPRコメント | なし |
| `.github/workflows/deploy-staging.yml` | push to `main` | D1 migration → deploy → smoke | なし（自動） |
| `.github/workflows/deploy-production.yml` | tag `v*` | D1 migration → deploy → smoke | 🧑 **required reviewer** |
| `.github/workflows/rollback.yml` | 手動（`workflow_dispatch`） | 指定タグへ巻き戻し | 🧑 **required reviewer** |

**required status checks（`main` 保護に登録するジョブ名）**
- `lint-typecheck-unit`
- `terraform-plan`

---

## 2. PR検査（`ci.yml`）

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-typecheck-unit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      # ★ wrangler.jsonc が terraform output と乖離していないか
      - run: pnpm infra:sync --env staging --check

  pr-title:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: amannn/action-semantic-pull-request@v5
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
```

> **宣言した線：PR検査 ≤ 5分**（README §5）。超えたら turbo のリモートキャッシュ導入を検討する。

---

## 3. Terraform plan（`infra-plan.yml`）

> **2026-09-13 訂正**：旧版のワークフローには、そのまま写すと壊れる箇所が5つあった（Issue #14 の実装前に発見）。
>
> | # | 旧版 | 何が起きるか | 訂正 |
> |---|---|---|---|
> | 1 | `setup-terraform` に `terraform_version_file` | **その入力は存在しない。** 無視されて最新版が入り、ピンが黙って効かない | `.terraform-version` を読んで `terraform_version` に渡す |
> | 2 | `setup-terraform@v3` | 古い | `@v4` |
> | 3 | `on.pull_request.paths` で絞り、`terraform-plan` を必須チェックにする | **Terraform を触らない PR で必須チェックが永久に「待機中」になり、全 PR がマージ不能** | 常に起動し、中で変更の有無を見て no-op にする（下記） |
> | 4 | `AWS_ENDPOINT_URL_S3` が無い | backend が R2 を見つけられず init が落ちる | GitHub Variable `R2_S3_ENDPOINT` を渡す（`infra/terraform/README.md` §3） |
> | 5 | 3環境とも `TF_CLOUDFLARE_API_TOKEN` / `vars.CLOUDFLARE_ACCOUNT_ID` | H-14 案A でアカウントを分けた後なので、**production の plan は必ず失敗する**（①のトークンが②に届かないことを実測済み） | matrix で環境ごとに secret 名を切り替える |

```yaml
name: terraform-plan
on:
  pull_request:          # ★ paths で絞らない（訂正3）。必須チェックは「常に結果を返す」必要がある

permissions:
  contents: read

jobs:
  terraform-plan:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        include:           # ★ 環境ごとに資格情報を切り替える（訂正5）
          - { env: dev,        token: TF_CLOUDFLARE_API_TOKEN,      account: CLOUDFLARE_ACCOUNT_ID }
          - { env: staging,    token: TF_CLOUDFLARE_API_TOKEN,      account: CLOUDFLARE_ACCOUNT_ID }
          - { env: production, token: TF_CLOUDFLARE_API_TOKEN_PROD, account: CLOUDFLARE_ACCOUNT_ID_PROD }
    permissions: { contents: read, pull-requests: write }
    env:
      CLOUDFLARE_API_TOKEN:  ${{ secrets[matrix.token] }}
      TF_VAR_account_id:     ${{ vars[matrix.account] }}
      AWS_ACCESS_KEY_ID:     ${{ secrets.R2_ACCESS_KEY_ID }}       # backend は常にアカウント①の R2
      AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      AWS_ENDPOINT_URL_S3:   ${{ vars.R2_S3_ENDPOINT }}            # ★ 訂正4
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      # ★ 訂正3：変更が無ければ以降を飛ばし、ジョブ自体は success で終わらせる
      - id: changed
        run: |
          if git diff --quiet "origin/${{ github.base_ref }}...HEAD" -- infra/terraform; then
            echo "tf=false" >> "$GITHUB_OUTPUT"
          else
            echo "tf=true" >> "$GITHUB_OUTPUT"
          fi

      # ★ 訂正1：.terraform-version を読んで渡す
      - id: tfver
        if: steps.changed.outputs.tf == 'true'
        run: echo "version=$(tr -d '[:space:]' < .terraform-version)" >> "$GITHUB_OUTPUT"
      - uses: hashicorp/setup-terraform@v4          # ★ 訂正2
        if: steps.changed.outputs.tf == 'true'
        with:
          terraform_version: ${{ steps.tfver.outputs.version }}
          terraform_wrapper: false                   # wrapper は出力と exit code を包むので切る

      - if: steps.changed.outputs.tf == 'true'
        run: terraform -chdir=infra/terraform/envs/${{ matrix.env }} init -input=false -lockfile=readonly
      - if: steps.changed.outputs.tf == 'true'
        run: terraform -chdir=infra/terraform/envs/${{ matrix.env }} plan -input=false -no-color -out=tfplan > /dev/null
      # PR コメントには Plan 行とリソースアドレスだけを貼る（§3.1）
```

> **fork からの PR には secrets が渡らない。** public リポジトリなので、fork PR ではこのジョブの init が必ず落ちる。
> 1人開発のうちは実害がないが、**`pull_request_target` で回避しないこと**（公開リポジトリの典型的な権限昇格経路）。
>
> **#14 で決めること：PR の plan に production のトークンを渡してよいか。**
> 上の形では、PR を出したブランチのコードが `TF_CLOUDFLARE_API_TOKEN_PROD` を持って走る。plan は読み取りだが、
> §7 の「staging のワークフローから prod のトークンに手が届かない構造」とは緊張関係にある。
> 選択肢は (a) このまま（1人開発・fork には渡らない）／(b) production の plan だけ `environment: production` を付けて
> 承認を挟む（毎 PR で承認が要る）／(c) production の plan は PR では回さず、タグ時にだけ回す。

**`terraform apply` は CI から自動実行しない。** 環境資源の作成/破壊は 🧑 人間が手元で（またはworkflow_dispatch＋承認で）実行する。理由：Cloudflareアカウント資源の誤destroyは復旧不能なものを含む（R2データ・D1データ）。**M0の段階で自動applyまで踏み込む利得より、事故のコストのほうが大きい。**

---

### 3.1 **public リポジトリなので、plan 出力をそのままログへ流さない**

`Kewton/Musubi` は public である（→ [`00b-decisions.md`](./00b-decisions.md) D-2）。つまり **Actions の実行ログも、PR コメントも、ワークフローのアーティファクトも、すべて誰でも読める。** 企画書と商標を private 側へ分けても、ここから漏れれば同じことになる。

**押さえるべき事実**

| | 挙動 |
|---|---|
| `secrets.*` | ログで自動マスクされる。ただしマスクは**文字列一致**なので、base64 等に加工されると抜ける |
| `vars.*` | **マスクされない。平文で出る** |
| `terraform plan` の標準出力 | 変数値・リソース属性を含む。既定で全部ログへ出る |
| PR コメント / アーティファクト | public リポジトリでは**どちらも公開**。「ログを避けてこちらへ」は対策にならない |

**規律（M0-4 の実装時に必ず入れる）**

1. **`account_id` は Terraform 側で `sensitive = true` にする。** plan 出力で `(sensitive value)` に置き換わる
   ```hcl
   variable "account_id" {
     type      = string
     sensitive = true
   }
   ```
2. **plan の全文をログへ出さない。** `-out` でファイルに落とし、標準出力は捨てる
   ```yaml
   - run: terraform -chdir=infra/terraform/envs/${{ matrix.env }} plan -no-color -out=tfplan > /dev/null
   ```
3. **PR コメントに貼るのは「何が変わるか」だけ**にする。属性値は貼らない
   ```yaml
   - id: summary
     run: |
       terraform -chdir=infra/terraform/envs/${{ matrix.env }} show -no-color tfplan          | grep -E '^(Plan:|No changes|  # )' > plan-summary.txt
   ```
   → `Plan: 3 to add, 0 to change, 0 to destroy.` とリソースアドレス（`# cloudflare_r2_bucket.tfstate will be created`）だけが残る。**差分の中身を見たいときは手元で `terraform show tfplan` を開く。**
4. **変数を `echo` / `env` / `set -x` で出さない。** デバッグ時も同じ。
5. 🧑 **`CLOUDFLARE_ACCOUNT_ID` と `R2_S3_ENDPOINT` は Variables から Secrets へ移すことを検討する**（H-08）。Secrets なら Actions が自動マスクする。`R2_S3_ENDPOINT` はアカウントIDを URL に含むため、Variable のままだと必ずログに出る
   ```bash
   # 移す場合（値は標準入力で渡す。コマンド引数に書かない）
   gh secret set CLOUDFLARE_ACCOUNT_ID --repo Kewton/Musubi
   gh variable delete CLOUDFLARE_ACCOUNT_ID --repo Kewton/Musubi
   ```
   → 移したら、本ファイルの `vars.CLOUDFLARE_ACCOUNT_ID` / `vars.CLOUDFLARE_ACCOUNT_ID_PROD` を `secrets.` へ書き換える。`TFSTATE_BUCKET` は Variable のままでよい

> **フォークからの PR には Secrets が渡らない。** public リポジトリなので `terraform-plan` は fork PR で必ず失敗する。required status check にしている以上、外部PRは永久に green にならない。1人開発のうちは実害がないが、**`pull_request_target` で回避しようとしないこと**——公開リポジトリの典型的な権限昇格経路になる。

---

## 4. staging 自動デプロイ（`deploy-staging.yml`）

```yaml
name: deploy-staging
on:
  push: { branches: [main] }

concurrency: { group: deploy-staging, cancel-in-progress: false }

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    env:
      CLOUDFLARE_API_TOKEN:  '${{ secrets.CLOUDFLARE_API_TOKEN }}'
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build

      # ① D1マイグレーション（デプロイより先。前方互換規律が前提）
      - run: pnpm exec wrangler d1 migrations apply musubi-staging-control --remote --env staging
        working-directory: packages/control-plane

      # ② デプロイ順序：依存の末端から。data-api → gateway → host
      - run: pnpm exec wrangler deploy --env staging --var GIT_SHA:'${{ github.sha }}'
        working-directory: packages/data-api
      - run: pnpm exec wrangler deploy --env staging --var GIT_SHA:'${{ github.sha }}'
        working-directory: apps/gateway
      - run: pnpm exec wrangler deploy --env staging --var GIT_SHA:'${{ github.sha }}'
        working-directory: apps/host

      # ③ 貫通スモーク（03 §5）。落ちたらデプロイ失敗として扱う
      - run: pnpm smoke --env staging --expect-sha '${{ github.sha }}'
```

**デプロイ順序が data-api → gateway → host である理由**：Service Binding は「呼ぶ側」が「呼ばれる側」の存在を要求する。末端から配れば、途中の瞬間も常に整合が取れている。

> **宣言した線：main merge → smoke green まで ≤ 10分**（README §5）。

---

## 5. production デプロイ（`deploy-production.yml`）

```yaml
name: deploy-production
on:
  push: { tags: ["v*"] }

concurrency: { group: deploy-production, cancel-in-progress: false }

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production        # ← 🧑 required reviewer による承認待ちがここで入る
    env:
      # 🧑 H-14 で production を別アカウントにした場合、ここだけトークンが変わる
      CLOUDFLARE_API_TOKEN:  '${{ secrets.CLOUDFLARE_API_TOKEN_PROD }}'
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID_PROD }}'
    steps:
      # staging と同一手順。--env production / musubi-production-control に読み替え
      # 最後に smoke --env production
```

**リリース手順（人間の操作）**

```bash
# staging の smoke が green であることを確認してから
git tag -a v0.1.0 -m "M0: platform baseline"
git push origin v0.1.0
# → GitHub Actions が起動 → 🧑 あなたに承認依頼が飛ぶ → Approve でデプロイ
```

---

## 6. ロールバック（**M0のDoD。文書化＋実演まで**）

企画書21章は「ロールバック手順**文書化**」を求めている。M0では**実際に1回やってみる**ところまでを完了条件にする（手順書は使われて初めて手順書になる）。

`docs/runbook/rollback.md` に書く内容：

### 6.1 コードのロールバック

```bash
# 直前の正常タグへ巻き戻す
gh workflow run rollback.yml -f target_tag=v0.1.0 -f env=production
```

`rollback.yml` は「指定タグを checkout → build → deploy（マイグレーションは**当てない**）→ smoke」を行う。

**より速い代替**：Cloudflare の Worker には過去バージョンへの巻き戻し機能がある（`wrangler rollback` / ダッシュボードの Deployments）。**どちらを一次手段にするかをM0で決めて書く。**
- 推奨：**まず `wrangler rollback` で即時復旧 → 落ち着いてから git tag でのやり直し**（MTTRを最小化）
- 🤖 タスク：`wrangler rollback` が使用バージョンで動くか実機確認し、runbook に確定手順を書く

### 6.2 D1 のロールバック（**ここが本当の難所**）

**D1にスキーマのロールバック機能は無い。** よって規律で回避する：

| 規律 | 内容 |
|---|---|
| **前方互換のみ** | 列の追加はOK。削除・改名・NOT NULL化は**単発で行わない** |
| **2段階リリース** | ① 新旧両対応のコードをデプロイ → ② 十分な期間後に旧スキーマを撤去する migration |
| **destructive migration のレビュー必須** | `DROP` / `ALTER ... DROP COLUMN` / `RENAME` を含むPRは CI が警告し、人間の明示承認を要求する |
| **バックアップ** | production の D1 は `wrangler d1 export` を定期実行し R2 へ（M0では手順書のみ。cron化はM2） |

> **M0のうちにこれを決めておくことの価値**：M2で認証・Community・Membership のスキーマが入る。そこで初めて考えると、必ず一度データを壊す。

### 6.3 Terraform のロールバック

- R2 はバケットバージョニング未対応。apply 前後に state を別キーへ退避し、復元手順を用意する（H-03）。state の復元だけでは実リソースは戻らないため、復元時は実リソースとの整合も確認する。バックアップと復元検証は `02` の実装タスクであり、現時点では未完了。[R2 S3 API対応表](https://developers.cloudflare.com/r2/api/s3/api/)
- **`terraform destroy` は staging/production で禁止**。CIにジョブを作らない、手元でも `-target` 無しの destroy を打たない運用にする

---

## 6.5 CI が無償枠を食わないための規律（→ `06` §6）

Free の上限はアカウント単位。**M0で枠を食う主犯はユーザーではなくCI。**

| 規律 | 実装 |
|---|---|
| **スモークはデプロイ後1回だけ。定期ポーリングしない** | `schedule:` トリガのヘルスチェックワークフローを**作らない**（5分おきなら 288 req/日 × 環境数） |
| dev/staging と production を別アカウントに | 🧑 H-14 案A。CIの試行錯誤が prod 枠に届かない |
| `terraform plan` は `infra/**` 変更時のみ | `paths:` フィルタ（§3 に実装済み）。Cloudflare API のレート制限も節約 |
| **Logpush を使わない** | 有償。代わりに各 wrangler.jsonc の `observability: { enabled: true }`（Workers Logs・無償枠） |
| `concurrency` で重複デプロイを潰す | §4・§5 に実装済み |

> **監視の代替**：Logpush が使えないので、障害検知は Workers Logs ＋ デプロイ時スモークで賄う。**常時監視が要るのは M3（ドッグフーディング）から**——そのとき Workers Paid に上がっている想定（`06` §5 P-5）。

---

## 7. Secrets の扱い

- Worker の secrets（M2以降：LINE Channel Secret 等）は `wrangler secret put` で環境ごとに投入し、**GitHub Secrets からは CI 経由で流し込まない**（CIログ・Actions権限を経由させない）
- M0時点で必要な secret は無い（`GIT_SHA` は `--var` で十分＝公開情報）
- 🧑 H-14 でアカウントを分けた場合、**staging用と production用でCIトークンが別物**になる。`deploy-production.yml` だけが `..._PROD` を参照する（§5）——**staging のワークフローから prod のトークンに手が届かない**構造にしておく
- 企画書12章「Builder Containerに本番資格情報を一切置かない」の姿勢を、**CIランナーにも同じく適用する**：CIトークンは Workers Scripts / D1 / R2 の Edit のみ（🧑 H-02 ②）
- **リポジトリが public である前提を忘れない。** ログ・PRコメント・アーティファクトはすべて公開される。Variables はマスクされない（→ §3.1）

---

## 8. このステップのDoD

- [ ] PRを1本出して `lint-typecheck-unit` と `terraform-plan` が green
- [ ] main へ squash merge → staging へ自動デプロイ → smoke green
- [ ] `v0.0.1` タグ → 🧑 承認 → production へデプロイ → smoke green
- [ ] `docs/runbook/rollback.md` が存在し、**実際に production を1つ前のバージョンへ戻して復帰させた記録がある**
- [ ] `docs/runbook/d1-migration.md` に前方互換規律が書かれている
- [ ] main への直接pushが拒否されることを実際に確認した
- [ ] PR検査 ≤ 5分 ／ main→staging ≤ 10分 を実測し記録した
- [ ] `schedule:` トリガのワークフローが**1つも無い**（無償枠の消費源を作らない）
- [ ] 全 wrangler.jsonc に `observability: { enabled: true }` があり、Logpush を使っていない
