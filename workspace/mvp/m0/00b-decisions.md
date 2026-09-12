# 🧑 00b：判断だけを集めた1枚（H-14 → H-06 → H-13）

> `00-human-tasks.md` のうち、**手を動かす作業ではなく「決めること」だけ**を抜き出した。
> ここを埋めれば、H-01/H-02/H-03/H-08 の「いくつ作るか・何という名前にするか」が確定する。
> 所要 **10分**。決め終わったら `00-human-tasks.md` の A へ戻る。

---

## ✅ D-1：Cloudflare アカウントを分けるか — H-14 【決定済み 2026-09-12】

**決定：案A。アカウントを2つに分ける。既存アカウントを ①dev+staging に充て、production 用に②を新規作成する。**

| | 構成 |
|---|---|
| **アカウント①**（既存・別アプリ稼働中） | **dev + staging** |
| **アカウント②**（新規） | **production** |

**理由**：Free の上限はアカウント単位なので、同居させると CI のスモークや dev 作業が production の枠（100k req/日・DO 合計5GB・D1 5GB）を削る。分けるコストは今だけ約25分（アカウント作成15分＋トークン2本増で約10分）で、費用は増えない。一方、後から production を別アカウントへ動かすのは **D1／R2／DO のデータ移行**になり、金額ではなく「移行中に壊すリスク」を伴う。**production が空である今が、コストゼロで選べる唯一のタイミング。**

既存アカウントを①に充てるのは、production を**何も動いていない新規アカウント**から始めるため。

### この決定で確定したもの

| | 確定値 |
|---|---|
| H-01 作る Cloudflare アカウント | **2つ**（既存①＋新規②） |
| H-02 発行する API トークン | **4本**（`musubi-tf-dev` / `musubi-ci-dev` / `musubi-tf-prod` / `musubi-ci-prod`） |
| H-08 Secrets | **6件**（`*_PROD` 2件を含む） |
| H-08 Variables | **5件**。`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_ACCOUNT_ID_PROD` は**別の値**になる |
| H-03 tfstate バケット | **アカウント①に1つだけ**でよい（backend 認証と provider 認証は別系統なので、②の state も①のバケットに置ける） |

### ✅ 前提の確認結果（2026-09-12 実測）

**1ログインで2つ目のアカウントを作れる。** ダッシュボード左上のアカウント切替メニューに **「＋ Create Account」** が存在することを実画面で確認した。

- **エイリアスメールは不要。** 既存のログインのまま②を作れる
- **2FA はログイン単位なので1回で済む**（H-01 の 2FA 有効化はアカウント②のために繰り返す必要がない）
- ②の作成コストは想定より小さい。案A の「今かかる手間 約25分」はこれで上限側の見積もりになった

**決定：☑ A（①dev+staging ／ ②production）　既存アカウントの用途：☑ ①dev+staging　　決定日：2026-09-12**


---

## ✅ D-2：リポジトリの可視性 — H-06 【決定済み 2026-09-12】

**決定：`Kewton/Musubi` は public のまま。非公開にしたい文書だけ private リポジトリ `Kewton/Musubi-workspace` に分ける。**

### 何を分けたか

| リポジトリ | 可視性 | 中身 | CI |
|---|---|---|---|
| `Kewton/Musubi` | public | コード・Terraform・CI・M0構築手順書 | 回す（承認ゲート維持） |
| `Kewton/Musubi-workspace` | **private** | `proposal/`（企画書）・`legal/`（商標）・`naming/`（名称・ドメイン） | **回さない** |

### なぜ「全部 private」にしなかったか

GitHub Free では private リポジトリで Environments が使えない。しかも既に設定済みの場合、

> "If you convert a repository from public to private, any configured protection rules or environment secrets will be ignored, and you will not be able to configure any environments."
> — https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments

つまり public → private にした瞬間、H-07 で設定した `production` の必須レビュワーと `v*` タグ制限が**エラーも警告もなく無視される**。承認ゲートが外れたことに気づけないまま、タグが本番へ流れる。

### 3つの衝突がどう解けたか

| | 主張 | 解決 |
|---|---|---|
| H-06 | 企画書・商標を公開したくない | ✅ private リポジトリへ分離 |
| H-07 | production は必須レビュワーで承認待ち | ✅ 公開側に残したので維持 |
| H-13 | M0 のインフラ費は **$0** | ✅ GitHub Pro 不要。$0 のまま |

検討した他の出口：**①GitHub Pro $4/月**（解決はするが、案の分離で $0 のまま同じ結果になるため不要）／**③private＋承認ゲート放棄**（M0 の DoD を満たせず、かつ壊れたことに気づけない壊れ方なので却下）。

### 分離の運用規律

- 公開側に**結論を書かない**：商標のリスク評価・先行権利者名、企画書の数値・価格・moat 仮説、名称の代替候補。タスクの存在（H-05 をやる）までは公開側でよい
- 公開側から非公開側へ**相対リンクを張らない**。参照はリポジトリ名を書くだけ
- 非公開側では **CI を回さない**（Environments が要る作業は公開側だけ）
- **CIログも public** になる。Variables はマスクされない → [`04-cicd.md`](./04-cicd.md) §3.1

**決定：☑ public のまま ＋ 非公開文書を別 private リポジトリへ分離　　決定日：2026-09-12**


---

## ✅ D-3：予算方針 — H-13 【決定済み 2026-09-12】

### 1. 事前宣言：M0 期間の月額インフラ費は **$0**

内訳と、$0 がどこまで保証されるか：

| 費目 | 月額 | $0 の性質 |
|---|---|---|
| Cloudflare Workers / DO / D1 / Queues | **$0** | Free プランの枠内。超えたら止まる（課金されない） |
| Cloudflare R2 | **$0 目標** | ⚠️ **従量課金。無料枠を超えると自動課金される。請求のハード上限ではない** |
| GitHub Actions | **$0** | public リポジトリのため無制限無料。加えて spending limit は既定 $0 のハードキャップ |
| GitHub Pro | **不要** | D-2 で public 維持＋非公開文書の分離を選んだため、$4/月は発生しない |

**唯一の課金経路は R2 の無料枠超過。** ここだけは上限を $0 に固定できないので、週次で使用量を見る（下記3）。

### 2. 昇格トリガーを承認（8件すべて）

[`06-plan-and-limits.md`](./06-plan-and-limits.md) §5 の **P-1〜P-6（Workers Paid $5/月）および W-1・W-2（＋WfP $25/月）を、内容を確認のうえ承認した。**

**触れたら議論せず即上げる。**「まだいける」と粘って障害を出すのが最悪の結果、という前提を受け入れた。特に **P-5（M4 公開の着手が決まったら無条件で先に上げる）** は、実測値に関係なく先回りする唯一の項目である。

### 3. 運用

| | 決定 |
|---|---|
| **トリガー抵触時の即決者** | **Kewton（本人）。1人開発につき、その場で即決し議論しない** |
| **無償枠を見る日** | **毎週月曜**（週初に確認し、その週の作業計画へ反映する。所要5分。手順は [`06`](./06-plan-and-limits.md) §5.1） |

**決定：☑ 承認　　決定日：2026-09-12**

> 「まだいける」と粘った瞬間に無償枠は障害になる。判定線を MVP 開始前に固定する。


---

## 決め終わったら

```bash
# 1. トークン発行後の検証（値は画面にもAIにも出ない）
./workspace/mvp/m0/scripts/verify-cf-credentials.sh

# 2. Secrets / Variables 登録（Claude Code なら先頭に ! を付けて自分の手で実行）
./workspace/mvp/m0/scripts/setup-github-secrets.sh
```

残る人間タスクは H-01・H-02・H-03・H-04（＋ 先行取得の H-05・H-10・H-11・H-12）。
`main` ブランチ保護（H-07 の残り）は **最初のコミットが push された後**にしか掛けられないので、`01-repo-bootstrap.md` の骨格を push した直後に適用する。
