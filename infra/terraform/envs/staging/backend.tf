# state はアカウント①の R2 バケット musubi-tfstate に置く。
# 環境ごとに key を分ける＝環境ごとに別 state。workspace 機能は使わない——
# dev の destroy が prod に触れる事故経路を物理的に断つため（02 §2）。
terraform {
  backend "s3" {
    bucket = "musubi-tfstate"
    key    = "staging/terraform.tfstate"
    region = "auto"

    # endpoints.s3 はアカウント ID を URL に含むのでここに書かない。
    # 環境変数 AWS_ENDPOINT_URL_S3 で渡す（README §2）。

    # R2 は S3 互換だが AWS 固有の検証を通らないため全部スキップする。
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

    # R2 の条件付き PUT を使った state ロック。DynamoDB は使わない（使えない）。
    use_lockfile = true
  }
}
