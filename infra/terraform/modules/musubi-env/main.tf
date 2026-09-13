# 1環境ぶんのアカウント単位資源（02 §1 の表の「Terraform」列）。
#
# ここに置かないもの:
#   - Worker script … wrangler が唯一のデプロイ経路（02 §1）
#   - bindings / routes / compatibility date … 各 wrangler.jsonc（02 §1）
#   - Durable Object のクラスと migration … wrangler 側（03 §4）
#   - Logpush … 有償なので作らない。観測は observability.enabled で賄う（06 §2）

locals {
  # 全リソース名をこれで揃える。既定では "musubi-<env>" で、変数化の前後で名前は変わらない。
  p = "${var.name_prefix}-${var.env}"
}

# ── Control Plane DB。D1 は Control 専用で、アプリのデータは DO(SQLite) に置く
resource "cloudflare_d1_database" "control" {
  account_id = var.account_id
  name       = "${local.p}-control"

  # 省略すると API が返す {mode = "disabled"} を provider が「消す差分」と見なし、
  # apply 直後の plan が永久に 1 to change になる（provider 5.25.0 で実測）。
  # 明示して No changes に落とす。Free でレプリカは作らない。
  read_replication = {
    mode = "disabled"
  }
}

# ── 生成 bundle の置き場（納品単位＝R2 bundle）
resource "cloudflare_r2_bucket" "bundles" {
  account_id = var.account_id
  name       = "${local.p}-bundles"
  location   = "apac"
}

# ── ユーザーがアップロードしたファイルの置き場
resource "cloudflare_r2_bucket" "uploads" {
  account_id = var.account_id
  name       = "${local.p}-uploads"
  location   = "apac"
}

# ── Connector 用 Queue。M0 では器だけ作る（consumer は付けない）
resource "cloudflare_queue" "build" {
  account_id = var.account_id
  queue_name = "${local.p}-build"
}

# ── KV 名前空間。用途は未定なので M0 では器だけ作る（Queue と同じ扱い）
#    用途が決まったら用途名へ改名する。namespace id は bindings に出していない——
#    wrangler.jsonc への出し方は infra:sync（Issue #5）で決める（2026-09-13 決定）。
resource "cloudflare_workers_kv_namespace" "kv" {
  account_id = var.account_id
  title      = "${local.p}-kv"
}

# ── Workers for Platforms（L3 server functions / Form B）。M0〜M4 は作らない
#    wfp_enabled は validation で false 固定（variables.tf）。定義だけ残し、解禁時の差分を小さくする。
resource "cloudflare_workers_for_platforms_dispatch_namespace" "apps" {
  count      = var.wfp_enabled ? 1 : 0
  account_id = var.account_id
  name       = "${local.p}-apps"
}
