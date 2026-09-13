# ★この形が infra:sync（sync-bindings・Issue #5）の入力である。02 §5 の schema。
#   キーを勝手に増やさない・減らさない・改名しない。
#
#   wfp_namespace_name / turnstile_sitekey は「まだ資源が無い」ことを null で表す。
#   WfP は wfp_enabled = false 固定で count = 0 なので one() が null を返す。
#   Turnstile は custom_domain_enabled 待ち。
#   資源が入る時も schema は変えず、この2つの値だけが null から埋まる。
output "bindings" {
  description = "wrangler.jsonc へ同期する値。terraform output -json bindings で取り出す。"

  # account_id が sensitive なので、それを含むこの map も sensitive になる。
  # -json では値が読める（sync-bindings はそれを使う）が、ログへ流さないこと（04 §3.1）。
  sensitive = true

  value = {
    env                = var.env
    account_id         = var.account_id
    d1_control_id      = cloudflare_d1_database.control.id
    d1_control_name    = cloudflare_d1_database.control.name
    r2_bundles_name    = cloudflare_r2_bucket.bundles.name
    r2_uploads_name    = cloudflare_r2_bucket.uploads.name
    queue_build_name   = cloudflare_queue.build.queue_name
    wfp_namespace_name = one(cloudflare_workers_for_platforms_dispatch_namespace.apps[*].name)
    turnstile_sitekey  = null
  }
}
