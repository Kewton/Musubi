variable "account_id" {
  description = "資源を作る Cloudflare アカウントの ID。値はリポジトリに置かず TF_VAR_* で渡す。"
  type        = string

  # public リポジトリなので plan 出力を (sensitive value) に潰す（04 §3.1 規律1）。
  sensitive = true
}

variable "env" {
  description = "環境名。全リソース名の `<name_prefix>-<env>-` の部分になる。"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "production"], var.env)
    error_message = "env は dev / staging / production のいずれかであること。"
  }
}

# 名称変更（N-1）に備えて prefix を変数にしてある（02 §6 の H-05 行）。
# **既定値を変えることは資源名を変えることであり、D1 / R2 は作り直しになる**
# （D1 は database_id が変わり中身が消える）。変える前に README §7 を読むこと。
variable "name_prefix" {
  description = "全リソース名の先頭。`<name_prefix>-<env>-<用途>` になる。"
  type        = string
  default     = "musunest"

  validation {
    # R2 bucket 名の制約（小文字英数とハイフン・先頭末尾は英数・63文字以内）に合わせる。
    # 最長の名前は `<name_prefix>-production-uploads`（prefix + 19文字）なので prefix は 44 文字まで。
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.name_prefix)) && length(var.name_prefix) <= 44
    error_message = "name_prefix は小文字英数とハイフン（先頭末尾は英数）で 44 文字以内であること。"
  }
}

# Workers for Platforms は有償で、MVP の3アプリ（すべて L2）には要らない（06 §3）。
# リソース定義は count = 0 で残し、解禁時にこの validation を外して true にするだけで入るようにしてある。
variable "wfp_enabled" {
  description = "WfP dispatch namespace を作るか。M0〜M4 は false 固定。"
  type        = bool
  default     = false

  validation {
    # 解禁条件は 06 §5 の W-1 / W-2。条件に触れたら、この validation を消す PR で true にする。
    condition     = var.wfp_enabled == false
    error_message = "wfp_enabled は false 固定（Free 前提・06 §5 W-1 / W-2 に触れるまで WfP を使わない）。"
  }
}
