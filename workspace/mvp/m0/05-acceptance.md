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
- 手元の道具：tfenv（`.terraform-version`）・`pnpm install` 済み・worktree なら `./infra/scripts/link-env.sh` 済み（`.env` は追跡していない。CLAUDE.md）。
  これも試験の前の準備で、①〜⑤の時間にも手作業にも数えない

### 手順（ストップウォッチはスクリプトが回す）

**①〜⑤を1本で流す**（Issue #67）。段ごとの所要時間と合計を出し、どこかの段が落ちたらそこで止まる。確認のプロンプトは出ない。

```bash
./infra/scripts/reproduce-dev.sh    # リポジトリ直下の .env を読む（別のファイルは --env-file <file>）
```

スクリプトがしていること。手で分けて流すときも、この順・この資格情報で流す（`infra/scripts/reproduce-dev.sh` 冒頭）。

| 段 | コマンド（リポジトリ直下から） | 渡す資格情報 |
|---|---|---|
| ① 空にする | `pnpm infra:empty-buckets --env dev`（BUNDLES・UPLOADS のオブジェクトを全部消す。**dev 以外は受け付けない**） | `TF_CLOUDFLARE_API_TOKEN` を `CLOUDFLARE_API_TOKEN` として・`CLOUDFLARE_ACCOUNT_ID` |
| ① 消す | `terraform -chdir=infra/terraform/envs/dev init -input=false -lockfile=readonly` → `destroy -auto-approve` | `TF_CLOUDFLARE_API_TOKEN` を `CLOUDFLARE_API_TOKEN` として・`CLOUDFLARE_ACCOUNT_ID` を `TF_VAR_account_id` として・backend の R2 の3つ（`AWS_*` として） |
| ② 作り直す | `apply -auto-approve` → `plan -detailed-exitcode` が exit 0 | 同上 |
| ③ 同期 | `pnpm infra:sync --env dev` → `pnpm infra:sync --env dev --check` が exit 0 | backend の R2 の3つだけ |
| ④ build | `CLOUDFLARE_ENV=dev pnpm build`（host は build の時点で env が決まる。`04` §4） | なし |
| ④ 配る | `pnpm exec tsx infra/scripts/deploy-worker.ts --env dev` の `--target migrate` → `data-api` → `gateway` → `host`（`--sha` は HEAD） | `CLOUDFLARE_API_TOKEN`（CI 用）・`CLOUDFLARE_ACCOUNT_ID` |
| ⑤ 貫通スモーク | `pnpm exec tsx infra/scripts/deploy-worker.ts --env dev --smoke --sha <HEAD>` | 同上 |

- **production の資格情報（`*_PROD`・`MUSUBI_PROBE_TOKEN`・`SMOKE_*`）はどの段にも渡さない。** `CLOUDFLARE_ACCOUNT_ID` が `CLOUDFLARE_ACCOUNT_ID_PROD` と同じなら、何もせずに止まる
- ⑤ の宛先（dev の host の workers.dev のオリジン）は、Cloudflare の API で読んだサブドメインと host の Worker 名から組み立て、**表示せずに** smoke の判定へ渡す（`deploy-worker.ts` 冒頭「dev の貫通スモーク」）。dev には CD も Secret も無いので、`SMOKE_BASE_URL` をどこにも置かない
- 出力は公開の場に貼ってよい形にしてある：workers.dev のホスト名・Account ID の形・terraform の `[id=…]` を伏せ、terraform と build は要約の行だけを出す。全文はログのファイル（一時ディレクトリ）に残る。**ログのファイルは貼らない**
- 消す前に件数だけを見るなら `pnpm infra:empty-buckets --env dev --dry-run`（読み取りだけ）

> **前の版の手順（`pnpm deploy:dev` と `pnpm smoke --env dev`）は、そのままでは通らない形だった**（一度も流していない）。`infra:empty-buckets` が無く、
> `deploy:dev` は D1 マイグレーションを当てず（D1 は作り直されて空になる）、`GIT_SHA` を渡さず、workers.dev のホスト名をそのまま出す。
> `smoke --env dev` には宛先（`SMOKE_BASE_URL`）が無い。

**終わった後**：③ で `packages/data-api/wrangler.jsonc` の `database_id` が変わる（スクリプトが書き換えたファイルを挙げる）。
`infra/terraform/README.md` §2 のとおりコミットする。これは再現の後始末で、手で編集したファイルには数えない。

### 判定

| 項目 | 事前宣言（README §5） | 実測 | 判定 |
|---|---|---|---|
| 所要時間（①〜⑤） | ≤ 15分 | **32 秒**（2026-09-15・commit `a6aaff6`。空にする 1・destroy 3・apply 4・同期 2・build 2・配る 17・smoke 2 秒） | ✅ |
| ダッシュボード操作回数 | **0回** | **0 回**（`reproduce-dev.sh` を1回実行しただけ） | ✅ |
| 手で編集したファイル数 | **0件** | **0 件**（`infra:sync` が `packages/data-api/wrangler.jsonc` の env.dev の database_id を書き換え、後始末としてコミット） | ✅ |
| `smoke` の全チェック | 全 `ok` | **全 ok**（host → gateway → data_api → d1 / r2 / do、version が `a6aaff6`） | ✅ |

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
| gateway が D1 に直接触れない | `apps/gateway/wrangler.jsonc` に `d1_databases` が**無い** | ✅ トップ・3環境とも無い（2026-09-15） |
| gateway が R2 に直接触れない | 同じく `r2_buckets` が**無い** | ✅ 同上 |
| gateway が DO に直接触れない | 同じく `durable_objects` が**無い** | ✅ 同上 |
| host が data-api に直接届かない | `apps/host/wrangler.jsonc` の `services` が `GATEWAY` のみ | ✅ 3環境とも `GATEWAY` のみ・トップに services 無し |
| data-api に外部ルートが無い | `workers_dev: false`（staging/prod）かつ `routes` 未設定 | ✅ 設定はトップで `workers_dev: false`・routes 無し。実物も staging・production とも workers.dev と preview が無効（API で確認） |
| lint が越境importを落とす | 意図的に `gateway` から `app-do` を import する一時PRを出し、CIが**落ちる**ことを確認 | ✅ PR #68：`pnpm lint` が `'@musubi/app-do' import is restricted` で失敗・マージはブロック。確認後に閉じた |

> 冒頭の `pnpm smoke --env staging` は、deploy-staging の ③ として main へのマージのたびに通っている（初回は run 34820563532）。
>
> 最後の1行が重要。**「規約に書いてある」ではなく「破ると機械が止める」**を確認する。企画書12章「promptに書いただけのルールはいずれ破られる」と同じ理屈が、人間のコードにも当てはまる。

---

## 3. 試験C：CI/CD 一周（M0-2）

| # | 手順 | 期待 | 判定 |
|---|---|---|---|
| C-1 | `main` へ直接 push を試みる | **拒否される** | ⚠️ **試さない**（2026-09-15 所有者の判断）。保護は API で確認：必須チェック・strict・線形履歴・force push 不可・削除不可・レビュー必須。ただし `enforce_admins: false` なので**管理者は迂回できる**。M3 着手時に true にする（`06` §5 B-1） |
| C-2 | feature ブランチでPR作成 | `lint-typecheck-unit` / `terraform-plan` が走り green | ✅ M0 の通常の PR（#53〜#72。#68〜#70 は §2・C-3・C-4 の意図的な失敗）で毎回 green |
| C-3 | PRタイトルを規約違反にする（例：`update stuff`） | `pr-title` が**落ちる** | ✅ PR #69 で失敗。**ただし `pr-title` が必須チェックではなく、マージはブロックされなかった**（mergeState UNSTABLE）→ 2026-09-15 に必須チェックへ加えた |
| C-4 | 意図的に typecheck エラーを入れる | CIが**落ちる**・merge がブロックされる | ✅ PR #70：`pnpm typecheck` が TS2322 で失敗・mergeState BLOCKED。確認後に閉じた |
| C-5 | squash merge | staging へ自動デプロイ → smoke green | ✅ #15 のマージ以降、毎回（初回 run 34820563532） |
| C-6 | `v0.0.1` タグ push | 🧑 **承認依頼が届く** | ✅ `v0.1.0` で実施（04 §5 のタグ名に合わせた）。承認があるまでジョブが始まらなかった（run 34855227278） |
| C-7 | 承認 | production へデプロイ → smoke green | ✅ `v0.1.0`（2026-09-14）・`v0.1.1`（2026-09-15） |
| C-8 | `wrangler rollback`（または rollback.yml） | production が1つ前へ戻り smoke green | ✅ 2026-09-15：rollback.yml で v0.1.1 → v0.1.0（run 34914001211・切り替え 9 秒・smoke green。`docs/runbook/rollback.md` §4.2） |
| C-9 | 再デプロイで復帰 | production が最新へ戻る | ✅ 2026-09-15：rollback.yml で v0.1.0 → v0.1.1 に戻した（run 34914211412・切り替え 9 秒・smoke green）。一次手段で復帰し、タグの再デプロイは不要だった |

**計測**

| 項目 | 事前宣言 | 実測 | 判定 |
|---|---|---|---|
| PR検査時間 | ≤ 5分 | `lint-typecheck-unit` 1分14秒〜1分34秒（M0 後半の PR） | ✅ |
| main merge → staging smoke green | ≤ 10分 | 63〜83 秒（deploy-staging の ④） | ✅ |
| ロールバック所要時間（C-8） | 宣言なし → **ここで初期値を記録** | **承認から smoke green まで 47 秒**（うち切り替え 9 秒）。復帰は 45 秒 | 記録 |

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
| Milestone `M0`〜`M3` が存在する | ✅ |
| `M0` のIssueが全て closed（持ち越しは `M1` へ付け替え済み） | ✅ 本 Issue（#18）を除いて閉じた。持ち越し：#19・#20・#33 → M1、#23 → M2、#22 は保留（Milestone なし） |
| 全PRが `Closes #N` でIssueに紐づいている | ❌ **未達**：マージ済み 36 本のうち 15 本に Closes が無い（Issue なしの監督側の変更 12 本・Refs だけの途中の PR 3 本）。処置は §6 |
| Issueテンプレートに Milestone / DoD / 担当区分（🧑🤖）の欄がある | ✅ `.github/ISSUE_TEMPLATE/task.yml`（Milestone・担当区分・DoD・背景・依存） |
| `human-only` ラベルの付いたIssueが、人間タスク（`00`）と一致している | ✅ #19（H-05）・#20（H-04）・#22（H-10・保留）・#23（H-11）・#28（CI トークンの絞り直し） |

---

## 5. 試験E：ドキュメントの実在確認

M0を「基盤ができた」と言うために、**M1以降の自分が読む文書**が揃っているか。

| ファイル | 内容 | 判定 |
|---|---|---|
| `CLAUDE.md` | 不変条件・作業規律 | ✅ |
| `docs/runbook/rollback.md` | コード／D1／Terraform の巻き戻し。**実演記録つき** | ✅ 実演記録つき（2026-09-15） |
| `docs/runbook/d1-migration.md` | 前方互換のみ・2段階リリース規律 | ✅ |
| `docs/runbook/local-dev.md` | wrangler dev の確定手順と**3つの穴**の扱い | ✅ |
| `infra/terraform/README.md` | 二層の境界表（何をTerraformが持たないか） | ✅ |
| `pins/commandagent.json` | M1で使うピンのプレースホルダ＋形式の説明 | ✅（tarball の SHA は M1 の #38） |
| `workspace/mvp/m0/06-plan-and-limits.md` §8 | プラン清算が記入済み | ✅ |

---

## 6. 清算表（M0完了時に記入）

```
M0 清算 — 記入日: 2026-09-15

【事前宣言 vs 実測】
  dev再現時間        宣言 ≤15分   実測 32 秒                 判定 達成
  再現の手作業回数    宣言 0回     実測 0 回                  判定 達成
  PR検査時間         宣言 ≤5分    実測 1分14秒〜1分34秒      判定 達成
  main→staging      宣言 ≤10分   実測 63〜83 秒             判定 達成
  月額インフラ費      宣言 $0      実測 $0                    判定 達成（所有者が Billing で確認）
  最大CPU時間         宣言 <10ms   実測 11.30 ms              判定 未達（production の初回デプロイ直後の1回。落ち着いた状態では単体の max 5.20 ms・余裕 4.80 ms。06 §8）
  最大日次リクエスト   宣言 <50k    実測 217 req/日（①・staging。②は 30）  判定 達成

【無償枠の確定事項（試験F）】
  CPU時間           未確定（Analytics は Worker ごとに記録。上限の判定単位は一次情報に無い）
  SB リクエスト      別カウント（Analytics 上）  → 実効予算 33,000 req/日で見積もる
  静的アセット       枠を消費しない
  昇格トリガー抵触   なし（P-1〜P-6。exceededResources は①②とも 0 件）

【未達項目の処置】
  - 最大CPU時間: 原因 production を作った直後の最初のリクエストで data-api が単体 11.30 ms（エラーなし）。落ち着いた状態の再測では単体で割らない
                  帰属 実装が悪いとも線が悪いとも決めない。線は「合算か独立か（F-1）」が未確定のまま引いてあり、合算の上界（3 Worker の max の和 9.36 ms）では余裕 0.64 ms
                / 処置 昇格しない（2026-09-15 所有者の判断）。週次チェック（06 §5.1）で CPU 時間の max を見続け、F-1 が確定したとき・gateway に認可が入ったとき（M2）に測り直す。
                  exceededResources が出たら P-1 として議論せず上げる / Issue なし（運用で見る） / 送り先 M2
  - 全PRの Closes: 原因 マージ済み 36 本のうち 15 本。12 本は監督側（人と Claude）が運用文書・CI・orchestrate の設定を Issue なしで出した
                  （#1・#29〜#31・#34・#39・#41〜#43・#45・#48・#71）。3 本は Issue を閉じない途中の PR で Refs を持つ（#60・#63・#64）
                  帰属 線は妥当。監督側が「作業は必ず Issue から」（CLAUDE.md）を外した
                / 処置（2026-09-15 所有者が承認。CLAUDE.md「手順」に追記）M1 からは監督側の変更も Issue を立てる。途中の PR は「その Issue を閉じる PR が Closes を持つ」ことを条件に Refs を許す
                  / Issue なし（運用） / 送り先 M1

【M1へ持ち越したIssue】
  - #19 商標・#20 ドメイン・#33 ゾーン委任（理由: 名称の扱いを M1 で決着させ、ドメインを取ってから改名する）
  - #38 テンプレート tarball の SHA-256 の固定（理由: M1 の Form A で使う）
  - #23 Google OAuth のクライアント（M2）、#22 LINE（保留）、#27 promotion_decision の計測（M2）、#28 CI トークンの絞り直し（M3）

【M0で判明した想定外】
  - アカウント②で R2 が未契約で、production の apply の前に契約が要った（旧記録は tfstate だけを見ていた）
  - アカウント②の workers.dev のサブドメインが Worker 名から推測できる形で自動作成された → ランダムな名前へ作り直した
  - wrangler deploy は配備後に workers.dev の URL を表示する → deploy-worker.ts で伏せた
  - turbo が CLOUDFLARE_ENV を渡さず、キャッシュで host の配備用の設定が消える → host の turbo 設定で直した
  - pr-title が必須チェックに入っていなかった → 加えた
  - cmate-orchestrate の reverify が、外で解消したプロンプトの記録を信じて再判定しない（上流の不具合として記録）
  - Google は LINE 内ブラウザ（埋め込み WebView）での OAuth を拒否する → M2 の設計に外部ブラウザへの移動を入れた
  - 初回デプロイ直後の1回だけ CPU 時間が 10ms を超えた
  - rollback と deploy-production は同じ concurrency の group で、待っていた実行が新しい実行に置き換えられて取り消される
  - 名称の扱いを見直す必要が出た（中身は非公開の記録。M1 で決着）

【M1着手可否】  可（条件: 🧑 M0 クローズの宣言と、M1 ゲートの事前宣言。§7）
```

> **未達をそのまま通さない。** 達成できなかった項目は「なぜ線を外したのか／線が悪かったのか実装が悪かったのか」を分けて記録する。企画書17章の「較正の系譜（12系統）」——**モデルが主犯だった床は局所の数件のみで、大半は機械側の伝達・配線・強制の欠落だった**——と同じ帰属分析を、プラットフォーム側でも初回から始めておく。

---

## 7. M0クローズの宣言

以下がすべて満たされたら、🧑 **人間がM0クローズを宣言**し、M1に着手する。

- [ ] 試験A〜**F** が全項目パス → **満たしていない**（未達 2 件、C-1 は試していない）。§6 の処置を所有者が承認し、例外としてクローズする（下の宣言）
- [x] 清算表を記入し、未達項目の処置が決まっている（2026-09-15）
- [x] Milestone `M0` を close（2026-09-15。#18 を閉じた直後）
- [x] タグ `v0.1.0` が production にデプロイされている（2026-09-14。現在は `v0.1.1`）
- [x] 🧑 **M1のゲートを事前宣言する**：「封緘済みgolden割り勘が staging のスマホで動く」の判定方法・判定者・期限を書き出す（下の宣言）

```
M0 クローズの宣言 — 2026-09-15 Kewton

  M0 をクローズし、M1 に着手する。
  未達 2 件と、試していない C-1 は、§6 の処置を承認したうえでクローズする。
    - 全PRの Closes   提案どおり。M1 からは監督側の変更も Issue を立てる。Issue を閉じない途中の PR は、
                      その Issue を閉じる PR が Closes を持つなら Refs でよい（CLAUDE.md「手順」）
    - 最大CPU時間      昇格しない。週次チェックで見続け、F-1 の確定時と M2 で測り直す（06 §8）
    - C-1             保護は API で確認済み。管理者は迂回できるので、M3 着手時に enforce_admins を true にする（06 §5 B-1）
```

```
M1 ゲートの事前宣言 — 2026-09-15 Kewton

  ゲート    封緘済み golden 割り勘が staging のスマホで動く（企画書22章 M1）
  判定方法  次の 5 つがすべて満たされたら合格
              1. 手持ちのスマホ 1 台で staging の URL を開く（OS とブラウザの名前を記録する）
              2. 封緘済み golden の割り勘を起動する
              3. golden のシナリオどおりにメンバーと支出を入力し、精算結果が golden の期待値と一致する
              4. 再読み込みしても、別の端末（PC など）で開いても、データが残っている（DO に保存されている）
              5. 配られたバンドルの SHA-256 が pins/ の値と一致することを、手ではなく機械（smoke か e2e）で確かめる
  判定者    Kewton
  期限      M1 着手から 2 週間（着手日は M1 に着手したときにここへ書く：____-__-__）
            過ぎたら黙って延ばさない。M0 と同じく清算し、線が悪かったのか実装が悪かったのかを分けて記録する
```
