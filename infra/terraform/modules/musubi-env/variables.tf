variable "account_id" {
  description = "資源を作る Cloudflare アカウントの ID。値はリポジトリに置かず TF_VAR_account_id で渡す。"
  type        = string

  # public リポジトリなので plan 出力を (sensitive value) に潰す（04 §3.1 規律1）。
  sensitive = true
}

variable "env" {
  description = "環境名。全リソース名の prefix `musubi-<env>-` になる。"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "production"], var.env)
    error_message = "env は dev / staging / production のいずれかであること。"
  }
}
