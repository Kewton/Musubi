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
      # ★ infra:sync --check はここに入れない（2026-09-13 決定）。§4・§5 のデプロイ直前に置く（03 §3）

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

**正本は `.github/workflows/infra-plan.yml`。** ここにワークフローの全文を複製しない
（複製した YAML は実装とずれ、2026-09-13 までに2度バグを持ち込んだ。上の訂正表と、下の訂正6）。

構造と、壊さないための規則だけを書く。

```
changes         … PR が infra/terraform か .terraform-version を触ったかを判定する
plan (dev)      … 触っていれば plan を回し、PR コメントに Plan 行とリソースアドレスだけを貼る
plan (staging)  … 同上
terraform-plan  … 上の結果を1つに畳む集約ジョブ。★必須チェックに登録する名前はこれ
```

| 規則 | 理由 |
|---|---|
| **`paths` で起動を絞らない** | 必須チェックは常に結果を返す必要がある（訂正3） |
| **必須チェックは集約ジョブ `terraform-plan` に登録する。matrix ジョブに登録しない** | **訂正6**：matrix のチェック名は `plan (dev)` のように値付きで報告され、`terraform-plan` という名前は出ない。必須にすると永久に待機状態になる |
| 集約ジョブは `if: always()`。`!cancelled()` にしない | 取り消されて skipped になった必須チェックを GitHub は**通過**として扱い、plan を経ずにマージできてしまう |
| plan は `-lock=false` | 読み取りだけで、concurrency で取り消されると R2 にロックが残り次の apply を止めるため |
| 資格情報は plan のステップにだけ渡す（ジョブの env にしない） | 変更の無い PR や他のステップのログに出さない |
| **Account ID と R2 エンドポイントは Secret から渡す** | `vars` はマスクされずログに平文で出る（2026-09-14 移行済み。§3.1） |
| **production の plan は PR で回さない** | 下の決定 |

### production の plan を PR で回さない（2026-09-14 決定：(c)）

**PR の plan は dev と staging だけ。** production の資格情報は **`production` 環境の Secret** に置き、
`v*` タグで起動し Kewton が承認したジョブ（§5）からしか届かないようにした。

- `pull_request` のワークフローは **PR 側のブランチに書かれた定義で動く**。リポジトリ全体に置いた Secret には、
  ワークフローを書き換えた PR からも手が届く。PR を作るのは AI ワーカーである
- 案 (b)「production の plan に `environment: production` を付ける」は成立しない。`production` 環境は
  `v*` タグからのデプロイしか許可しておらず、PR のブランチでは起動しない
- 3環境は同じモジュールで違いは変数だけなので、構成の妥当性は dev と staging の plan で見える。
  production の設定の構文・型は、資格情報を使わない `tf-validate` ゲートが PR で見ている
- **代償**：production の実物との差分が見えるのはリリース時（承認の後ろ）になる
- `TF_CLOUDFLARE_API_TOKEN_PROD` は GitHub に置かない。production への apply は人が立ち会って手元から行う（#4）

> **fork からの PR には secrets が渡らない。** public リポジトリなので、fork PR では plan が必ず落ちる。
> 1人開発のうちは実害がないが、**`pull_request_target` で回避しないこと**（公開リポジトリの典型的な権限昇格経路）。

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
5. ✅ **`CLOUDFLARE_ACCOUNT_ID` と `R2_S3_ENDPOINT` は Secret に置く**（2026-09-14 移行済み）。Secret なら Actions が自動でマスクする。
   `R2_S3_ENDPOINT` は URL に Account ID を含むので、Variable のままだと必ずログに出る。
   `CLOUDFLARE_ACCOUNT_ID_PROD` は `production` 環境の Secret（§5）。`TFSTATE_BUCKET` はバケット名が `backend.tf` に書かれていて公開済みなので Variable のまま

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
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      # ⓪ デプロイ直前の乖離チェック（2026-09-13 決定・03 §3）
      #    wrangler.jsonc の Terraform 由来の欄が、staging の実物（state）と一致しなければデプロイしない。
      #    必要なのは tfstate の backend（R2）の資格情報だけ。Cloudflare のトークンは使わない。
      - id: tfver
        run: echo "version=$(tr -d '[:space:]' < .terraform-version)" >> "$GITHUB_OUTPUT"
      - uses: hashicorp/setup-terraform@v4
        with: { terraform_version: '${{ steps.tfver.outputs.version }}', terraform_wrapper: false }
      - name: 乖離チェック（wrangler.jsonc ⇔ terraform output）
        env:
          CHECKPOINT_DISABLE: "1"
          AWS_ACCESS_KEY_ID:     '${{ secrets.R2_ACCESS_KEY_ID }}'
          AWS_SECRET_ACCESS_KEY: '${{ secrets.R2_SECRET_ACCESS_KEY }}'
          AWS_ENDPOINT_URL_S3:   '${{ secrets.R2_S3_ENDPOINT }}'
        run: |
          # init の stderr は endpoint URL（アカウント ID を含む）を出しうるので捨てる。public リポジトリの CI ログは公開される
          terraform -chdir=infra/terraform/envs/staging init -input=false -lockfile=readonly -no-color >/dev/null 2>&1 \
            || { echo "::error::terraform init に失敗（詳細はログに出さない。手元で同じ手順を再現すること）"; exit 1; }
          pnpm infra:sync --env staging --check

      - run: pnpm build

      # ① D1マイグレーション（デプロイより先。前方互換規律が前提 → docs/runbook/d1-migration.md §3・§4）
      #    SQL は packages/control-plane/migrations、当てる先は data-api の設定の CONTROL_DB（03 §7・2026-09-14 決定）。
      #    control-plane には wrangler の設定が無いので working-directory では当たらない。リポジトリ直下から --config で指す。
      #    --remote は database_id が実物でないと当たらない。⓪ の乖離チェックが先にあるのはそのため
      - run: pnpm exec wrangler d1 migrations apply CONTROL_DB --env staging --config packages/data-api/wrangler.jsonc --remote

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

**migration（①）がデプロイ（②）より先である理由**：新しいコードは新しいスキーマを前提にしてよい。代わりに ① と ② の間は古い data-api が新しいスキーマの上で動くので、
**1つ前のリリースのコードが新しいスキーマで動く**形でしかスキーマを変えない（前方互換規律。`docs/runbook/d1-migration.md` §4）。
② が落ちても、§6 でコードを巻き戻しても、同じ状態になる。

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
      # ★ この2つは **production 環境の Secret**（2026-09-14）。リポジトリ全体には置いていないので、
      #   environment: production を宣言し、v* タグで起動し、Kewton が承認したこのジョブからしか読めない
      CLOUDFLARE_API_TOKEN:  '${{ secrets.CLOUDFLARE_API_TOKEN_PROD }}'
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID_PROD }}'
    steps:
      # staging と同一手順。--env production に読み替え
      # ① の D1 マイグレーションも --env production だけを変える（SQL の置き場と --config は staging と同じ）
      # ⓪ の乖離チェックも同じ形で `envs/production` と `--env production` に読み替える。
      #    backend（state の置き場）は production でもアカウント①の R2 なので、R2 の資格情報は staging と同じ
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
| **2段階リリース** | ① 新旧両対応のコードをデプロイ → ② 旧スキーマを撤去する migration。「十分な期間」＝**1つ前の production リリースが撤去対象を使っていない**こと。段ごとに別のタグで出す（`docs/runbook/d1-migration.md` §4.4） |
| **destructive migration のレビュー必須** | `DROP` / `ALTER ... DROP COLUMN` / `RENAME` を含むPRは CI が警告し、人間の明示承認を要求する |
| **バックアップ** | production の D1 は `wrangler d1 export` を定期実行し R2 へ（M0では手順書のみ。cron化はM2） |
| **最後の手段：Time Travel** | 過去の時点へ DB を丸ごと戻す（破壊的・Free は7日まで）。**コードを先に戻す**。戻すと `d1_migrations` も戻り、次の CD で同じ migration が当たり直す（`docs/runbook/d1-migration.md` §5.3） |

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
- **本番の資格情報は `production` 環境の Secret にだけ置く**（2026-09-14）。`CLOUDFLARE_API_TOKEN_PROD` と
  `CLOUDFLARE_ACCOUNT_ID_PROD` は、`environment: production` を宣言し、`v*` タグで起動し、Kewton が承認したジョブからしか読めない。
  **リポジトリ全体の Secret にしない**：`pull_request` のワークフローは PR 側のブランチの定義で動くので、ワークフローを書き換えた PR から届いてしまう。
  `TF_CLOUDFLARE_API_TOKEN_PROD` は GitHub に置かない（production への apply は手元から）
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
