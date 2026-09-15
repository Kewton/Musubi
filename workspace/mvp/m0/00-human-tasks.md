# 00：初期設定・判断タスク（AI代行可・先行必須）

> **ここが M0 のクリティカルパス。** Terraform（`02`）の実環境への適用には、アカウント・認証・state 置き場が必要。ローカルでの設計、設定ファイル作成、検証準備は先行できる。
> D1（初日）にまとめて片付けることを強く推奨する。所要時間の合計は **正味 2〜3時間**（審査待ちを除く）。
>
> **費用目標：M0 は Workers Free と R2 の無料枠内で $0。** R2 は別途利用申込みが必要で、無料枠超過分は自動課金される。支払い登録不要・課金上限 $0 は保証できない。契約判断は H-03 / H-13 で行う。
> プラン・上限・昇格トリガーの正本は [`06-plan-and-limits.md`](./06-plan-and-limits.md)。

> ---
> **🤖 2026-09-08 AI代行分の実施状況**（詳細は各ファイルへ）
>
> | 済 | 内容 | 参照 |
> |---|---|---|
> | ✅ | H-07 のうち **squash-onlyマージ設定・Environments（staging / production＋必須レビュワー Kewton・`v*` タグポリシー）・Milestone M0〜M3・Label 5種** を適用済み。タグポリシーと Actions の read 権限は今回再確認 | [`00e-execution-status.md`](./00e-execution-status.md) |
> | ✅ | H-07 の **main ブランチ保護を適用済み**（2026-09-12・初回push直後）。必須チェックは `lint-typecheck-unit`。`terraform-plan` は 02 完了後に追加する | [`scripts/protect-main.sh`](./scripts/protect-main.sh) |
> | ✅ | H-12 の「所在・アクセス権の確認」完了。`pins/commandagent.json` プレースホルダ作成済み | [`00c-h12-commandagent.md`](./00c-h12-commandagent.md) |
> | ⚠️ | H-04 の候補 **`musubi.app` は既に登録済み**。主要TLDは軒並み埋まっている | [`00d-h04-domain.md`](./00d-h04-domain.md) |
> | 🚨 | H-05 の予備調査を実施。**結果は要対応。名称の継続可否（N-1）と一体で判断する** | 非公開リポジトリ `Kewton/Musubi-workspace` の `legal/` |
> | ✅ | **H-14 決定（2026-09-12）：案A。①dev+staging＝既存アカウント／②production＝新規作成。** これで H-01=2つ・H-02=4本・H-08=6件が確定 | [`00b-decisions.md`](./00b-decisions.md) D-1 |
> | ✅ | **H-06 × H-07 × H-13 の衝突は解決済み（2026-09-12）。** 公開側は public のまま承認ゲートを維持し、非公開文書だけ private リポジトリ `Kewton/Musubi-workspace` へ分離。費用 $0 のまま | [`00b-decisions.md`](./00b-decisions.md) D-2 |
> | 📋 | H-14 / H-06 / H-13 の**判断だけを1枚に集約**。ここを10分で埋めると H-01〜H-03・H-08 の個数と名前が確定する | [`00b-decisions.md`](./00b-decisions.md) |
> | 🔧 | H-02 のトークン検証と H-08 の登録を対話スクリプト化（**値はAIの文脈に入らない**） | [`scripts/`](./scripts/) |
> | ✅ | R2申込みを本人承認後に確定。`musubi-tfstate`（非公開・APAC・Standard）とバケット限定キーを作成し、GitHubにR2 Secrets 2件・Variables 3件を登録。S3の一覧・書込み・読取り・削除を実測済み | [`00e`](./00e-execution-status.md) |
>
> **今回の確認結果**：Cloudflare の既存ログインを利用可能。R2契約は承認・実施済み。H-01/H-02/H-03/H-08 の設定操作はAIが代行できる。アカウント全体の環境分離・公開範囲は未確定。本人確認が要求される箇所は本人操作が必要。詳細・未完了項目は [`00e-execution-status.md`](./00e-execution-status.md)。
> ---

## AIが代行できる範囲と本人操作が必要な箇所

| 分類 | 理由 |
|---|---|
| **契約・支払い** | AIが申込み内容を確認・準備できる。費用条件が未承認の契約は本人が判断する。R2 は無料枠付きの従量課金契約 |
| **本人確認・アカウント発行** | ログイン済み画面の設定は代行可能。メール/SMS認証・2FA端末操作などは本人が対応する |
| **シークレットの原本取得** | トークンは値をチャット・ログに表示せず発行元から許可された保管先へ受け渡せる場合に代行可能。値の貼り付けは不要 |
| **事業判断** | 予算・名称・公開範囲などの未確定事項を確認する。決定済みの設定はAIが実行する |
| **stateの初期作成** | backend が参照するバケットは初回 init より前に作成する。API/CLIまたは独立したローカルstateのbootstrapで作成可能で、手動操作は必須ではない |

---

## A. 即着手（M0のブロッカー）

### 🧑 H-01：Cloudflare アカウント作成（**Free プラン・課金なし**）

> **H-14 は案A で決定済み（2026-09-12）。作るアカウントは2つ。**

- [x] **アカウント①（dev + staging）＝ 既存アカウントを充てる**。Account ID は取得済み（`.env` と GitHub Variable `CLOUDFLARE_ACCOUNT_ID`）
- [x] 🧑 **アカウント②（production）を新規作成** — **2026-09-12 完了**。Free・支払い手段なし。既存ログイン配下に作成（エイリアスメール不要）
- [x] 🧑 **2FA を有効化** — **2026-09-12 完了**。ログイン単位なので①②の両方に効く
- [x] **アカウント②の Account ID** を控える — GitHub Variable `CLOUDFLARE_ACCOUNT_ID_PROD` と `.env` に登録済み（2026-09-12）

> **訂正（2026-09-14・#4）：② でも R2 を有効化した。** tfstate の置き場は①のバケット1つで足りる（backend 認証と provider 認証は別系統）が、
> **production のアプリ用バケット（BUNDLES / UPLOADS）は資源と同じアカウント②に作る**（`musubi-env` モジュール）。
> 当初の「② では R2 を有効化しない」は tfstate だけを見た判断で、この2つが漏れていた。②が未有効のまま apply すると
> D1・Queue・KV だけ作られて R2 で失敗する（API は `10042 Please enable R2 through the Cloudflare Dashboard` を返した）。
> 🧑 本人が②で R2 の利用契約を追加（2026-09-14）。条件は①と同じ無料枠付き従量課金。**②で R2 の S3 キーは作らない**（state は①）。

> **M0 が Free で足りる根拠**（詳細は [`06-plan-and-limits.md`](./06-plan-and-limits.md) §2）
> Workers・SQLite型 Durable Objects・D1・R2・Queues はすべて Free で使える。**M0で有償が要るコンポーネントは1つも無い。**
> Workers for Platforms（$25/月）は、企画書12章の確定仕様「**L1-L2ではコードを1行も生成しない**」により MVP の3アプリ（全部L2）では不要。実際に要るのは L3 解禁時＝ M5〜M6。R2 の無料枠超過時課金はこれとは別に扱う。
>
> **やらないこと**：Workers Paid への加入。M2後半以降、[`06`](./06-plan-and-limits.md) §5 の昇格トリガー（P-1〜P-6）に触れた時点で上げる。**先回りで課金しない。**

**成果物**：`CLOUDFLARE_ACCOUNT_ID`（①）と `CLOUDFLARE_ACCOUNT_ID_PROD`（②）— **両方とも取得・登録済み（2026-09-12）**

---

### 🧑 H-02：Cloudflare API トークン発行（**テンプレート「Edit Cloudflare Workers」を土台にする**）

権限を1つずつ選ぶ必要はない。**テンプレートで土台を作り、足りない分だけ足す**のが最短。1本あたり **2〜3分**。

#### 発行の共通手順

1. ダッシュボード → 右上のアイコン → **My Profile** → **API Tokens** → **Create Token**
2. テンプレート一覧から **「Edit Cloudflare Workers」→ Use template**
3. 下の §①/§② に従って差分を足し、**Account Resources を対象アカウントに限定**して発行

> **なぜこのテンプレートか**：Musubi が Free で使う構成要素（Workers・R2・KV・Workers Routes）がほぼそのまま入っており、**Musubi の構成に対する被覆率が最も高い**。不足するのは D1・Queues・Turnstile・DNS だけで、これは「＋ Add more」から数クリックで足せる。

---

#### ① Terraform用トークン（`TF_CLOUDFLARE_API_TOKEN`）

**テンプレート「Edit Cloudflare Workers」を適用したうえで、以下を確認・追加する。**

| 権限 | テンプレに含まれるか | 対応 |
|---|---|---|
| Account / `Workers Scripts: Edit` | ✅ 含まれる | そのまま |
| Account / `Workers KV Storage: Edit` | ✅ 含まれる | そのまま |
| Account / `Workers R2 Storage: Edit` | ✅ 含まれる | そのまま |
| Account / `Account Settings: Read` | ✅ 含まれる | そのまま |
| Zone / `Workers Routes: Edit` | ✅ 含まれる | H-04 前は使わないが残してよい |
| Account / **`D1: Edit`** | ⚠️ **要確認** | 無ければ「＋ Add more」で追加（**必須**） |
| Account / **`Queues: Edit`** | ⚠️ **要確認** | 無ければ追加（M0で Queue の器を作る） |
| Account / **`Turnstile: Edit`** | ❌ 含まれない想定 | 追加（M4で使うが、Terraform管理下に置くため今から） |
| Zone / **`DNS: Edit`** ＋ `Zone: Read` | ❌ 含まれない | **H-04（ドメイン取得）後に追加**。それまで不要 |
| Account / `Workers for Platforms: Edit` | — | **追加しない**（有償・M5〜M6） |

- [ ] Account Resources：**Include → 対象アカウント1つだけ**（All accounts にしない）
- [ ] TTL：**90日**を設定（§共通事項）
- [ ] 名前：`musubi-tf-dev`（アカウント①）／`musubi-tf-prod`（アカウント②）— **2本とも必要**

> ⚠️ **「要確認」の意味**：`Edit Cloudflare Workers` テンプレートの中身は Cloudflare 側で更新されており、D1 や Queues が含まれる版と含まれない版がある。**画面に出ている実際の一覧を見て判断すること。** 迷ったら足しておく（Terraform用トークンなので過不足は「不足」のほうが痛い）。

---

#### ② CI（デプロイ）用トークン（`CLOUDFLARE_API_TOKEN`）

**テンプレート「Edit Cloudflare Workers」をほぼそのまま使う。**

| 権限 | 対応 |
|---|---|
| テンプレートの内容一式 | そのまま |
| Account / **`D1: Edit`** | 無ければ追加（**マイグレーション適用に必須**） |
| Zone / `DNS: Edit` | **追加しない** ← ここが①との違い |
| Account / `Turnstile: Edit` / `Queues: Edit` | **追加しない**（CIは資源を作らない） |

- [ ] Account Resources：**Include → 対象アカウント1つだけ**
- [ ] TTL：**90日**
- [ ] 名前：`musubi-ci-dev`（アカウント①）／`musubi-ci-prod`（アカウント②）— **2本とも必要**

---

#### テンプレートを使うことのトレードオフ（承知したうえで選ぶ）

テンプレートは手作業で選ぶより**広い**権限を含む。具体的には、CIトークンが **R2バケットやKV名前空間を削除できる**状態になる。

| | 手で最小構成を組む | **テンプレート（採用）** |
|---|---|---|
| 発行時間 | 1本あたり10分・選択ミスしやすい | **2〜3分・ミスしにくい** |
| CIトークンの権限 | Workers Scripts / D1 / R2 のみ | ＋ KV削除・R2バケット削除も可能 |
| 漏洩時の最悪ケース | Workerの上書き | **R2/KVのデータ破壊** |

**それでもテンプレートを推す理由**：M0の実態（1人開発・Free・データはまだ空）では、最小構成を手で組む時間とミスのコストのほうが大きい。そして下の3点で最悪ケースを抑えられる。

1. **アカウント分離**（🧑 H-14 案A）— staging用CIトークンが漏れても **production のデータには届かない**。テンプレートの広さを、アカウント境界で相殺する
2. **DNS権限だけは絶対に足さない**（②）— ドメイン乗っ取り経路をCIから外す。企画書12章「本番資格情報を一切置かない」の線をここに引く
3. **TTL 90日** — 失効が既定になる

> **M3（ドッグフーディング＝実データが入る）着手前に、②を手組みの最小構成へ絞り直す。** これをIssue化して M3 のMilestoneに置いておくこと。今は速さを取り、データが乗る前に締める。

---

#### 共通事項

- [ ] **TTL（有効期限）を必ず設定する**：90日。カレンダーに更新リマインダを入れる
      → 無期限トークンは、漏洩に気づかない限り永久に有効。**失効を既定にする**
- [ ] **命名規則**：`musubi-<用途>-<アカウント>` （例 `musubi-tf-dev` / `musubi-ci-prod`）
      → GitHub Secrets 名（`TF_CLOUDFLARE_API_TOKEN` / `..._PROD`）との対応を H-08 の表と揃える
- [ ] **IP制限**は設定しない（GitHub Actions の送信元IPは固定できない）
- [ ] トークン文字列は発行時に**一度しか表示されない**。パスワードマネージャに保管し、**チャットやコミットに貼らない**

#### 発行直後に検証する（CIで失敗して気づくのを避ける）

> **4本まとめて検証するなら** `python3 workspace/mvp/m0/scripts/verify-cf-tokens.py`。
> `.env` から読み、**値を一切表示せず**に「active か／失効日／想定アカウントへ届くか／**もう一方のアカウントへ届かないか**」を判定する。
> 最後の1つが H-14 案A の分離が実効かどうかの試験であり、ここが通らなければ Account Resources が `All accounts` になっている。


```bash
TOKEN='<発行したトークン>'
ACCOUNT_ID='<H-01 の Account ID>'

# ① トークンが有効か
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $TOKEN" | jq '.success, .result.status'
# → true, "active"

# ② D1 に届くか（Terraform・CI とも必須の権限）
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" \
  -H "Authorization: Bearer $TOKEN" | jq '.success, .errors'
# → true, []   ← false や 権限エラーなら D1: Edit が抜けている

# ③ R2 に届くか
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2/buckets" \
  -H "Authorization: Bearer $TOKEN" | jq '.success, .errors'
```

> ②の失敗時は権限・対象アカウント・APIエラーを確認する。GET の成功は参照疎通を示すだけで、`D1: Edit` の証明ではない。編集権限は発行時の一覧と適用時に別途確認する。R2の失敗は未契約でも起きるため、権限不足と断定しない。

#### トークンは合計4本（H-14＝案A 確定）

トークンはアカウント単位なので **合計4本**。同じテンプレートから4回発行するだけ：

| 名前 | 用途 | GitHub Secret 名 |
|---|---|---|
| `musubi-tf-dev` | アカウント①（dev+staging）のTerraform | `TF_CLOUDFLARE_API_TOKEN` |
| `musubi-ci-dev` | アカウント①のCIデプロイ | `CLOUDFLARE_API_TOKEN` |
| `musubi-tf-prod` | アカウント②（production）のTerraform | `TF_CLOUDFLARE_API_TOKEN_PROD`（**GitHub に置かない**。手元の `.env` のみ） |
| `musubi-ci-prod` | アカウント②のCIデプロイ | `CLOUDFLARE_API_TOKEN_PROD`（**`production` 環境 Secret**） |

増えるのは10分程度。

> **2026-09-12 実測による訂正**：トークンは **My Profile → API Tokens（User API Tokens）** という**ログイン単位の1画面**から作る。アカウント①と②は同一ログイン配下なので、**「②にログインし直す」必要はない。** 4本すべて同じ画面から作り、各トークンの **Account Resources** で対象アカウントを明示的に選び分ける。
> URL：`https://dash.cloudflare.com/profile/api-tokens`
> **Account Resources の選択が唯一の切り分け手段**なので、ここを間違えると `musubi-*-prod` が①向けになる。発行のたびに確認すること。②は先に作っておかないとこの一覧に出てこない（→ H-01）。

#### ローカル開発にトークンは要らない

`wrangler` はブラウザOAuthでログインできる。**手元の作業のためにトークンを作らない。**

```bash
pnpm exec wrangler login     # ブラウザが開いてOAuth。トークン管理が不要になる
pnpm exec wrangler whoami    # どのアカウントに繋がっているか確認（H-14で2つある場合は特に重要）
```

> トークンが要るのは **Terraform と GitHub Actions だけ**。この線引きで、手元に置く秘密が減る。

**成果物**：2本（H-14で分離するなら4本）のトークン文字列（→ H-08 で GitHub Secrets へ）

---

### 🧑🤖 H-03：Terraform state 用 R2 バケットの初期作成（AI代行可）

- [x] R2 の利用状態を確認し、無料枠と超過料金について本人承認を得て申込みを確定（**2026-09-08：既存アカウントで有効化済み**）
- [x] R2 で `musubi-tfstate` バケットを作成（APAC・Standard・Public Access Disabled）
- [x] state のバックアップ・復元手順を用意する（R2 はバケットバージョニング未対応。apply 前後の state を別キーに退避し、`02` 実装時に復元検証する）— **2026-09-14・#4**：`infra/scripts/tfstate-backup.sh`（手順は `infra/terraform/README.md` §3）。staging / production の apply 前後で実行し、`verify` で復元に使えることを確認
- [x] S3互換の **Access Key ID / Secret Access Key** を発行（Account API Token名：`musubi-tfstate`。`Object Read & Write`、対象バケットのみ、期限2026-12-07、IP制限なし）
- [x] R2 の S3 エンドポイントを `.env` とGitHub Variable `R2_S3_ENDPOINT` に保存
- [x] S3疎通を検証（一時オブジェクトの一覧・書込み・読取り・削除成功）。再検証：`python3 workspace/mvp/m0/scripts/verify-r2-credentials.py`

> **bootstrap の理由**：backend のバケットは初回 init の前に存在する必要がある。AIによるAPI/CLI作成も可能。`05` の環境再現試験では、この初期作成を前提条件として扱う。
> **仕様訂正**：R2 の `PutBucketVersioning` は未対応。バージョニングONを完了条件にしない。[R2 S3 API対応表](https://developers.cloudflare.com/r2/api/s3/api/)
> **費用条件**：R2 は無料枠付きの従量課金。2026-09-08、登録済み支払い方法・月額 $0 ＋超過分の条件を本人が承認し、契約を確定した。Workers Paid / WfP の有効化はこの承認に含めない。[R2開始手順](https://developers.cloudflare.com/r2/get-started/)
> **注意**：ここで作るのは **R2 の S3互換アクセスキー**であり、H-02 の API トークンとは**別系統・テンプレートも無い**。R2 の画面から発行する。権限は `Object Read & Write`、対象を `musubi-tfstate` バケットに限定すること。

**成果物**：`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / R2 S3 endpoint

---

### 🧑 H-04：ドメイン取得 ＋ Cloudflare へのゾーン委任

- [ ] ドメインを取得（`musubi.app` 等。**H-05 の商標クリアランス結果と整合させる**）
- [ ] Cloudflare にサイトを追加し、レジストラ側のネームサーバを Cloudflare のものへ変更
- [ ] ゾーンが `Active` になったら **Zone ID** を控える

> **ドメインが未確定でもM0は止めない。** その場合は `*.workers.dev` の既定ドメインで M0-1〜M0-4 を完遂し、Terraform の `zone_id` / DNS リソースだけを `count = var.custom_domain_enabled ? 1 : 0` でゲートしておく（`02-terraform.md` §6 に実装あり）。カスタムドメインの結線は後日 `terraform apply` 1回で入る。
> **サブドメイン設計（推奨）**：`app.musubi.app`（prod host）／`stg.musubi.app`（staging host）／`api.musubi.app`（prod gateway）／`api.stg.musubi.app`（staging gateway）。dev は workers.dev のまま。

**成果物**：`CLOUDFLARE_ZONE_ID`（取得できた場合）

---

### ✅ H-06：リポジトリの可視性 — **決定済み（2026-09-12）**

**決定：`Kewton/Musubi` は public のまま。非公開にしたい文書だけを private リポジトリ `Kewton/Musubi-workspace` へ分離する。**

| | リポジトリ | 可視性 | 中身 |
|---|---|---|---|
| 公開 | `Kewton/Musubi` | **public** | コード・Terraform・CI・M0構築手順書（`workspace/mvp/`） |
| 非公開 | `Kewton/Musubi-workspace` | **private** | 企画書（`proposal/`）・商標（`legal/`）・名称検討（`naming/`） |

**なぜこの形か**：GitHub Free では private リポジトリに Environments を置けず、public→private へ変換すると**設定済みの保護ルールが警告なく無視される**（H-07 の production 承認ゲートが黙って外れる）。2つに分ければ、承認ゲートを維持したまま費用 $0 で非公開化できる。GitHub Pro（$4/月）に上げる必要もない。

**分離コストが小さい理由**：非公開にしたいのは企画書・商標・名称の3系統だけで、これらはコードと同じ速度では変わらない。構築手順書は公開側に残すので、「手順書とコードの同期が割れる」という負債は発生しない。

- [x] 決定して実行（private リポジトリ作成・3系統の移動・push 完了）
- [x] 公開側に残った結論の削除（商標の権利者名・リスク評価を `00d` とヘッダ表から除去）
- [x] `.gitignore` に `workspace/proposal/` `workspace/legal/` を追加（再混入の防止）

> **公開側に書かないもの**：商標の結論（リスク評価・先行権利者名）、企画書の数値・価格・moat 仮説、名称の代替候補。**タスクの存在（H-05 をやる）までは公開側でよい。**
> **公開側から非公開側へ相対リンクを張らない。** 参照はリポジトリ名を書くだけにする（リンク切れとして痕跡を残さないため）。
> **CIログも public になる。** Variables はマスクされないので、`terraform plan` の出力と変数の扱いは [`04-cicd.md`](./04-cicd.md) §3.1 の規律に従う。

---

### 🧑🤖 H-07：GitHub リポジトリ設定（AIがコマンドを用意・実行はどちらでも可）

`gh` は `repo` scope 認証済みなので **AIが代行実行できる**。ただし**保護ルールとレビュワー指定は運用ポリシーの決定**なので、内容の承認は人間が行う。

- [ ] `main` ブランチ保護：通常の直接push禁止・PR必須・required status checks（`lint-typecheck-unit` / `terraform-plan`）。管理者の緊急時バイパスは `01` §5 の方針に従う。main は未作成
- [x] squash merge のみ許可
- [x] Environments を2つ作成：`staging`（保護なし・自動デプロイ）／`production`（**required reviewers = Kewton**・`v*` **タグ**のみ許可。2026-09-08 に誤ったブランチ指定を修正）
- [x] Actions の権限：`Read repository contents and packages permissions`（各ワークフローで必要な権限だけ昇格。2026-09-08 実測）

→ 具体的なコマンドは [`01-repo-bootstrap.md`](./01-repo-bootstrap.md) §5。

---

### 🧑 H-08：GitHub Secrets / Variables 登録

> **2026-09-14 に置き場所を変更した**（`04` §3・§3.1・§7）。**Account ID は公開しない**ので Secret へ、
> **本番の資格情報は `production` 環境**へ移した。登録は `scripts/setup-github-secrets.sh`（置き場所の規則を内蔵）。

**リポジトリ Secret**（同じリポジトリのすべてのワークフローから届く）

| 名前 | 中身 | 出所 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | CI用トークン（アカウント①） | H-02 ② |
| `TF_CLOUDFLARE_API_TOKEN` | Terraform用トークン（アカウント①） | H-02 ① |
| `R2_ACCESS_KEY_ID` | tfstate用 | H-03 |
| `R2_SECRET_ACCESS_KEY` | tfstate用 | H-03 |
| `CLOUDFLARE_ACCOUNT_ID` | アカウント①の ID。**Variable にしない**（ログに平文で出る） | H-01 |
| `R2_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`。URL に Account ID を含む | H-03 |

**`production` 環境 Secret**（`environment: production` を宣言し、`v*` タグで起動し、Kewton が承認したジョブからだけ届く）

| 名前 | 中身 | 出所 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN_PROD` | production用CIトークン（アカウント②） | H-02 ② |
| `CLOUDFLARE_ACCOUNT_ID_PROD` | アカウント②の ID | H-01 |

**GitHub に置かないもの**

| 名前 | 理由 |
|---|---|
| `TF_CLOUDFLARE_API_TOKEN_PROD` | CI で production の plan を回さない（2026-09-14 決定）。production への apply は人が立ち会って手元から（#4）。**手元の `.env` にだけ置く** |

**リポジトリ Variable**（公開してよい値だけ）

| 名前 | 中身 |
|---|---|
| `TFSTATE_BUCKET` | `musubi-tfstate`（`backend.tf` に書かれていて公開済み） |
| `CLOUDFLARE_ZONE_ID` | H-04（保留中。未取得なら空でよい） |

- [x] **2026-09-14：置き場所を変更**。Account ID と R2 エンドポイントを Variable → リポジトリ Secret、本番の2つを `production` 環境 Secret へ移し、`TF_CLOUDFLARE_API_TOKEN_PROD` を GitHub から外した
- [x] **2026-09-12：Secrets 6/6・Variables 4/5 を登録完了。** 値は `.env` から `gh secret set` の標準入力へ直接渡し、チャット・ログ・コマンド引数に出していない。残る Variable は `CLOUDFLARE_ZONE_ID` のみ（H-04 まで空でよい）
- [x] 2026-09-08：Secrets `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` と Variables `CLOUDFLARE_ACCOUNT_ID` / `TFSTATE_BUCKET` / `R2_S3_ENDPOINT` を登録。ローカルの `.env` はGit除外・権限0600。H-02のTerraform/CIトークンおよびproduction向け設定は未登録

> Claude Code のセッションでは `! gh secret set CLOUDFLARE_API_TOKEN --repo Kewton/Musubi` のように `!` プレフィックスで自分の手で実行すれば、値がAIの文脈に入らない。

---

### ✅ H-13：予算方針 — **決定済み（2026-09-12）**

**M0 期間の月額インフラ費を $0 と宣言する。**

| 費目 | 月額 | $0 の性質 |
|---|---|---|
| Workers / DO / D1 / Queues | $0 | Free の枠内。超えたら止まる（課金されない） |
| **R2** | **$0 目標** | ⚠️ **従量課金。無料枠超過分は自動課金。請求のハード上限ではない** |
| GitHub Actions | $0 | public リポジトリのため無制限無料。spending limit も既定 $0 |
| GitHub Pro | 不要 | H-06 で public 維持を選んだため発生しない |

**唯一の課金経路は R2 の無料枠超過。**

- [x] R2 の無料枠・従量課金条件を本人が承認（2026-09-08）。既存支払い方法で申込確定済み（H-03）
- [x] M0期間のインフラ費を **$0** と宣言する
- [x] [`06-plan-and-limits.md`](./06-plan-and-limits.md) §5 の昇格トリガーを**承認**（P-1〜P-6・W-1・W-2 の**8件すべて**）
- [x] トリガー抵触時の即決者：**Kewton（本人）。1人開発につき即決・議論しない**
- [x] 無償枠の消費を見る日：**毎週月曜**（所要5分。手順は [`06`](./06-plan-and-limits.md) §5.1）

> **なぜ「上げる条件」を先に決めたのか**：無償枠は「まだいける」と粘った瞬間に障害になる。企画書16章の「事前宣言→実測→清算」を課金判断にも適用し、**判定線をMVP開始前に固定する**という同じ規律を使う。
> **P-5 だけは性質が違う**：M4（公開）の着手が決まったら、実測値に関係なく**無条件で先に上げる**。公開してから枠を割るのでは遅い。

---

### ✅ H-14：Cloudflare アカウントを分けるか — **決定済み（2026-09-12）**

**決定：案A。①dev+staging（既存アカウント）／②production（新規作成）。**

Free の上限（100k req/日・DO 合計5GB・D1 5GB 等）は**アカウント単位**。同一アカウントに3環境を置くと、CIのスモークやdev作業が production の枠を削る。分けるコストは今だけ約25分だが、後から production を分離すると **D1/R2/DO のデータ移行**になる。production が空の今が唯一のタイミングだった。

| 案 | 構成 | 判定 |
|---|---|---|
| **A** | アカウント① = dev + staging／アカウント② = production | **☑ 採用** |
| B | 3環境とも1アカウント | 後からの分離がデータ移行になるため却下 |
| C | 3環境で3アカウント | トークン6本・state 3系統。M0 には過剰 |

- [x] A / B / C を決める → **A**
- [x] 既存アカウントの用途を決める → **①dev+staging**（production は汚れていない新規から始める）
- [ ] 🧑 H-01 で**アカウント②を作成**する（メール認証は本人操作）
- [ ] 🧑 H-02 のトークンを**アカウントごとに発行**する（合計4本）
- [x] tfstate バケット（H-03）は**アカウント①に1つだけ**でよい（backend認証とprovider認証は別系統なので、②の state も①のバケットに置ける）→ 作成済み

> **確認済み（2026-09-12 実測）**：1ログインで2つ目のアカウントを作れる（アカウント切替メニューの「＋ Create Account」）。**エイリアスメールは不要**で、2FA もログイン単位なので1回で済む。

**成果物**：2つ目の `CLOUDFLARE_ACCOUNT_ID`（＝ `CLOUDFLARE_ACCOUNT_ID_PROD`）

---

## B. 先行取得推奨（M0のブロッカーではないが、審査・反映に時間がかかる）

### 🧑 H-05：商標クリアランス（9類・42類）

企画書20章で **「Musubi」名称の確定条件**。M4（公開）までに決着が必要だが、**ドメイン購入（H-04）の前に着手**するのが合理的。

- [ ] J-PlatPat で 9類・42類の先行商標を自己調査
- [ ] 弁理士に調査を依頼（費用・期間の見積を取る）
- [ ] 結果を**非公開リポジトリ** `Kewton/Musubi-workspace` の `legal/trademark-clearance.md` に記録（**公開側に結論を書かない**）
- [ ] NGだった場合の代替名候補を3つ用意しておく（ドメイン購入前に）

> **既存利用が多い名前空間**（企画書20章）。楽観しない。

### 🧑 H-09：~~Workers for Platforms の有効化~~ → **M0スコープ外（M5〜M6へ延期）**

WfP は **$25/月の有償のみ**。そして企画書12章「L1-L2ではコードを1行も生成しない」により、**MVPの3アプリ（全部L2）はWfPを必要としない**。実際に要るのは L3 server functions と Form B ＝ **M5〜M6**。

M0でやることは「有効化」ではなく「**要らないことを確定させ、要るようになった瞬間を検知できるようにする**」ことだけ：

- [ ] `02` の `wfp_enabled` を **false のまま**にする（Terraformのリソースは `count = 0` で残す）
- [ ] 昇格トリガー W-1・W-2（[`06`](./06-plan-and-limits.md) §5）を承認する（H-13に含む）
- [ ] M2の計測基盤設計に「**promotion_decision の記録件数**」を入れることをIssue化しておく（＝WfP昇格の先行指標。企画書12章のラダー機械強制がそのまま課金判断のセンサーになる）

> M1のForm A（共通ホスト＋アドオン）は、UIが sandboxed module、actions が WfP isolated function。**M1で actions を含むアプリを扱うなら WfP が要る**——が、MVP 3アプリはすべてL2で actions を持たないため、M1のスコープでも不要。**この境界を M1 着手時に再確認すること。**

### 🧑 H-10：LINE Developers（⏸ 保留）

> **⏸ 2026-09-15 保留（本人判断）**：ログインは、プロダクトが軌道に乗り利用者から要望が出るまで **Google OAuth のみ**にする（H-11）。LINE Login はその時点で再開する。

- [ ] LINE Developers アカウント作成・Provider 作成
- [ ] **dev用 LINE Login チャネル**を先行作成（企画書11章「ローカル開発の穴：LINE Login → devチャネル/mock」）
- [ ] Channel ID / Channel Secret を控える（M2でSecretsへ）

> M2で必要になってから作ると、審査・設定確認で数日待たされる。**M0のうちに枠だけ取る。**

### 🧑 H-11：Google Cloud プロジェクト ＋ OAuth 同意画面（M2用・先行。**M2 のログインはこれだけ**）

- [ ] プロジェクト作成・OAuth 同意画面の設定（外部・テストユーザー）
- [ ] dev/staging 用の OAuth クライアントID を先行発行

### 🧑 H-12：CommandAgent 側の接点確定（M1準備）

- [ ] `CommandAgent` リポジトリの所在・アクセス権を確認（本リポジトリからは参照しない＝企画書21章の境界規律）
- [ ] **ピン対象の確定**：`appspec-schema` のバージョン／テンプレ tarball の SHA-256／headless契約のバージョン
- [ ] `pins/commandagent.json` に何を書くかを決める（M0では空のプレースホルダを置くだけ）

---

## C. サマリ：人間タスク一覧

| ID | タスク | ブロッカー？ | 目安 | 完了 |
|---|---|---|---|---|
| H-01 | Cloudflare アカウント・2FA・Account ID | **YES** | 15分 | **✅ 完了**（2026-09-12。①②とも ID 登録済・2FA 有効） |
| H-02 | APIトークン発行（**テンプレ使用**・4本） | **YES** | 10分（分離時20分） | **✅ 発行・検証済**（2026-09-12。**⚠️ TTL 未設定＝無期限。要修正**） |
| H-03 | R2利用申込み判断・tfstateバケット作成＋S3キー発行 | **YES** | 15分 | 初期作成・キー発行・疎通✅／stateバックアップ・復元は `02` で実装 |
| H-04 | ドメイン取得＋ゾーン委任 | 部分（回避策あり） | 30分＋伝播待ち | ⚠️ [`00d`](./00d-h04-domain.md) 参照 |
| H-05 | 商標クリアランス（9類・42類） | NO（M4まで）→ **要前倒し** | 発注15分＋調査数日〜 | **予備調査✅**（結果は非公開リポジトリ `Musubi-workspace` の `legal/`） |
| H-06 | リポジトリ可視性の判断 | **YES**（push前） | 5分 | **✅ 決定・実行済**（2026-09-12。public維持＋`Musubi-workspace` へ分離） |
| H-07 | main保護・Environments設定 | **YES**（CI前） | 15分（AI代行可） | **✅ 完了**（2026-09-12。初回push後にmain保護を適用。⚠️ 管理者bypass可は `01` §8.1） |
| H-08 | Secrets/Variables 登録 | **YES**（CI前） | 15分 | **✅ 完了**（2026-09-12。Secrets 6/6・Variables 4/5。`CLOUDFLARE_ZONE_ID` は H-04 待ち） |
| H-09 | ~~WfP有効化~~ → **M5〜M6へ延期**（M0は不要の確定のみ） | NO | 5分 | ☐ |
| H-10 | LINE Developers dev チャネル | NO | 30分 | ⏸ 保留（2026-09-15。ログインは当面 Google OAuth のみ） |
| H-11 | Google OAuth クライアント | NO（M2まで） | 20分 | ☐ |
| H-12 | CommandAgent 接点・ピン対象の確定 | NO（M1まで） | 30分 | **一部✅**（所在確認済／ピン確定はM1） |
| H-13 | 予算方針（$0宣言）＋昇格トリガーの承認 | **YES** | 10分 | **✅ 完了**（2026-09-12。8件承認・即決者=本人・毎週月曜） |
| H-14 | **Cloudflareアカウントを分けるか決める** | **YES**（今しか選べない） | 10分＋作成15分 | **✅ 決定済**（2026-09-12・案A。②の作成は H-01 で実施） |

**M0 の人間タスク（A. 即着手）は一巡した。** 残る要対応は **H-02 トークンの TTL 設定（⚠️ 4本とも無期限のまま・10分）** のみ。H-01・H-02・H-06・H-08・H-13・H-14 は 2026-09-12 に完了。次は `01-repo-bootstrap.md` の実装へ。

> **H-14 を最初に決める。** アカウントを分けるかで H-01（作る数）・H-02（トークン本数）・H-08（Secret名）が変わる。後から変えると作り直しになる。
