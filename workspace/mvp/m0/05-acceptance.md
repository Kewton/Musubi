# 05：M0 受入試験 — DoD判定と清算

> 企画書16章/22章で確立した「**事前宣言→実測→清算**」の型を、基盤づくりにも適用する。
> 担当：🤖（実行）＋ 🧑（判定・承認）
> **プラン前提：Cloudflare Free（$0）** — 無償枠の実測は §3.5 試験F（→ [`06-plan-and-limits.md`](./06-plan-and-limits.md)）

---

## 1. 試験A：手作業ゼロの再現性（M0-3 の本体）

**問い**：dev環境を丸ごと消して、コマンドだけで元に戻せるか。

### 前提として除外するもの
- 🧑 H-01（Cloudflareアカウント）／H-02（APIトークン）／H-03（tfstate用R2バケット）
  → これらは**IaCで作れない土台**（鶏卵問題）。試験の前提条件であり「手作業」には数えない。**この除外は明示的に宣言する。**

### 手順（ストップウォッチを回して実行）

```bash
cd infra/terraform/envs/dev
export CLOUDFLARE_API_TOKEN="$TF_CLOUDFLARE_API_TOKEN"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"

# ① 消す（R2にオブジェクトが残っていると失敗する → pre-hookで空にする）
pnpm infra:empty-buckets --env dev
terraform destroy -auto-approve

# ② 作り直す
terraform apply -auto-approve

# ③ 新しいIDを wrangler.jsonc に同期
cd ../../../..
pnpm infra:sync --env dev

# ④ 配る
pnpm deploy:dev

# ⑤ 貫通スモーク
pnpm smoke --env dev
```

### 判定

| 項目 | 事前宣言（README §5） | 実測 | 判定 |
|---|---|---|---|
| 所要時間（①〜⑤） | ≤ 15分 | ___ 分 | ☐ |
| ダッシュボード操作回数 | **0回** | ___ 回 | ☐ |
| 手で編集したファイル数 | **0件** | ___ 件 | ☐ |
| `smoke` の全チェック | 全 `ok` | ___ | ☐ |

> **1回でも手作業が混ざったら未達。** 「今回だけダッシュボードで直した」を許すと、この試験は意味を失う。混ざったらその手作業をIssueにしてスクリプト化する。

---

## 2. 試験B：Service Bindings の結線（M0-4）

```bash
pnpm smoke --env staging
```

**期待**

```json
{
  "service": "host",
  "env": "staging",
  "version": "<merge した commit sha>",
  "checks": { "gateway": "ok", "data_api": "ok", "d1": "ok", "r2": "ok", "do": "ok" }
}
```

**追加で確認する「触れないこと」**（企画書9章の不変条件が構造で守られているか）

| 確認 | 方法 | 判定 |
|---|---|---|
| gateway が D1 に直接触れない | `apps/gateway/wrangler.jsonc` に `d1_databases` が**無い** | ☐ |
| gateway が R2 に直接触れない | 同じく `r2_buckets` が**無い** | ☐ |
| gateway が DO に直接触れない | 同じく `durable_objects` が**無い** | ☐ |
| host が data-api に直接届かない | `apps/host/wrangler.jsonc` の `services` が `GATEWAY` のみ | ☐ |
| data-api に外部ルートが無い | `workers_dev: false`（staging/prod）かつ `routes` 未設定 | ☐ |
| lint が越境importを落とす | 意図的に `gateway` から `app-do` を import する一時PRを出し、CIが**落ちる**ことを確認 | ☐ |

> 最後の1行が重要。**「規約に書いてある」ではなく「破ると機械が止める」**を確認する。企画書12章「promptに書いただけのルールはいずれ破られる」と同じ理屈が、人間のコードにも当てはまる。

---

## 3. 試験C：CI/CD 一周（M0-2）

| # | 手順 | 期待 | 判定 |
|---|---|---|---|
| C-1 | `main` へ直接 push を試みる | **拒否される** | ☐ |
| C-2 | feature ブランチでPR作成 | `lint-typecheck-unit` / `terraform-plan` が走り green | ☐ |
| C-3 | PRタイトルを規約違反にする（例：`update stuff`） | `pr-title` が**落ちる** | ☐ |
| C-4 | 意図的に typecheck エラーを入れる | CIが**落ちる**・merge がブロックされる | ☐ |
| C-5 | squash merge | staging へ自動デプロイ → smoke green | ☐ |
| C-6 | `v0.0.1` タグ push | 🧑 **承認依頼が届く** | ☐ |
| C-7 | 承認 | production へデプロイ → smoke green | ☐ |
| C-8 | `wrangler rollback`（または rollback.yml） | production が1つ前へ戻り smoke green | ☐ |
| C-9 | 再デプロイで復帰 | production が最新へ戻る | ☐ |

**計測**

| 項目 | 事前宣言 | 実測 | 判定 |
|---|---|---|---|
| PR検査時間 | ≤ 5分 | ___ | ☐ |
| main merge → staging smoke green | ≤ 10分 | ___ | ☐ |
| ロールバック所要時間（C-8） | 宣言なし → **ここで初期値を記録** | ___ | 記録 |

---

## 3.5 試験F：無償枠の実測（`06` の要確認を潰す）

**問い**：Free の上限に対してどれだけ余裕があるか。**「たぶん大丈夫」で M1 に進まない。**

> **2026-09-14 実施（Issue #25・#26）。** 測り方を変えた：CPU 時間は Worker の中では測れない（Workers の時計は I/O のときにしか進まない）ので、
> スモークに `budget.chain_total_ms` は入れず、**Workers Analytics（GraphQL）を読む2本のスクリプト**にした（`03` §5）。
> `infra/scripts/measure-free-tier.ts` は staging に GET を送って F-1〜F-4 を測る（`06` §7.1）。`infra/scripts/free-tier-report.ts` は
> **読み取りだけ**でアカウント①・②の期間の最大値と P-1〜P-4 を集計する（`06` §7.2。週次チェックにも使う）。

| # | 項目 | 測り方 | 結果（2026-09-14） | 判定 |
|---|---|---|---|---|
| F-1 | **CPU時間はチェーン合算か独立か** | Analytics の cpuTime を Worker ごとに読み、host の値が下流を含むかを見る（`measure-free-tier.ts`） | **未確定**。記録は Worker ごと（host の1回あたり 0.67・0.64 ms は下流の和より小さい）。上限を Worker ごとに判定するか合算するかは一次情報に無い（`06` §7 #1） | ⚠️ 未確定（下の処置を見る） |
| F-2 | チェーン全体のCPU時間 | 同上＋期間の集計（`free-tier-report.ts`。3 Worker の max の和＝上界） | 続けて 20 回の上界 **6.51・5.28 ms**（`06` §7.1）。M0 期間（09-08〜09-14 UTC）の上界は **staging 9.52 ms・production 16.94 ms**。Worker 単体の max は **production の data-api 11.30 ms**（エラーなし。staging は 5.68 ms）。production の単発の `/healthz` 1 回でチェーン合計 16.47 ms（`06` §7.2） | ⚠️ **余裕 3 ms 未満**（production は単体でも −1.30 ms、合算なら −6.94 ms。staging は合算なら 0.48 ms）。下の処置を見る |
| F-3 | **Service Binding は課金リクエストを別カウントするか** | `/healthz` を 20 回叩き、Analytics の Worker ごとの requests を見る（+N か +3N か） | **別**（Analytics 上。host への 1 回が 3 requests）。Free の 100k/日 がどちらで数えるかは一次情報に無い → **別カウントで見積もる（実効 33k/日）** | ✅ |
| F-4 | **静的アセットが 100k/日 を消費しないか** | シェルを 20 回ロードし、Analytics の Worker の起動と Static Assets の requests を見る | **消費しない**（Worker の起動 0 回・0 回。一次情報とも一致） | ✅ |
| F-5 | 1リクエストあたりの subrequest 消費数 | data-api の D1/R2/DO 呼び出し数を数え、Analytics の `sum.subrequests` と突き合わせる | **host 1・gateway 1・data-api 5（チェーン 7）**。Free 上限は1回の起動あたり 50 → 余裕 43（`06` §7 #7） | ✅ |
| F-6 | Workers Logs の無償保持期間 | 一次情報 | **3 日**（Paid は 7 日）。P-1 の 7 日を覆えないので P-1 は Analytics で見る（`06` §7 #8） | ✅ |
| F-7 | **課金額が $0 であること** | Cloudflare の Billing を確認 | **$0**（2026-09-15 に所有者がダッシュボードで確認。API では読めない） | ✅ |

**F-1 が「合算」だった場合の処置**（先に決めておく）
- ❌ gateway と data-api を統合する → **やらない**。企画書9章「Data APIが唯一の権限強制点」が崩れる
- ✅ 余裕が 3ms 未満なら **Workers Paid $5 へ昇格**（`06` §5 P-1 の前倒し適用）。**アーキテクチャを課金プランに売らない**

> **2026-09-14 の状態 — 監督側（人）の判断待ち。** F-1 は未確定のまま。ところが **production は、独立でも合算でも余裕 3 ms の線を割った**：
> data-api が単体で 11.30 ms（余裕 −1.30 ms）、同じ 1 回のリクエストのチェーン合計は 16.47 ms。staging は合算のときだけ割る（上界の余裕 0.48 ms、単発 1 回でも 2.47 ms の回があった）。
> この処置は「合算だった場合」の宣言で、未確定のとき・単体で超えたときの扱いは決めていない。上限を超えた記録はエラー（`exceededResources`）になっておらず、
> **昇格トリガー P-1〜P-6 には触れていない**（`06` §7.2）。だからワーカーは昇格を決めずに、ここで人に返す。
>
> **2026-09-15 の判断（所有者）：昇格しない。** 11.30 ms は production の初回デプロイ直後の最初のリクエストだった。落ち着いた状態で production の `/healthz` を
> 20 回測り直すと（先に 5 回温めて 60 秒空けた）、Worker 単体の max は data-api 5.20・gateway 2.05・host 2.11 ms（エラー 0）で、**単体では余裕 4.80 ms**。
> 3 Worker の max の和は 9.36 ms で、合算の上界では余裕 0.64 ms（1回あたりの平均の和は 4.80 ms）。上の処置は「F-1 が合算だった場合」の宣言で、
> F-1 は未確定なので発動しない。**週次チェック（`06` §5.1）で CPU 時間の max を見続け、F-1 が確定したとき・gateway に認可が入ったとき（M2）に測り直す。**
> 上限を超えた記録がエラー（`exceededResources`）になったら、その時点で P-1 に触れる（議論せず上げる）。

---

## 4. 試験D：Issueドリブンの運用が回っているか（M0-1）

| 確認 | 判定 |
|---|---|
| Milestone `M0`〜`M3` が存在する | ☐ |
| `M0` のIssueが全て closed（持ち越しは `M1` へ付け替え済み） | ☐ |
| 全PRが `Closes #N` でIssueに紐づいている | ☐ |
| Issueテンプレートに Milestone / DoD / 担当区分（🧑🤖）の欄がある | ☐ |
| `human-only` ラベルの付いたIssueが、人間タスク（`00`）と一致している | ☐ |

---

## 5. 試験E：ドキュメントの実在確認

M0を「基盤ができた」と言うために、**M1以降の自分が読む文書**が揃っているか。

| ファイル | 内容 | 判定 |
|---|---|---|
| `CLAUDE.md` | 不変条件・作業規律 | ☐ |
| `docs/runbook/rollback.md` | コード／D1／Terraform の巻き戻し。**実演記録つき** | ☐ |
| `docs/runbook/d1-migration.md` | 前方互換のみ・2段階リリース規律 | ☐ |
| `docs/runbook/local-dev.md` | wrangler dev の確定手順と**3つの穴**の扱い | ☐ |
| `infra/terraform/README.md` | 二層の境界表（何をTerraformが持たないか） | ☐ |
| `pins/commandagent.json` | M1で使うピンのプレースホルダ＋形式の説明 | ☐ |
| `workspace/mvp/m0/06-plan-and-limits.md` §8 | プラン清算が記入済み | ☐ |

---

## 6. 清算表（M0完了時に記入）

```
M0 清算 — 記入日: ____-__-__

【事前宣言 vs 実測】
  dev再現時間        宣言 ≤15分   実測 ____   判定 達成 / 未達
  再現の手作業回数    宣言 0回     実測 ____   判定 達成 / 未達
  PR検査時間         宣言 ≤5分    実測 ____   判定 達成 / 未達
  main→staging      宣言 ≤10分   実測 ____   判定 達成 / 未達
  月額インフラ費      宣言 $0      実測 $____  判定 達成 / 未達
  最大CPU時間         宣言 <10ms   実測 ____   判定 達成 / 未達（余裕 ____ ms）
  最大日次リクエスト   宣言 <50k    実測 ____   判定 達成 / 未達

【無償枠の確定事項（試験F）】
  CPU時間           独立 / 合算
  SB リクエスト      別カウント / されない  → 実効予算 ____ req/日
  静的アセット       枠を消費する / しない
  昇格トリガー抵触   なし / P-__ に抵触（対応: ____）

【未達項目の処置】
  - （項目）: 原因 ____ / 処置 ____ / Issue #__ / 送り先 M__

【M1へ持ち越したIssue】
  - #__ ____（理由: ____）

【M0で判明した想定外】
  - ____

【M1着手可否】  可 / 不可（理由: ____）
```

> **未達をそのまま通さない。** 達成できなかった項目は「なぜ線を外したのか／線が悪かったのか実装が悪かったのか」を分けて記録する。企画書17章の「較正の系譜（12系統）」——**モデルが主犯だった床は局所の数件のみで、大半は機械側の伝達・配線・強制の欠落だった**——と同じ帰属分析を、プラットフォーム側でも初回から始めておく。

---

## 7. M0クローズの宣言

以下がすべて満たされたら、🧑 **人間がM0クローズを宣言**し、M1に着手する。

- [ ] 試験A〜**F** が全項目パス
- [ ] 清算表を記入し、未達項目の処置が決まっている
- [ ] Milestone `M0` を close
- [ ] タグ `v0.1.0` が production にデプロイされている
- [ ] 🧑 **M1のゲートを事前宣言する**：「封緘済みgolden割り勘が staging のスマホで動く」の判定方法・判定者・期限を書き出す
