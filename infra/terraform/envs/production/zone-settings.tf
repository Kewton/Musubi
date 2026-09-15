# production のゾーン（musunest.com）の設定（Issue #33）。ゾーンの取得は dns.tf の data "cloudflare_zone" "main"。
#
# 独自ドメイン（app.musunest.com）を暗号化なしで受けない：
#   always_use_https … http:// で来たリクエストを https:// へ転送する（2026-09-15 時点の値は off）
#   min_tls_version  … TLS 1.2 未満を拒否する（同 1.0）
#
# HSTS（security_header）はまだ入れない。ブラウザに長く残り、戻すのが難しいので、ログイン（M2）を入れるときに決める。
# 権限：Zone: Zone Settings: Edit（Terraform 用トークン②。README §2）。

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = data.cloudflare_zone.main.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = data.cloudflare_zone.main.zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}
