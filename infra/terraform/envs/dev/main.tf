# 環境側は薄い。差分は引数だけで、資源の定義はモジュールが持つ（02 §5）。
module "env" {
  source = "../../modules/musubi-env"

  account_id = var.account_id
  env        = "dev"
}
