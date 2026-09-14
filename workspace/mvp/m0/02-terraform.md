# 02：Terraform — アカウント単位資源のIaC化（**最初のIssue #1**）

> 対応DoD：**M0-3 Cloudflare IaC化 — dev/staging/prodを手作業ゼロで再現**
> 企画書22章の指定：**「最初のIssue：#1 Terraformでdev環境をゼロから再現」**
> 前提：🧑 H-14（アカウント分離の判断）／H-01（アカウント）／H-02①（Terraformトークン）／H-03（tfstateバケット）
> 担当：🤖（staging/prod の apply 承認のみ 🧑）
> **プラン前提：Cloudflare Free（$0）**。WfP は使わない → [`06-plan-and-limits.md`](./06-plan-and-limits.md)

---

## 1. 二層の境界（越えない線）

企画書11章の確定事項。**この表に無いものをTerraformに入れない／wranglerに入れない。**

| 層 | 正本 | 管理対象 |
|---|---|---|
| **Terraform** | `infra/terraform/` | **アカウント単位資源**：D1 database・R2 bucket・Queues・DNSレコード・Turnstile widget・（WfP dispatch namespace＝M5以降）。**Logpush は有償なので作らない**——観測は Workers Logs（`observability.enabled`＝wrangler側）で賄う（→ `06` §2） |
| **wrangler.jsonc** | 各Workerディレクトリ | **サービス単位**：Worker本体・bindings（どのD1/R2/DO/Serviceに繋ぐか）・routes・compatibility date・DO migrations・secrets参照 |

**判断に迷ったときの原則**
- 「Workerを消しても残るべきもの」＝ Terraform（データの器・名前空間・DNS）
- 「Workerと一緒に生まれ死ぬもの」＝ wrangler（コード・結線）

> **Worker script 自体を Terraform で作らない。** `cloudflare_workers_script` は使わない。デプロイは wrangler が唯一の経路（CIから）。二重管理はドリフトの温床になる。

---

## 2. ディレクトリ構成

```
infra/terraform/
├─ modules/
│  └─ musubi-env/            # 1環境ぶんの資源セット（dev/staging/prod で共有）
│     ├─ main.tf
│     ├─ variables.tf
│     ├─ outputs.tf
│     └─ versions.tf
├─ envs/
│  ├─ dev/{main.tf, backend.tf, terraform.tfvars}
│  ├─ staging/{...}
│  └─ production/{...}
└─ README.md
```

**環境ごとに別 state**（`envs/*/backend.tf` で key を分ける）。workspace機能は使わない——**dev の destroy が prod に触れる事故経路を物理的に断つ**ため。

---

## 3. backend（tfstate = R2 / S3互換）

```hcl
# infra/terraform/envs/dev/backend.tf
terraform {
  backend "s3" {
    bucket = "musubi-tfstate"
    key    = "dev/terraform.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com"
    }

    # R2 は S3互換だが AWS 固有の検証を通らないため全部スキップする
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
```

認証は環境変数で渡す（コミットしない）：

```bash
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export CLOUDFLARE_API_TOKEN="$TF_CLOUDFLARE_API_TOKEN"
```

> **要確認**：`skip_s3_checksum` は Terraform 1.6+／AWS provider 5.x 以降の挙動に依存する。使用する Terraform バージョンで `terraform init` が通ることを最初に確認すること。通らない場合の代替は「tfstate をローカル＋暗号化してGit管理外」ではなく、**Terraform Cloud の無料枠**を検討する（stateをローカルに置く選択はしない）。

---

## 4. provider のピン

```hcl
# infra/terraform/modules/musubi-env/versions.tf
terraform {
  required_version = "~> 1.13"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"   # ★着手時の最新メジャーに固定し、.terraform.lock.hcl をコミットする
    }
  }
}
```

> ⚠️ **重要な注意**：Cloudflare provider は **v4 → v5 でリソース名・属性名が大きく変わった**（例：`cloudflare_record` → `cloudflare_dns_record`、`cloudflare_workers_for_platforms_namespace` → `cloudflare_workers_for_platforms_dispatch_namespace` 等）。
> **以下のHCLは設計意図を示すものであり、リソース名・属性名は必ず「固定したバージョンの公式ドキュメント」で照合してから使うこと。** 最初のタスクは `terraform providers schema -json` で実在を確認することから始める。

---

## 5. モジュール本体（設計）

```hcl
# infra/terraform/modules/musubi-env/variables.tf
variable "account_id"  { type = string }
variable "env"         { type = string }            # dev | staging | production
variable "zone_id"     { type = string, default = "" }
variable "custom_domain_enabled" { type = bool, default = false }
variable "root_domain" { type = string, default = "" }  # musubi.app
```

```hcl
# infra/terraform/modules/musubi-env/main.tf
locals {
  p = "musubi-${var.env}"       # prefix。全リソース名をこれで揃える
}

# ── Control Plane DB（D1は Control 専用・企画書9章）
resource "cloudflare_d1_database" "control" {
  account_id = var.account_id
  name       = "${local.p}-control"
}

# ── 生成bundle / ファイル置き場（R2・企画書12章「納品単位＝R2 bundle」）
resource "cloudflare_r2_bucket" "bundles" {
  account_id = var.account_id
  name       = "${local.p}-bundles"
  location   = "APAC"
}

resource "cloudflare_r2_bucket" "uploads" {
  account_id = var.account_id
  name       = "${local.p}-uploads"
  location   = "APAC"
}

# ── Workers for Platforms（L3 server functions / Form B・企画書11章）
#    ★ M0〜M4 は wfp_enabled = false で固定。WfP は $25/月の有償のみで、
#      企画書12章「L1-L2ではコードを1行も生成しない」により MVP 3アプリには不要（→ 06 §3）。
#      リソース定義は残す（count=0）。L3解禁時（M5〜M6）に true にするだけで入る。
resource "cloudflare_workers_for_platforms_dispatch_namespace" "apps" {
  count      = var.wfp_enabled ? 1 : 0
  account_id = var.account_id
  name       = "${local.p}-apps"
}

# ── Connector 用 Queue（企画書11章。M0では器だけ作る）
resource "cloudflare_queue" "build" {
  account_id = var.account_id
  name       = "${local.p}-build"
}

# ── abuse対策：Turnstile（ゲストclaim画面・企画書11章。M4本運用）
resource "cloudflare_turnstile_widget" "guest_claim" {
  count      = var.custom_domain_enabled ? 1 : 0
  account_id = var.account_id
  name       = "${local.p}-guest-claim"
  domains    = [var.root_domain]
  mode       = "managed"
}

# ── DNS（🧑 H-04 未完なら custom_domain_enabled = false で丸ごとスキップ）
resource "cloudflare_dns_record" "host" {
  count   = var.custom_domain_enabled ? 1 : 0
  zone_id = var.zone_id
  name    = var.env == "production" ? "app" : "stg"
  type    = "AAAA"
  content = "100::"          # Cloudflare の discard prefix（Worker routeで受ける定石）
  proxied = true
  ttl     = 1
}
```

```hcl
# infra/terraform/modules/musubi-env/outputs.tf
#   ★ここが 03 の sync-bindings の入力になる。出力の形を勝手に変えない。
output "bindings" {
  value = {
    env                 = var.env
    account_id          = var.account_id
    d1_control_id       = cloudflare_d1_database.control.id
    d1_control_name     = cloudflare_d1_database.control.name
    r2_bundles_name     = cloudflare_r2_bucket.bundles.name
    r2_uploads_name     = cloudflare_r2_bucket.uploads.name
    queue_build_name    = cloudflare_queue.build.name
    wfp_namespace_name  = try(cloudflare_workers_for_platforms_dispatch_namespace.apps[0].name, null)
    turnstile_sitekey   = try(cloudflare_turnstile_widget.guest_claim[0].id, null)
  }
}
```

環境側は薄く：

```hcl
# infra/terraform/envs/dev/main.tf
module "env" {
  source     = "../../modules/musubi-env"
  account_id = var.account_id
  env        = "dev"
  wfp_enabled           = false   # M0〜M4 は false 固定（有償・→ 06 §5 の W-1/W-2 で解禁）
  custom_domain_enabled = false   # dev は workers.dev のまま
}
output "bindings" { value = module.env.bindings }
```

---

## 6. 🧑 H-04 / H-09 未完でもM0を止めない設計

| 未完の人間タスク | 回避策 | 後で入れる手順 |
|---|---|---|
| H-04 ドメイン未取得 | `custom_domain_enabled = false`。全Workerを `*.workers.dev` で運用 | tfvars を `true` に → `terraform apply` → wrangler の `routes` を追加 |
| H-09 WfP（**有償・M0では使わない**） | `wfp_enabled = false` 固定。MVP 3アプリは全部L2なので不要（→ `06` §3） | L3解禁時に Workers Paid ＋ WfP 契約 → tfvars を `true` に → `terraform apply` |
| H-05 商標未決着 | ドメイン購入を保留。リソース名の `musubi-` prefix は変数化しておく | prefix変数を差し替えて再applyできる状態を保つ |

> **回避策を使ったら必ず Issue を立てて `blocked` ラベルを付ける。** 忘れると M1 で詰まる。

---

## 7. 実行手順（Issue #1「Terraformでdev環境をゼロから再現」）

```bash
cd infra/terraform/envs/dev

export CLOUDFLARE_API_TOKEN="$TF_CLOUDFLARE_API_TOKEN"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

terraform init
terraform validate
terraform plan  -out=tfplan
terraform apply tfplan

# 出力を確認（03 の sync-bindings が食う形）
terraform output -json bindings
```

**Issue #1 のDoD**
- [ ] `terraform apply` で dev の全資源が作られる
- [ ] `terraform destroy` → `terraform apply` を実行し、**同一構成が再現される**
- [ ] 上記の往復に**ダッシュボード操作が1回も含まれない**
- [ ] `terraform output -json bindings` が `03` の期待スキーマに一致する
- [ ] `.terraform.lock.hcl` がコミットされている

---

## 8. destroy で詰まる箇所（先に潰しておく）

| 資源 | 詰まり方 | 対処 |
|---|---|---|
| **R2 bucket** | オブジェクトが残っていると destroy 失敗 | dev のみ `force_destroy = true` 相当の挙動を確認（provider が未対応なら destroy 前に `wrangler r2 object delete` で空にする pre-hook スクリプトを `infra/scripts/` に置く） |
| **D1 database** | 削除後に同名で再作成すると **ID が変わる** | だから `03` の `sync-bindings` が必須。IDを人手でコピペしない |
| **Durable Object** | クラス削除には `deleted_classes` migration が必要 | Terraform管理外（wrangler側）。`03` §4 参照 |
| **Queue** | consumer が残っていると削除失敗 | Worker を先に消す。destroy 順序を Terraform に任せず、`deploy` → `destroy` の順を runbook に書く |

> **dev だけは「壊して直す」を日常化する。** staging/prod では `terraform destroy` を禁止し、CIからも実行できないようにする（`04` のワークフローに destroy ジョブを作らない）。

---

## 9. staging / production

- 構成は dev と**同一モジュール**。差分は tfvars のみ（`custom_domain_enabled`, `wfp_enabled`, DNS名, `account_id`）
- `production` の apply は **🧑 人間の承認必須**。CI からは apply しない。人が立ち会って手元から行い、前後で state を退避する（`infra/terraform/README.md` §3。2026-09-14 の初回は #4）
- `terraform plan` は PR時に自動実行し、**plan結果をPRコメントに貼る**（`04` §3）

### 🧑 H-14 で production を別アカウントにした場合

Free の上限はアカウント単位なので、production を別アカウントに置くのが推奨（→ `06` §4.3）。Terraform側の対応は**驚くほど小さい**——モジュールが最初から `account_id` を変数で受けているため。

```hcl
# infra/terraform/envs/production/main.tf
module "env" {
  source     = "../../modules/musubi-env"
  account_id = var.account_id_prod      # ← アカウント②のID
  env        = "production"
  ...
}
```

```hcl
# infra/terraform/envs/production/backend.tf
terraform {
  backend "s3" {
    bucket = "musubi-tfstate"           # ← state は アカウント① のバケットで良い
    key    = "production/terraform.tfstate"
    ...
  }
}
```

**要点**
- **backend の認証（R2 S3キー）と provider の認証（CF APIトークン）は別系統**。だから「stateはアカウント①、資源はアカウント②」が素直に書ける
- `CLOUDFLARE_API_TOKEN` 環境変数は環境ごとに切り替える（CI では `..._PROD` を渡す。`04` §5）
- provider の `alias` は**使わない**。1 state = 1 アカウント に保つほうが、誤って prod に dev の変更を当てる経路が消える
- **`terraform destroy` は production では実行しない**（§8 と同じ規律。アカウントが分かれていれば、事故が起きても dev の destroy は prod に届かない）

---

## 10. このステップのDoD

- [ ] `envs/dev`・`envs/staging`・`envs/production` の3つが `terraform plan` を通る
- [ ] dev で destroy→apply の往復が成功（Issue #1 クローズ）
- [x] staging / production が apply 済み（2026-09-14・#4）
- [x] `terraform plan` が3環境すべてで **No changes**（＝ドリフトなし。2026-09-14 に3環境とも exit 0 を実測）
- [ ] `infra/terraform/README.md` に「何をTerraformが持ち、何を持たないか」の表がある
