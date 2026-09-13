# infra/terraform

アカウント単位資源の IaC（手順書 `workspace/mvp/m0/02-terraform.md`）。

IaC二層の上側。ここに置くのは「アカウントに属し、サービスより長生きするもの」。
サービス単位の設定（ルート・バインディング・互換性日付）は各パッケージの
`wrangler.jsonc` 側に置く。**越境しない。**

---

## 1. 何を Terraform が持ち、何を持たないか

| | 正本 | 管理対象 | いまの実装 |
|---|---|---|---|
| **持つ** | `infra/terraform/` | D1 database | `musubi-<env>-control`（Control Plane 専用。アプリのデータは DO/SQLite） |
| **持つ** | 〃 | R2 bucket | `musubi-<env>-bundles` / `musubi-<env>-uploads` |
| **持つ** | 〃 | Queues | `musubi-<env>-build`（M0 では器だけ。consumer は付けない） |
| **持つ** | 〃 | KV 名前空間 | `musubi-<env>-kv`（用途未定の器。namespace id は `bindings` に出していない——出し方は Issue #5 で決める） |
| **持つ（`count = 0`）** | 〃 | WfP dispatch namespace | `musubi-<env>-apps`。`wfp_enabled` を validation で `false` に固定しているので作られない。解禁は M5〜M6（`06` §5 W-1 / W-2） |
| **持つ（未実装）** | 〃 | Turnstile widget / DNS レコード | `custom_domain_enabled` 待ち（H-04 ドメイン取得後） |
| **持たない** | `wrangler.jsonc` | Worker script 本体 | `cloudflare_workers_script` は**使わない**。デプロイは wrangler が唯一の経路 |
| **持たない** | 〃 | bindings・routes・compatibility date・secrets 参照 | 二重管理はドリフトの温床 |
| **持たない** | 〃 | Durable Object のクラスと migration | `deleted_classes` を含め wrangler 側（`03` §4） |
| **持たない** | — | Logpush | 有償。観測は Workers Logs（`observability.enabled`）で賄う（`06` §2） |

名前の `musubi` は変数 `name_prefix` の既定値である（§7）。

**迷ったときの原則**

- 「Worker を消しても残るべきもの」＝ Terraform（データの器・名前空間・DNS）
- 「Worker と一緒に生まれ死ぬもの」＝ wrangler（コード・結線）

---

## 2. 実行手順（dev）

**必要な資格情報はすべて環境変数で渡す。リポジトリには1つも置かない。**
`.env`（Git 管理外・0600）に揃っている。worktree で作業するときは先に
`./infra/scripts/link-env.sh` を実行して primary の `.env` へ symlink を張ること。

```bash
set -a; . "$(git rev-parse --show-toplevel)/.env"; set +a

export CLOUDFLARE_API_TOKEN="$TF_CLOUDFLARE_API_TOKEN"   # provider 認証（アカウント①）
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"             # backend 認証（R2 の S3 キー）
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_ENDPOINT_URL_S3="$R2_S3_ENDPOINT"             # backend の endpoint（§3）
export TF_VAR_account_id="$CLOUDFLARE_ACCOUNT_ID"        # 資源を作るアカウント

cd infra/terraform/envs/dev
terraform init
terraform validate
terraform plan -out=tfplan
terraform apply tfplan

terraform output -json bindings    # ← infra:sync（Issue #5）が食う形
```

**apply したら、その場で wrangler.jsonc へ書き戻してコミットする**（2026-09-13 決定・`03` §3）。
これを怠ると、次のデプロイ直前の乖離チェック（`04` §4・§5）でデプロイが止まる。

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm infra:sync --env <env>           # Terraform 由来の欄だけを書き戻す（冪等。値はログに出ない）
pnpm infra:sync --env <env> --check   # exit 0 を確かめる
git add apps/*/wrangler.jsonc packages/data-api/wrangler.jsonc
git commit -m "chore: <env> の apply 後に wrangler.jsonc を terraform output へ同期"
```

> D1 は作り直すと `database_id` が変わる（§4）。**dev の destroy → apply のたびにも同じ手順が要る。**

**staging / production も同じ手順で、違うのは次の行だけ。** backend（state）は3環境ともアカウント①なので、
`AWS_*` の3行は変えない。apply は Issue #4（production は 🧑 承認必須）。

| 環境 | `cd` | provider 認証 | アカウント ID |
|---|---|---|---|
| staging | `envs/staging` | `CLOUDFLARE_API_TOKEN="$TF_CLOUDFLARE_API_TOKEN"` | `TF_VAR_account_id="$CLOUDFLARE_ACCOUNT_ID"` |
| production | `envs/production` | `CLOUDFLARE_API_TOKEN="$TF_CLOUDFLARE_API_TOKEN_PROD"` | **`TF_VAR_account_id_prod`**`="$CLOUDFLARE_ACCOUNT_ID_PROD"` |

production だけ変数名を `account_id_prod` に分けてある（`02` §9）。dev の作業で export した
`TF_VAR_account_id` が残っていても production には流れず、`TF_VAR_account_id_prod` を渡し忘れると
`-input=false` の plan は `No value for required variable` で止まる（実測）。

**backend の認証（R2 の S3 キー）と provider の認証（CF API トークン）は別系統である。**
だから「state はアカウント①、資源はアカウント②」が素直に書ける（`02` §9）。

> **値を echo / env / set -x で出さない。** public リポジトリなので、ログも PR コメントも
> アーティファクトも全部公開される。`account_id` は `sensitive = true` にしてあるので
> plan 出力では `(sensitive value)` になるが、`terraform output -json` は生の値を出す（`04` §3.1）。

---

## 3. backend（tfstate = R2 / S3互換）

- バケットは**アカウント①の `musubi-tfstate`**。環境ごとに key を分ける（`dev/terraform.tfstate`）
- **workspace 機能は使わない。** dev の destroy が prod に触れる事故経路を物理的に断つ（`02` §2）
- `endpoints.s3` は **URL にアカウント ID を含むので `backend.tf` に書かない。**
  `AWS_ENDPOINT_URL_S3` で渡す（Terraform 1.16.2 の s3 backend が読むことを実測）。
  **CI で `terraform init` する時も同じ環境変数が要る**（`04` §3 のワークフローに足すこと）
- ロックは R2 の条件付き PUT を使う `use_lockfile = true`。DynamoDB は使わない（使えない）。
  Terraform 1.16.2 × R2 で init / plan / apply / destroy が通ることを実測した
- R2 はバージョニング未対応。apply 前後の state 退避・復元手順は Issue #4 で実装する

---

## 4. destroy → apply（dev だけの日常運用）

**dev だけは「壊して直す」を日常化する。** staging / production では `terraform destroy` を
実行しない。CI にも destroy ジョブを作らない（`02` §8）。

```bash
terraform destroy -auto-approve && terraform apply -auto-approve
```

**2026-09-13（JST）の実測（Issue #2 の DoD）**

| 段 | exit | 所要 |
|---|---|---|
| `terraform destroy -auto-approve`（4 destroyed） | 0 | 3s |
| `terraform init -input=false` | 0 | 1s |
| `terraform validate` | 0 | 0s |
| `terraform plan -input=false -out=tfplan`（4 to add） | 0 | 1s |
| `terraform apply tfplan`（4 added） | 0 | 2s |
| **合計** | | **7 秒**（DoD の線 15 分に対して十分） |

再現後に `terraform plan -detailed-exitcode` が **0（No changes）**。
**ダッシュボード操作は0回。** 上の表のコマンド以外は実行していない。

**往復で変わるもの・変わらないもの**

| | 往復後 |
|---|---|
| D1 の `database_id` | **変わる**（実測で別 UUID になった）。だから `infra:sync`（Issue #5）が要る。**人手でコピペしない** |
| リソース名（D1 / R2×2 / Queue） | 変わらない |
| R2 の `location` | **初回作成時しか効かない。** 同名で作り直すと元のロケーションのまま（provider のドキュメント記載） |

**詰まりうる箇所**

| 資源 | 詰まり方 | 対処 |
|---|---|---|
| R2 bucket | オブジェクトが残っていると destroy が失敗する。provider v5 に `force_destroy` 相当は**無い** | destroy 前に空にする。空バケットでの destroy は実測で成功 |
| Queue | consumer が残っていると削除できない | Worker を先に消す。`deploy` → `destroy` の順を守る |
| Durable Object | Terraform 管理外。クラス削除には `deleted_classes` migration が要る | wrangler 側（`03` §4） |

---

## 5. provider のピン（v4 → v5 の差分に注意）

- `required_version = "~> 1.13"`（`.terraform-version` は 1.16.2）
- `cloudflare/cloudflare ~> 5.0`。**`.terraform.lock.hcl` はコミットする**（v5.25.0 を SHA で固定）
- lock には **`darwin_arm64` と `linux_amd64` の両方**の `h1:` を入れてある
  （`terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`）。
  手元は mac・CI は linux なので、片方だけだと CI の `init` が lock を書き換える
- staging / production の lock は dev の lock を置いてから `terraform init -backend=false` →
  `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64` で検証したもので、
  **3環境とも byte 単位で同一**（どれかを上げるときは3つとも上げる）
- provider の `alias` は**使わない**。1 state = 1 アカウントに保つ

**手順書（`02` §5）の HCL は設計意図であって、v5 の綴りではない。**
`terraform providers schema -json` で照合した結果、次が違った。

| 手順書 | v5.25.0 の実際 |
|---|---|
| `cloudflare_queue` の `name` | **`queue_name`**。`name` は存在しない |
| `cloudflare_r2_bucket` の `location = "APAC"` | **小文字の `"apac"`**（`apac` / `eeur` / `enam` / `weur` / `wnam` / `oc`） |
| `cloudflare_d1_database`（`read_replication` の指定なし） | **明示しないと apply 直後の plan が永久に `1 to change` になる。** API が返す `{mode = "disabled"}` を provider が「消す差分」と読むため。`read_replication = { mode = "disabled" }` を書いて No changes に落としてある |

新しいリソースを足すときも、**まず `terraform providers schema -json` で実在と綴りを確認すること。**

---

## 6. 環境

| 環境 | アカウント | state key | 状態 |
|---|---|---|---|
| `envs/dev` | ① | `dev/terraform.tfstate` | **apply 済み**（Issue #2） |
| `envs/staging` | ① | `staging/terraform.tfstate` | 定義済み・**未 apply**。apply は Issue #4 |
| `envs/production` | ② | `production/terraform.tfstate` | 定義済み・**未 apply**。apply は Issue #4（🧑 承認必須） |

構成は3環境とも**同一モジュール**で、差分は引数だけ（アカウント ID / `env` / `wfp_enabled`。
`custom_domain_enabled` は H-04 のドメイン取得後に足す）。`CLOUDFLARE_API_TOKEN` は環境ごとに切り替える
（CI では `..._PROD` を渡す。`04` §5）。

---

## 7. リソース名の prefix（`name_prefix`）

名称変更（N-1）に備えて、`musubi-` をモジュール変数 `name_prefix`（既定値 `"musubi"`）にしてある。
3環境で揃えるものなので、env 側からは渡していない。

- **変数化そのものは資源名を変えない。** 既定値のまま dev に `terraform plan -detailed-exitcode` を
  かけて **exit 0（No changes）** を実測した（2026-09-13・Issue #3）
- **既定値を変えるのは資源名を変える操作である。** 既定値を検証用のダミー値に変えて dev を plan だけすると
  次の差分になった（exit 2。apply はしていない。検証後に既定値を戻して exit 0 を再確認）

  | 資源 | plan の結果 |
  |---|---|
  | D1 `control` | **must be replaced**（`database_id` が変わり、中身は消える） |
  | R2 `bundles` / `uploads` | **must be replaced**（オブジェクトが残っていると destroy で止まる。§4） |
  | Queue `build` | update in-place |

  staging / production に実データが入ってから変えるなら、データ移行の手順を先に作ること
- **`name_prefix` が届かない名前がある。** tfstate バケット `musubi-tfstate` と state の key は
  `backend` ブロックに変数を書けないので対象外。Worker 名（`musubi-<env>-data-api` 等）は
  `wrangler.jsonc` 側の正本なので、これも Terraform の外で変える
