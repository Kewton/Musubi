terraform {
  required_version = "~> 1.13"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # v4 → v5 でリソース名・属性名が変わっている（02 §4）。
      # 実際に使う名前は `terraform providers schema -json` で照合済み（README §5）。
      version = "~> 5.0"
    }
  }
}
