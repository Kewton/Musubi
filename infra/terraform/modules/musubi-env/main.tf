# 1環境ぶんのアカウント単位資源（02 §1 の表の「Terraform」列）。
#
# ここに置かないもの:
#   - Worker script … wrangler が唯一のデプロイ経路（02 §1）
#   - bindings / routes / compatibility date … 各 wrangler.jsonc（02 §1）
#   - Durable Object のクラスと migration … wrangler 側（03 §4）
#   - Logpush … 有償なので作らない。観測は observability.enabled で賄う（06 §2）

locals {
  p = "musubi-${var.env}"
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
