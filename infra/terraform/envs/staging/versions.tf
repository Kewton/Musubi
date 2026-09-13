terraform {
  required_version = "~> 1.13"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# provider の認証は環境変数 CLOUDFLARE_API_TOKEN で渡す（README §2）。
# provider ブロックに値を書かない＝リポジトリに秘密が入らない。
# alias は使わない。1 state = 1 アカウントに保つ（02 §9）。
provider "cloudflare" {}
