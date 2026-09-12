# 00d：H-04 ドメイン — M0 への影響（公開側の抜粋）

> **調査結果・名称の検討・商標との関係は、非公開リポジトリ `Kewton/Musubi-workspace` の `naming/00d-h04-domain.md` にある。**
> ここには M0 を進めるために必要な技術的帰結だけを置く（公開側に名称・商標の結論を書かない方針。→ `00b-decisions.md` D-2）。

## 結論：ドメイン未確定のまま M0 は完遂できる

候補ドメインは未取得である。`00-human-tasks.md` H-04 の回避策がそのまま効く。

- `*.workers.dev` の既定ドメインで M0-1〜M0-4 を通す
- Terraform 側は `zone_id` / DNS リソースを `count = var.custom_domain_enabled ? 1 : 0` でゲート（[`02-terraform.md`](./02-terraform.md) §6 に実装済み）
- H-08 の Variable `CLOUDFLARE_ZONE_ID` は **空のままでよい**
- H-02 ① の `Zone / DNS: Edit` 権限は **まだ足さない**。ドメイン取得後に追記する
- リソース名の `musubi-` prefix は変数化しておく（[`02-terraform.md`](./02-terraform.md) §5）。名称が変わっても差し替えて再 apply できる状態を保つ

カスタムドメインの結線は、取得後に `terraform apply` 1回で入る。
