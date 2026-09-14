# docs/runbook

障害時に**手順を思い出さずに実行できる**ものだけを置く。

| ファイル | 内容 | いつ書くか |
|---|---|---|
| `rollback.md` | コード／D1／Terraform のロールバック | M0-4（`04-cicd.md` §6） |
| `d1-migration.md` | D1 マイグレーションの前方互換規律 | M0-4 |
| `local-dev.md` | `wrangler dev` で host・gateway・data-api を並べる手順と、ローカルで再現できない3点 | M0-4（`03` §6） |

M0 の DoD は「文書化」だけでなく**実演まで**を含む。
production を1つ前のバージョンへ戻して復帰させた記録を残すこと。
