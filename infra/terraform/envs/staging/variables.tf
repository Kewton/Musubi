variable "account_id" {
  description = "アカウント①の ID（dev と同じアカウント）。TF_VAR_account_id で渡す（README §2）。"
  type        = string
  sensitive   = true
}
