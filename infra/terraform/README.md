# infra/terraform

アカウント単位の資源（`02-terraform.md`）。M0-2 で実装する。

IaC二層の上側。ここに置くのは「アカウントに属し、サービスより長生きするもの」：
D1 データベース、R2 バケット、Queues、KV 名前空間、（H-04 後に）DNS レコード。

サービス単位の設定（ルート・バインディング・互換性日付）は各パッケージの
`wrangler.jsonc` 側に置く。**越境しない。**

- `envs/dev` `envs/staging` はアカウント①、`envs/production` はアカウント②（H-14 案A）
- backend の state は**アカウント①の R2 バケット `musubi-tfstate`** に集約する
  （backend 認証と provider 認証は別系統なので、②の state も①へ置ける）
- `.terraform.lock.hcl` は **コミットする**（provider の SHA 固定）
