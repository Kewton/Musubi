# 環境側は薄い。差分は引数だけで、資源の定義はモジュールが持つ（02 §5 / §9）。
# apply は Issue #4（🧑 承認必須）。production では terraform destroy を実行しない（02 §8）。
module "env" {
  source = "../../modules/musunest-env"

  account_id = var.account_id_prod
  env        = "production"

  wfp_enabled = false # M0〜M4 は false 固定（有償。06 §5 の W-1 / W-2 で解禁）
}
