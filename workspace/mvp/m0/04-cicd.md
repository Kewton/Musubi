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
| `.github/workflows/deploy-staging.yml` | push to `main` ／ 手動（`workflow_dispatch`。main のみ） | 乖離チェック → D1 migration → deploy → smoke | なし（自動） |
| `.github/workflows/deploy-production.yml` | tag `v*` ／ 手動（`workflow_dispatch`。v タグのみ） | 乖離チェック → D1 migration → deploy → smoke | 🧑 **required reviewer** |
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

> **2026-09-14 訂正（Issue #15 の実装時）**：旧版のワークフロー例には、そのまま写すと落ちる・漏れる箇所が4つあった。
>
> | # | 旧版 | 何が起きるか | 訂正 |
> |---|---|---|---|
> | 1 | `pnpm build` → host で `wrangler deploy --env staging` | host は**ビルドの時点で** `CLOUDFLARE_ENV` によって env が決まる（未指定なら dev）。turbo が値をタスクへ渡さないので dev でビルドされ、wrangler が env の食い違いで **exit 1**。さらにキャッシュが当たると配備用の設定（`.wrangler/deploy/`）が戻らず、``The `assets` property … missing the required `directory` property.`` でも落ちる | `apps/host/turbo.json` で build に `CLOUDFLARE_ENV` を渡し、outputs に `.wrangler/deploy/**` を足す。ワークフローは `CLOUDFLARE_ENV=staging` を付けてビルドする |
> | 2 | `wrangler deploy` の出力をそのままログへ流す | 配備後に **workers.dev の URL（アカウントのサブドメイン）** を表示する（wrangler 4.131.1 のソースで確認）。公開の CI ログに載る | `infra/scripts/deploy-worker.ts` が出力をファイルに受け、ホスト名を伏せた要約だけを出す（下の「wrangler の出力を伏せる」） |
> | 3 | Cloudflare のトークンをジョブの `env` に置く | ⓪ の乖離チェック（渡さないと決めた）や install・build のステップにまで届く | 資格情報は使うステップの `env` にだけ渡す |
> | 4 | 貫通スモークの宛先の置き場所が無い | `SMOKE_BASE_URL` が空で ③ が落ちる。配った後に気づく | **staging 環境の Secret**。ジョブに `environment: staging` を宣言し、最初のステップで空かどうかを確かめる |

**正本は `.github/workflows/deploy-staging.yml`。** §3 と同じ理由で、ここにワークフローの全文を複製しない。
並び・資格情報の置き場所・起動条件は `infra/scripts/deploy-worker.test.ts` が確かめる。

```
前提の確認     … main であること・使う Secret が空でないこと（値は渡さない。式で比べた true / false だけを渡す）
install
⓪ 乖離チェック … terraform init（出力は stderr ごと捨てる）→ pnpm infra:sync --env staging --check。乖離があれば何も配らない
build          … CLOUDFLARE_ENV=staging pnpm build
① migration    … deploy-worker.ts --env staging --target migrate
② deploy       … deploy-worker.ts --env staging --target data-api → gateway → host（--sha <commit>）
③ smoke        … pnpm smoke --env staging --expect-sha <commit>（宛先は環境変数 SMOKE_BASE_URL）
④ 所要時間     … main の push から smoke green までを測ってジョブの要約に残し、10分を超えたら警告する（落とさない）
```

| 規則 | 理由 |
|---|---|
| 起動は main への push と `workflow_dispatch` だけ。手動実行でも main 以外は前提の確認で落とす | staging は main の姿。PR の段階では実環境に書き込まない（下の「PR での確かめ方」） |
| `concurrency` は取り消さない（`cancel-in-progress: false`） | migration の後・deploy の前などで止めない。待ちが重なれば GitHub が最新の1つだけを残す |
| `permissions` は `contents: read` だけ | Cloudflare へは Secret のトークンで書く。GITHUB_TOKEN に書き込みは要らない |
| **資格情報は使うステップの `env` にだけ渡す**（ジョブの `env` にしない） | Cloudflare のトークンと Account ID は ① ②、tfstate の backend（R2）の3つは ⓪、`SMOKE_BASE_URL` は ③。⓪ に Cloudflare のトークンは要らない（`terraform output` は backend しか読まない。実測済み） |
| `vars` を使わない | Account ID・R2 のエンドポイント・workers.dev の URL はどれも Secret（§3.1） |
| **`SMOKE_BASE_URL` は staging 環境の Secret**。smoke に `--base-url` を使わない | Variable はステップの env 表示に平文で出る。pnpm はコマンド行を引数ごとログに出す |
| `environment` に `url` を書かない | デプロイの記録に載り、誰でも読める |
| wrangler を直接呼ばない。`deploy-worker.ts` を通す | 下の「wrangler の出力を伏せる」 |
| host は配る env の `CLOUDFLARE_ENV` を付けてビルドする | 下の「host は build 時に env が決まる」 |

**デプロイ順序が data-api → gateway → host である理由**：Service Binding は「呼ぶ側」が「呼ばれる側」の存在を要求する。末端から配れば、途中の瞬間も常に整合が取れている。

**migration（①）がデプロイ（②）より先である理由**：新しいコードは新しいスキーマを前提にしてよい。代わりに ① と ② の間は古い data-api が新しいスキーマの上で動くので、
**1つ前のリリースのコードが新しいスキーマで動く**形でしかスキーマを変えない（前方互換規律。`docs/runbook/d1-migration.md` §4）。
② が落ちても、§6 でコードを巻き戻しても、同じ状態になる。

**⓪ が ① より先である理由**：`--remote` は `database_id` が実物でないと当たらない。乖離していれば何も配らずに止める（`03` §3）。

> **宣言した線：main merge → smoke green まで ≤ 10分**（README §5）。④ が毎回測る（起点は push イベントの `repository.pushed_at`。キューの待ちを含む）。

### host は build 時に env が決まる（2026-09-14 決定）

host（TanStack Start ＋ @cloudflare/vite-plugin）は `vite build` の時点で `CLOUDFLARE_ENV` によって wrangler.jsonc の `env.<env>` を解決し、
ビルドの出力に書き込む。`wrangler deploy` はその出力を読むので、**ビルドした env と `--env` が食い違えば wrangler が落とす**（別 env を黙って配ることはない）。

- **`apps/host/turbo.json`**（host だけの turbo の設定）で、build の `env` に `CLOUDFLARE_ENV` を書く。turbo は既定（strict）で `env` に無い環境変数をタスクへ渡さない。書くとキャッシュの鍵にも入り、env ごとに別の出力になる
- 同じ設定の `outputs` に `.wrangler/deploy/**`（vite build が書く配備用の設定）を足す。package の `outputs` はルートの `outputs` を置き換えるので、ルートの2つも並べる
- ワークフローは `CLOUDFLARE_ENV=staging` を付けて `pnpm build` する。ルートの `deploy:staging` / `deploy:production` も同じ env でビルドする（`CLOUDFLARE_ENV=<env> turbo run deploy …`）。`deploy:dev` は未指定＝dev のまま
- ビルドの出力のディレクトリ名は env によらず `apps/host/dist/musubi_dev_host`（トップレベルの `name` から作られる）。どの env でビルドしたかは中の `wrangler.json` の `targetEnvironment` を見る

### wrangler の出力を伏せる（`infra/scripts/deploy-worker.ts`）

`wrangler deploy` は配備後に workers.dev の URL を表示する。サブドメインが公開の CI ログに載ると、無償枠（100k req/日）を他人に消費させる入口になる（`pnpm smoke` が URL を出さないのと同じ理由）。
deploy と D1 マイグレーションは wrangler を直接呼ばず、次の形で動かす。

- wrangler の標準出力と標準エラーは**ファイル**（`$RUNNER_TEMP/deploy-worker-<env>-<target>.log`）に受ける。**アーティファクトにしない**（公開される）
- 成功したら、**許した行だけ**（アセットの upload・upload の大きさ・binding の表・配備先・Version ID／マイグレーションの表と当てた先）を伏せてから出す。知らない行に何が載るかは保証できないので、伏せる処理だけに頼らない
- 失敗したら、全文を伏せてから出す（原因が読めないと直せない）
- 伏せるもの：workers.dev のホスト名（サブドメインの段をすべて）、Account ID の形（32桁の16進）と `CLOUDFLARE_ACCOUNT_ID` の値。ANSI エスケープは先に取り除く（色の切り替えがホスト名を割る・OSC 8 のリンクが URL を運ぶ）。行頭の `::` は崩す（ワークフローコマンドとして読ませない）
- 伏せ方は `deploy-worker.test.ts` が確かめる。作り物の出力（色で割ったホスト名・OSC 8 のリンク・プレビュー URL・API のパスの Account ID・行頭の `::`）と、実物の wrangler の `--dry-run` の出力で

### `--var GIT_SHA`

`wrangler deploy --var GIT_SHA:<sha>` は、vite-plugin のビルド出力に対しても設定の `"local"` を上書きする。
dry-run の binding の表で、`--var` を付けると `env.GIT_SHA ("(hidden)")`、付けないと `env.GIT_SHA ("local")` と出る（2026-09-14 実測。gateway と host）。
最終確認は初回デプロイの ③（`--expect-sha`）。

### PR での確かめ方（実環境に書き込まない）

PR の段階では Cloudflare に何も配らない。`CLOUDFLARE_ENV=staging` でビルドした3つの Worker に `wrangler deploy --dry-run --env staging` を当てて確かめた。

**2026-09-14・main = `06bfc4b`・wrangler 4.131.1・turbo 2.10.12・@cloudflare/vite-plugin 1.54.8**

| 確かめたこと | 手順 | 結果 |
|---|---|---|
| turbo が host の build に env を渡す | `CLOUDFLARE_ENV=staging pnpm exec turbo run build --filter @musubi/host --force` | 出力は `musubi-staging-host`（`targetEnvironment: staging`）。`apps/host/turbo.json` を外すと `musubi-dev-host` |
| キャッシュ復元でも配備用の設定が戻る | `apps/host/dist` と `apps/host/.wrangler` を消して同じビルド（cache hit） | `.wrangler/deploy/config.json` が戻る。続けて `pnpm deploy:staging --dry-run` で host も exit 0 |
| env 未指定は dev | `CLOUDFLARE_ENV` 無しで同じビルド | 鍵が変わって cache miss、出力は `musubi-dev-host` |
| 3つの Worker を staging として配れる | 各 Worker で `wrangler deploy --dry-run --env staging --var GIT_SHA:<sha>`（`WRANGLER_LOG=debug`） | 3つとも exit 0。Cloudflare API へのリクエスト（`START CF API REQUEST`）は 0 件。host の GATEWAY → `musubi-staging-gateway` |
| ルートの `deploy:staging` / `deploy:production` | `pnpm deploy:<env> --dry-run`（後ろの引数は wrangler deploy に渡る） | どちらも exit 0。host の GATEWAY は `musubi-<env>-gateway`、production は `HEALTHZ_DETAIL: "probe"` |
| 別 env のビルドは配らない | staging でビルドした host に `--env production` の dry-run | exit 1（`This does not match the target environment "staging"`） |
| ワークフローの構文 | `actionlint`（shellcheck 込み） | 指摘 0 |

### 初回デプロイ（Issue #15 の PR をマージした時点で走る。🧑 立ち会う）

前提（🧑 **マージ前**）：GitHub に `staging` 環境を作り、Secret `SMOKE_BASE_URL`（staging の host の workers.dev のオリジン）を登録する。
無ければ前提の確認で落ち、何も配らない。

立ち会って確かめること：

- [ ] ① ② が CI のトークンで書き込める（読み取りは確認済み）
- [ ] ③ が `--expect-sha` で green になる（`--var GIT_SHA` の最終確認）
- [ ] ④ の所要時間が 10分以内（§8「main→staging ≤ 10分を実測し記録した」）
- [ ] ログに workers.dev のホスト名と Account ID が出ていない

---

## 5. production デプロイ（`deploy-production.yml`）

**§4 と同じ形**にする（Issue #16）。違うのは env と、起動・承認・資格情報の置き場所だけ。

**正本は `.github/workflows/deploy-production.yml`。** §3・§4 と同じ理由で、ここにワークフローの全文を複製しない。
並び・資格情報の置き場所・起動条件・staging から届かないことは `infra/scripts/deploy-worker.test.ts` が確かめる。

```
🧑 承認        … environment: production。必須レビュワー（Kewton）が承認するまでジョブを始めない
前提の確認     … v タグであること・使う Secret が空でないこと（値は渡さない。式で比べた true / false だけを渡す）
install
⓪ 乖離チェック … terraform -chdir=infra/terraform/envs/production init（出力は stderr ごと捨てる）→ pnpm infra:sync --env production --check
build          … CLOUDFLARE_ENV=production pnpm build
① migration    … deploy-worker.ts --env production --target migrate
② deploy       … deploy-worker.ts --env production --target data-api → gateway → host（--sha <commit>）。gateway と host は MUSUBI_PROBE_TOKEN を secret として載せる
③ smoke        … pnpm smoke --env production --expect-sha <commit>（宛先は SMOKE_BASE_URL、X-Musubi-Probe は SMOKE_PROBE_TOKEN）
```

§4 の ④（所要時間）は置かない。production には宣言した線が無く、起点のタグの push から承認までの人の待ちが入る。

| 規則（§4 と違うところ） | 理由 |
|---|---|
| 起動は **`v*` タグの push** と、**v タグを選んだ `workflow_dispatch`** だけ。ブランチは前提の確認で落とす | `production` 環境のデプロイ元の制限（`v*` タグ）と揃える。手動実行は、承認を却下した・途中で落ちたタグの再実行に使う |
| ジョブに **`environment: production`** を宣言する | 必須レビュワーの承認待ちがここで入る。本番の Secret は `production` 環境にしか無いので、宣言しないと空になる |
| Cloudflare のトークンと Account ID は **`CLOUDFLARE_API_TOKEN_PROD` / `CLOUDFLARE_ACCOUNT_ID_PROD`**（アカウント②）を、wrangler には `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` として ① ② にだけ渡す | アカウント①（staging）のトークンはどのステップにも渡さない |
| tfstate の backend（R2）の3つは staging と同じリポジトリの Secret を ⓪ にだけ渡す | backend（state の置き場）は production でもアカウント①の R2。⓪ に Cloudflare のトークンは要らない |
| **`terraform plan` / `apply` を行わない**。`TF_CLOUDFLARE_API_TOKEN_PROD` を使わない | GitHub に置いていない。production への apply は人が手元から（#4・§3） |
| `MUSUBI_PROBE_TOKEN` は ② の gateway と host、③ にだけ渡す | 下の「`/healthz` の合言葉」 |
| `concurrency` は `deploy-production` で取り消さない | §4 と同じ。配っている途中で止めない |

それ以外（資格情報は使うステップの `env` にだけ・`vars` を使わない・`environment` に `url` を書かない・wrangler を直接呼ばない・smoke に `--base-url` を使わない）は §4 と同じ。

### `/healthz` の合言葉（`MUSUBI_PROBE_TOKEN`）（2026-09-14 決定）

production の host と gateway は、`X-Musubi-Probe` が Worker の secret `MUSUBI_PROBE_TOKEN` と一致したときだけ `/healthz` の詳細を返す（`03` §5「セキュリティ上の注意」）。
**secret の無い production の host は常に `{"ok":false}`（503）で、貫通スモークが通らない。**

- 合言葉は **`production` 環境の Secret `MUSUBI_PROBE_TOKEN` の1か所だけ**に置く
- **host と gateway へは、deploy のたびに `wrangler deploy --secrets-file` で載せる**（`infra/scripts/deploy-worker.ts`）。**手で `wrangler secret put` をしない**
  - deploy-worker は、詳細を隠す env（`smoke.ts` の `PROBE_REQUIRED_ENVS`）の gateway と host を配るとき、環境変数 `MUSUBI_PROBE_TOKEN` を必須にする。
    無い・ヘッダに載らない文字を含む・**32 文字未満**なら、wrangler を起動せずに exit 1（secret の無い production を配らない）
  - 値は一時ディレクトリ（`$RUNNER_TEMP` の下・0700）のファイル（0600）に JSON で書き、wrangler が終わったらすぐ消す（失敗しても）。ログに出すのは secret の名前だけ。wrangler の子プロセスには環境変数として渡さない
  - wrangler は secret を `env.MUSUBI_PROBE_TOKEN ("(hidden)")` と表示する。伏せる側でも値を持って伏せる
  - `--secrets-file` は足し算で、ファイルに無い secret を消さない
- 貫通スモークには **`SMOKE_PROBE_TOKEN`** として渡す（`--env production` では必須。`infra/scripts/smoke.ts` 冒頭）
- 合言葉を変えるときは、Secret を更新してタグを打ち直す（または同じタグで手動実行する）。host と gateway に同じ値が同時に載る

### 初回デプロイの経路の待ち（貫通スモークの再試行の上限を広げた）

staging の初回デプロイ（2026-09-14）では、host を配った直後の貫通スモークが **4回続けて 404** になり、5回目（約22秒後）で成功した。
新しい Worker の workers.dev の経路が有効になるまでの待ちで、当時の上限（最大5回・5秒間隔・総時間60秒）の**ぎりぎり**だった。
production も初回デプロイなので、**上限つきのまま**広げた（`smoke.ts` の `RETRY_POLICY`。staging と共通）。

| | 旧 | 新 |
|---|---|---|
| 試行の回数の上限 | 5 | **12** |
| 試行の間の待ち | 5 秒 | **10 秒**（待てる幅 110 秒＝実測の約22秒の5倍） |
| 総時間の上限 | 60 秒 | **150 秒** |

- 定期ポーリングではない。ok になった時点で終わるので、平常は1リクエストのまま（`06` §6）
- 待てる幅は `smoke.test.ts` が偽の時計で確かめる（110 秒 404 が続いた後に ok になれば exit 0）
- 失敗したときでも §4 の「main merge → smoke green ≤ 10分」を 2分半しか削らない

### staging から production の資格情報に手が届かない

- `CLOUDFLARE_API_TOKEN_PROD` / `CLOUDFLARE_ACCOUNT_ID_PROD` / `MUSUBI_PROBE_TOKEN` は **`production` 環境の Secret** にだけある。
  読めるのは `environment: production` を宣言したジョブだけで、そのジョブは `v*` タグからしか起動できず、承認が要る
- `deploy-production.yml` 以外のワークフローは、`production` 環境を宣言せず、これらの名前を書かない。
  `deploy-staging.yml` は `SMOKE_PROBE_TOKEN` も渡さない（`deploy-worker.test.ts` が全ワークフローを走査して確かめる）
- `SMOKE_BASE_URL` は staging 環境と production 環境に同じ名前で別の値を置く。どちらが届くかはジョブが宣言した環境で決まる

### PR での確かめ方（実環境に書き込まない）

**2026-09-14・main = `11b7e5b`・wrangler 4.131.1**

| 確かめたこと | 手順 | 結果 |
|---|---|---|
| 3つの Worker を production として配れる | `CLOUDFLARE_ENV=production` でビルドし、各 Worker で `wrangler deploy --dry-run --env production --var GIT_SHA:<sha>`（gateway と host は `--secrets-file` 付き・`WRANGLER_LOG=debug`） | 3つとも exit 0。Cloudflare API へのリクエストは 0 件。gateway と host の binding の表に `env.MUSUBI_PROBE_TOKEN ("(hidden)")`、`HEALTHZ_DETAIL: "probe"` |
| deploy-worker が secret を一時ファイルで渡して消す | `deploy-worker.test.ts`（偽の wrangler と、実物の wrangler の `--dry-run`） | ファイルは 0600・置き場は 0700、終了後に残らない。値は出力に出ない |
| ワークフローの構文 | `actionlint`（shellcheck 込み） | 指摘 0 |
| 前提の確認がブランチ・`v` 以外のタグを落とす | `deploy-worker.test.ts` が前提の確認のスクリプトを bash で動かす | `refs/tags/v0.1.0` だけ exit 0 |

### 前提（🧑 **最初のタグの前**）

- [ ] `production` 環境に Secret **`SMOKE_BASE_URL`**（production の host の workers.dev のオリジン）を登録する
- [ ] `production` 環境に Secret **`MUSUBI_PROBE_TOKEN`** を登録する。**32 文字以上・空白を含まない ASCII**（例：`openssl rand -hex 32`。値をどこにも貼らない）
- [ ] `production` 環境の保護：デプロイ元が `v*` タグだけ・必須レビュワーが Kewton であることを確かめる
- [x] アカウント②に workers.dev のサブドメインがある（2026-09-14 作成・API で確認済み）

無ければ前提の確認で落ち、何も配らない。

**リリース手順（人間の操作）**

```bash
# staging の smoke が green であることを確認してから
git tag -a v0.1.0 -m "M0: platform baseline"
git push origin v0.1.0
# → GitHub Actions が起動 → 🧑 あなたに承認依頼が飛ぶ → Approve でデプロイ
```

### 初回リリース（🧑 タグを打って承認し、監督側が結果を確かめる）

- [ ] タグの push で起動し、**承認待ち（Waiting）で止まる**（承認するまで ⓪ 以降が走らない）
- [ ] ⓪ の乖離チェックが production の state で通る
- [ ] ① ② が `*_PROD` のトークンでアカウント②に書き込める
- [ ] ③ が `--expect-sha` と `X-Musubi-Probe` 付きで green になる（初回の経路の待ちで何回目に通ったかを記録する）
- [ ] ヘッダ無しの `/healthz` が `{"ok":true}` だけを返す
- [ ] ログに workers.dev のホスト名・Account ID・合言葉が出ていない

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
- **例外：`MUSUBI_PROBE_TOKEN`（2026-09-14・#16 で決定）。** production の `/healthz` の合言葉だけは `production` 環境の Secret に1か所で置き、
  deploy のたびに `--secrets-file` で host と gateway に載せる（§5）。host・gateway・貫通スモークの3か所で同じ値が要り、手で置くと食い違うため。
  値はステップの env と一時ファイルにしか現れず、ログに出さない
- M0時点で必要な secret はそれだけ（`GIT_SHA` は `--var` で十分＝公開情報）
- **本番の資格情報は `production` 環境の Secret にだけ置く**（2026-09-14）。`CLOUDFLARE_API_TOKEN_PROD`・
  `CLOUDFLARE_ACCOUNT_ID_PROD`・`MUSUBI_PROBE_TOKEN` は、`environment: production` を宣言し、`v*` タグで起動し、Kewton が承認したジョブからしか読めない。
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
