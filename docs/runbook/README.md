# docs/runbook

障害時に**手順を思い出さずに実行できる**ものだけを置く。

| ファイル | 内容 | いつ書くか |
|---|---|---|
| `rollback.md` | コード（`rollback.yml` の wrangler rollback ／古い v タグの再デプロイ）・D1（巻き戻さない）・Terraform（state の退避と復元）。**実演の記録は §4** | M0-4（`04-cicd.md` §6。Issue #17） |
| `d1-migration.md` | D1 マイグレーションの前方互換規律 | M0-4 |
| `local-dev.md` | `wrangler dev` で host・gateway・data-api を並べる手順と、ローカルで再現できない3点 | M0-4（`03` §6） |

M0 の DoD は「文書化」だけでなく**実演まで**を含む。
production を1つ前のバージョンへ戻して復帰させた記録を残すこと（`rollback.md` §4。🧑 所有者の立ち会いで行い、埋まるまで DoD は未達）。
