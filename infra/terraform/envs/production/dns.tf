# production のゾーン（musunest.com）の DNS レコード（Issue #33）。ゾーンはアカウント②にある（Cloudflare Registrar で登録）。
#
# ここに置くのは「Worker を消しても残るべきもの」だけ（README §1）。
#   - host の独自ドメイン（app.musunest.com）は置かない。apps/host/wrangler.jsonc の routes（custom domain）が正本で、
#     wrangler deploy が DNS レコードと証明書を作る（二重管理にしない）
#
# このドメインはメールを送受信しない。第三者が @musunest.com を名乗って送るのを受信側に拒否させる：
#   SPF     … 送信を許すサーバは無い（-all）
#   DMARC   … SPF / DKIM に合格しないメールは reject（サブドメインも同じ）
#   null MX … 受信するサーバが無い（RFC 7505）
#
# 権限：data "cloudflare_zone" に Zone: Read、レコードに Zone: DNS: Edit（Terraform 用トークン②。README §2）。ゾーンの設定は zone-settings.tf。
# TXT の値は引用符で囲んで書く（Cloudflare は囲まない TXT に警告を出し、囲んだ形で持つ）。

locals {
  zone_name = "musunest.com"
}

data "cloudflare_zone" "main" {
  filter = {
    name    = local.zone_name
    account = { id = var.account_id_prod }
  }
}

resource "cloudflare_dns_record" "spf" {
  zone_id = data.cloudflare_zone.main.zone_id
  name    = local.zone_name
  type    = "TXT"
  content = "\"v=spf1 -all\""
  ttl     = 1
  comment = "メールを送らない（Issue #33）"
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = data.cloudflare_zone.main.zone_id
  name    = "_dmarc.${local.zone_name}"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s\""
  ttl     = 1
  comment = "なりすましを拒否させる（Issue #33）"
}

resource "cloudflare_dns_record" "null_mx" {
  zone_id  = data.cloudflare_zone.main.zone_id
  name     = local.zone_name
  type     = "MX"
  content  = "."
  priority = 0
  ttl      = 1
  comment  = "メールを受けない（RFC 7505。Issue #33）"
}
