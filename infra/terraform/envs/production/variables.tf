# dev / staging と変数名を分けてある（02 §9）。dev の作業で export した TF_VAR_account_id が
# 残っていても production には流れず、TF_VAR_account_id_prod を渡し忘れれば plan が止まる。
variable "account_id_prod" {
  description = "アカウント②の ID。TF_VAR_account_id_prod で渡す（README §2）。"
  type        = string
  sensitive   = true
}
