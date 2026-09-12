# 起票するIssue一覧（Milestone `M0`）

> 企画書22章の指定どおり **#1 は「Terraformでdev環境をゼロから再現」**。
> 番号は起票順の目安。実際の採番は GitHub に従う。
> 担当区分：🧑 人間のみ／🧑🤖 人間の権限・承認が要る／🤖 AI単独可

---

## 一覧

| # | タイトル | 担当 | 依存 | 手順書 | ラベル | **GitHub** |
|---|---|---|---|---|---|---|
| **1** | **Terraformでdev環境をゼロから再現** | 🤖 | H-01,02,03 / #4 | `02` | `area:infra` | [#2](https://github.com/Kewton/Musubi/issues/2) |
| 2 | 🧑 Cloudflareアカウント作成（**Free・課金なし**）・APIトークン発行 | 🧑 | #34 | `00` H-01,H-02 | `human-only` | ✅ 完了済（H-01/H-02）・起票せず |
| 3 | 🧑 tfstate用R2バケット手動作成＋S3アクセスキー発行 | 🧑 | #2 | `00` H-03 | `human-only` | ✅ 完了済（H-03）・起票せず |
| 4 | monorepo骨格の初期化（pnpm workspace / turbo / tsconfig references） | 🤖 | H-06 | `01` §1-3 | `area:platform` | ✅ 完了済（M0-1）・起票せず |
| 5 | 🧑 リポジトリ可視性の判断（PUBLIC → private?） | 🧑 | — | `00` H-06 | `human-only` | ✅ 完了済（H-06）・起票せず |
| 6 | 🧑🤖 main保護・Environments（staging/production）・Milestone・Label設定 | 🧑🤖 | #5 | `01` §5 | `area:ci` | ✅ 完了済（H-07）・起票せず |
| 7 | 🧑 GitHub Secrets / Variables 登録 | 🧑 | #2,#3 | `00` H-08 | `human-only` | ✅ 完了済（H-08）・起票せず |
| 8 | Issue/PRテンプレート・Conventional Commits・CLAUDE.md | 🤖 | #4 | `01` §6-7 | `area:ci` | ✅ 完了済（M0-1）・起票せず |
| 9 | 越境import禁止のlintルール（gateway→D1/R2/DO 等） | 🤖 | #4 | `01` §3.2 | `area:platform` | ✅ 完了済（M0-1）・起票せず |
| 10 | Terraformモジュール `musubi-env` の設計と実装 | 🤖 | #1 | `02` §5 | `area:infra` | [#3](https://github.com/Kewton/Musubi/issues/3) |
| 11 | staging / production 環境の Terraform apply | 🧑🤖 | #10 | `02` §9 | `area:infra` | [#4](https://github.com/Kewton/Musubi/issues/4) |
| 12 | `infra:sync`（terraform output → wrangler.jsonc 同期）＋ドリフト検知 | 🤖 | #10 | `03` §3 | `area:infra` | [#5](https://github.com/Kewton/Musubi/issues/5) |
| 13 | data-api Worker 骨格（D1/R2/DO バインド・healthz） | 🤖 | #10,#12 | `03` §2,§5 | `area:platform` | [#6](https://github.com/Kewton/Musubi/issues/6) |
| 14 | app-do（Durable Object・SQLite）骨格＋ `new_sqlite_classes` migration | 🤖 | #4 | `03` §4 | `area:platform` | [#7](https://github.com/Kewton/Musubi/issues/7) |
| 15 | gateway Worker 骨格（Service Binding → data-api） | 🤖 | #13 | `03` §2 | `area:platform` | [#8](https://github.com/Kewton/Musubi/issues/8) |
| 16 | host（TanStack Start ＋ @cloudflare/vite-plugin）骨格＋ SB → gateway | 🤖 | #15 | `03` §2 | `area:platform` | [#9](https://github.com/Kewton/Musubi/issues/9) |
| 17 | 貫通スモークスクリプト `pnpm smoke`（host→gateway→data-api→D1/R2/DO） | 🤖 | #16 | `03` §5 | `area:platform` | [#10](https://github.com/Kewton/Musubi/issues/10) |
| 18 | ローカル開発手順の確定（wrangler dev マルチワーカー・3つの穴）→ `docs/runbook/local-dev.md` | 🤖 | #16 | `03` §6 | `area:platform` | [#11](https://github.com/Kewton/Musubi/issues/11) |
| 19 | D1マイグレーション機構＋前方互換規律 → `docs/runbook/d1-migration.md` | 🤖 | #13 | `03` §7 | `area:platform` | [#12](https://github.com/Kewton/Musubi/issues/12) |
| 20 | CI: `ci.yml`（lint/typecheck/unit/PRタイトル/sync-check） | 🤖 | #4,#7 | `04` §2 | `area:ci` | [#13](https://github.com/Kewton/Musubi/issues/13) |
| 21 | CI: `infra-plan.yml`（terraform plan をPRコメント） | 🤖 | #10,#7 | `04` §3 | `area:ci` | [#14](https://github.com/Kewton/Musubi/issues/14) |
| 22 | CD: `deploy-staging.yml`（main→migration→deploy→smoke） | 🤖 | #17,#19,#7 | `04` §4 | `area:ci` | [#15](https://github.com/Kewton/Musubi/issues/15) |
| 23 | CD: `deploy-production.yml`（tag v*→承認→deploy→smoke） | 🧑🤖 | #22,#6 | `04` §5 | `area:ci` | [#16](https://github.com/Kewton/Musubi/issues/16) |
| 24 | ロールバック手順の確立と**実演** → `docs/runbook/rollback.md` | 🧑🤖 | #23 | `04` §6 | `area:ci` | [#17](https://github.com/Kewton/Musubi/issues/17) |
| 25 | `pins/commandagent.json` プレースホルダと形式定義（M1準備） | 🤖 | #4 | `01` §1 | `area:platform` | ✅ 完了済（H-12）・起票せず |
| 26 | M0受入試験の実施と清算表の記入 | 🧑🤖 | #24 | `05` | — | [#18](https://github.com/Kewton/Musubi/issues/18) |
| 27 | 🧑 商標クリアランス（9類・42類）の調査発注 | 🧑 | — | `00` H-05 | `human-only` | [#19](https://github.com/Kewton/Musubi/issues/19) |
| 28 | 🧑 ドメイン取得＋Cloudflareゾーン委任 | 🧑 | #27 | `00` H-04 | `human-only` | [#20](https://github.com/Kewton/Musubi/issues/20) |
| 29 | 🧑 ~~WfP有効化~~ → **M5へ延期**。M0は「不要の確定」と `wfp_enabled=false` 固定のみ | 🧑 | #2 | `00` H-09 / `06` §3 | `human-only` | [#21](https://github.com/Kewton/Musubi/issues/21) |
| 30 | 🧑 LINE Developers dev チャネル先行取得（M2準備） | 🧑 | — | `00` H-10 | `human-only` | [#22](https://github.com/Kewton/Musubi/issues/22) |
| 31 | 🧑 Google Cloud OAuth クライアント先行発行（M2準備） | 🧑 | — | `00` H-11 | `human-only` | [#23](https://github.com/Kewton/Musubi/issues/23) |
| 32 | 🧑 CommandAgent 接点・ピン対象の確定（M1準備） | 🧑 | — | `00` H-12 | `human-only` | [#24](https://github.com/Kewton/Musubi/issues/24) |
| 33 | 🧑 $0の宣言＋**プラン昇格トリガー（P-1〜P-6 / W-1・W-2）の承認** | 🧑 | — | `00` H-13 / `06` §5 | `human-only` | ✅ 完了済（H-13）・起票せず |
| **34** | ✅ ~~Cloudflareアカウントを分けるか決める~~ **2026-09-12 決定（案A）。起票不要** | 🧑 | — | `00` H-14 / `06` §4.3 | `human-only` | ✅ 完了済（H-14）・起票せず |
| 35 | 無償枠の実測をスモークに埋め込む（CPU時間・チェーン合計） | 🤖 | #17 | `03` §5 / `06` §7 | `area:platform` | [#25](https://github.com/Kewton/Musubi/issues/25) |
| 36 | 試験F：無償枠の実測と `06` §8 プラン清算の記入 | 🧑🤖 | #35,#23 | `05` §3.5 | — | [#26](https://github.com/Kewton/Musubi/issues/26) |
| 37 | M2計測基盤に **promotion_decision 記録件数**を入れる（WfP昇格の先行指標）— M2へ送るIssue | 🤖 | — | `06` §5 | `area:platform` | [#27](https://github.com/Kewton/Musubi/issues/27) |
| 38 | 🧑 **CIトークンをテンプレートから最小構成へ絞り直す** — **Milestone `M3`**（実データが乗る前に締める） | 🧑 | #7 | `00` H-02 | `human-only` | [#28](https://github.com/Kewton/Musubi/issues/28) |

**内訳**：🧑 人間のみ = 13件（#2,3,5,7,27,28,29,30,31,32,33,34,38）／🧑🤖 = 6件（#6,11,23,24,26,36）／🤖 = 19件

> **#37 は Milestone `M2`、#38 は `M3`** に付ける（M0では起票のみ。忘れないための置きIssue）。
> **#38 の理由**：M0ではAPIトークンをテンプレート発行して速さを取るが、テンプレートはCIに R2/KV の削除権限まで与える。**M3で実データが乗る前に最小構成へ絞る**（`00` H-02 のトレードオフ表）。

---

## クリティカルパス

```
#34 (🧑 アカウント分離の判断)      ← ここが最初。作る数・トークン数・Secret名が決まる
  → #2 (🧑 CFアカウント/トークン)
  → #3 (🧑 tfstateバケット)
    → #1 (Terraform dev 再現) ← #4 (monorepo骨格) ← #5 (🧑 可視性判断)
      → #10 (モジュール化) → #12 (infra:sync) → #13 (data-api)
        → #15 (gateway) → #16 (host) → #17 (smoke)
          → #22 (staging CD) ← #7 (🧑 Secrets) ← #6 (🧑🤖 Environments)
            → #23 (production CD) → #24 (rollback実演) → #26 (受入)
```

**#34 → #2 → #3 → #7 が止まると全部止まる。** ここだけは初日に片付ける。

**#34 を最初に置く理由**：production を後から別アカウントへ動かすと **D1/R2/DO のデータ移行**になる。分けるなら production が空である今しかない（`06` §4.3）。

---

## Issue本文のひな形

```markdown
## 目的
（企画書の章番号で出典を示す。例：企画書11章「IaC二層」）

## DoD（完了条件）
- [ ] 
- [ ] 

## 担当区分
🤖 AI単独 / 🧑🤖 人間の権限・承認が必要 / 🧑 人間のみ
（🧑 の場合：なぜAIにできないかを1行で）

## 依存
- Blocked by #
- Blocks #

## 手順書
workspace/mvp/m0/XX-....md §N

## 備考・要確認事項
（「要確認」と書いた項目は、closeする前に一次情報で確定させること）
```

---

## 一括起票コマンド（例）

```bash
REPO=Kewton/Musubi

gh issue create --repo $REPO \
  --title "Terraformでdev環境をゼロから再現" \
  --milestone "M0" --label "area:infra" \
  --body-file - <<'BODY'
## 目的
企画書22章「最初のIssue：#1 Terraformでdev環境をゼロから再現」。
IaC二層（企画書11章）のうち、アカウント単位資源をTerraformで完全に再現可能にする。

## DoD
- [ ] `terraform apply` で dev の全資源が作られる
- [ ] `terraform destroy` → `terraform apply` で同一構成が再現される
- [ ] 上記の往復にダッシュボード操作が1回も含まれない
- [ ] `terraform output -json bindings` が sync-bindings の期待スキーマに一致
- [ ] `.terraform.lock.hcl` がコミットされている

## 担当区分
🤖 AI単独（ただし #2 #3 の人間タスク完了が前提）

## 依存
- Blocked by #2, #3, #4

## 手順書
workspace/mvp/m0/02-terraform.md
BODY
```

> **注意**：`--milestone` は事前に Milestone が存在している必要がある（`01` §5 で作成）。
> 🧑 の Issue には必ず `human-only` ラベルを付ける。**AIがうっかり着手して「できません」で止まる時間を無くすため。**

---

## 🧑 の再分類（2026-09-12）

当初 🧑 が付いていた作業を精査し、**「AI ができる準備」と「本人にしかできない一点」に割り直した**。
詳細は [`07-parallel-plan.md`](./07-parallel-plan.md) §1。

| Issue | 変更 |
|---|---|
| #21 | 🧑 → **🤖**（サブタスクの2/3は完了済み。残りは Terraform に1行） |
| #24 | 🧑 → **🤖**（CommandAgent への読取アクセスを確認） |
| #19 | 候補調査・依頼文を **#32（🤖）** へ分離。#19 は**発注だけ** |
| #20 | ゾーン委任以降を **#33（🤖）** へ分離。#20 は**購入だけ** |
| #22 / #23 | **アカウント新規作成だけ**が本人。以降は 🧑🤖 |
| #28 | 権限の不在。トークンを渡せば 🤖 |

**🤖 12件 → 18件、🧑 6件 → 4件。本人の実作業は合計1時間未満。**

削れないのは **①支払い・契約／②アカウント新規作成と本人確認／③事業判断の宣言** の3つだけ。

## 並列実行の順序

**着手順序は [`07-parallel-plan.md`](./07-parallel-plan.md) が正本。**
クリティカルパスは11段（#2 → #3 → #5 → #6 → #8 → #9 → #10 → #15 → #16 → #17 → #18）で、
**並列度は2で足りる**。#2 が単独のゲートであり、その後ろに10段が並んでいる。

## 起票の記録（2026-09-12）

**案A で起票した：開いている27件のみを GitHub へ起票し、完了済み11件は起票していない。**
完了分の記録は [`checklist.md`](./checklist.md) と [`00e-execution-status.md`](./00e-execution-status.md) にある。
起票直後にクローズする空の記帳を作らないための判断。

| | 件数 | doc番号 |
|---|---|---|
| 起票した | **27** | #1, #10〜#24, #26〜#32, #35〜#38 |
| 完了済み・起票せず | **11** | #2, #3, #4, #5, #6, #7, #8, #9, #25, #33, #34 |

### ⚠️ 番号は doc とずれている

**GitHub は Issue と PR で採番を共有する。** M0-1 のドキュメント PR が **#1** を取ったため、
企画書22章の「#1 は Terraformでdev環境をゼロから再現」は実現していない。
**Terraform の Issue は [#2](https://github.com/Kewton/Musubi/issues/2)** である。
本ファイルの番号は doc 内部の参照用として残し、上表の **GitHub 列が実体**である。

GitHub 側の Issue 本文では、依存の相互参照を実番号へ書き換え済み。
