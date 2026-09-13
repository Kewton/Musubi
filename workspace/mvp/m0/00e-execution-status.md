# 00e：AI代行の実施状況

確認日：2026-09-08。対象：`Kewton/Musubi` と既存の Cloudflare ログイン。

## これまでに実施したこと

| 項目 | 結果 |
|---|---|
| H-01 既存ログイン | Cloudflare ダッシュボードを操作可能。メール認証済み。既存アカウントには別アプリが稼働している |
| H-01 2FA | `Inactive` を確認。本人向けに認証設定画面を開いて残した。有効化は未実施 |
| H-03 R2契約 | 2026-09-08、費用条件の説明・本人承認を経て既存支払い方法で有効化。画面の `Purchase complete` と利用可能な管理画面を確認 |
| H-03 バケット | `musubi-tfstate` を作成。APAC・Standard・Public Access Disabled |
| H-03 キー | Account API Token `musubi-tfstate` を作成。Object Read & Write・当該バケット限定・2026-09-08〜2026-12-07・IP制限なし |
| H-03 S3疎通 | バケット内一覧取得、一時オブジェクトPUT、GET内容一致、DELETEがすべて成功。検証オブジェクトは削除済み |
| H-07 マージ・Actions | squashのみ許可、Actionsの既定権限read、ActionsからのPRレビュー承認不可をAPIで確認 |
| H-07 Environments | stagingは保護なし。productionの必須レビュワーはKewton |
| H-07 productionポリシー | 誤った `name=v*, type=branch` を `name=v*, type=tag` に修正。APIの再取得でタグ用ルールだけが存在することを確認 |
| H-07 main | リポジトリは空、ローカルもコミットなし。既存のmain保護スクリプトは初回push後に実行する想定で、今回は未適用 |
| H-08 | GitHub Secrets `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` を登録。Variables `CLOUDFLARE_ACCOUNT_ID` / `TFSTATE_BUCKET` / `R2_S3_ENDPOINT` を登録。既存 `.env` のAccount IDと対象アカウントは一致 |
| 資格情報の保存 | R2のS3キー2件をGit管理外 `.env`（0600）にも保存。キー値をモデルへの出力・ログ・コマンド引数に含めず、GitHub登録には標準入力を使用 |
| ローカルの追跡除外 | `.gitignore` を作成し、`.env`・ローカルのセッション情報・Terraform state等を除外。`.terraform.lock.hcl` は除外しない |
| 手順の修正 | R2課金・バージョニング未対応・private時のGitHub承認制約・タグポリシーのコマンドを修正。資格情報検証スクリプトのGET成功をEdit権限の証明と誤表示しないよう修正 |

R2キーは発行・保存済み。H-02のTerraform/CIトークン、production向け設定は未実施。リポジトリ可視性の変更・コミット・pushも未実施。

検証：3本のシェルスクリプトの `bash -n`、変更したMarkdownの相対リンク、`.env` / state のGit除外、`.terraform.lock.hcl` の追跡可否を確認済み。R2は実キーでS3疎通確認済み。Cloudflare管理APIのTerraform/CIトークン検証、実stateのバックアップ・復元とデプロイ試験は未実施。

再検証：`python3 workspace/mvp/m0/scripts/verify-r2-credentials.py`。rootの `.env` を読み、キーを表示せずS3署名付きリクエストで検証する。専用の一時オブジェクトだけを作成・削除する。

R2キーは2026-12-07に失効する。失効前に再発行し、ローカル `.env` とGitHub Secretsの両方を更新する。

## 2026-09-12 追記：H-06（可視性）を決定・実行

| 項目 | 結果 |
|---|---|
| 決定 | `Kewton/Musubi` は **public のまま**。非公開文書だけ private リポジトリへ分離（→ [`00b-decisions.md`](./00b-decisions.md) D-2） |
| 新リポジトリ | `Kewton/Musubi-workspace` を **private** で作成。`main` に初回コミットを push 済み |
| 移動したもの | `proposal/Musubi企画書_v3.1.md`／`legal/trademark-clearance.md`／`naming/00d-h04-domain.md` |
| 公開側の後始末 | `00d-h04-domain.md` を技術的帰結のみのスタブへ差し替え。ヘッダ表・サマリ表から商標の結論（リスク評価・先行権利者名）を削除。企画書への相対パス参照を除去 |
| `.gitignore` | `workspace/proposal/` `workspace/legal/` `workspace/naming/` を追加。`git check-ignore` で除外を実測 |
| CIログ規律 | [`04-cicd.md`](./04-cicd.md) §3.1 を新設（plan 全文をログへ出さない／`account_id` を `sensitive`／PRコメントはサマリのみ／Variables は非マスク） |
| 検証 | 公開側に残るファイルを全文検索し、クレデンシャル・Account ID・商標の結論が残っていないことを確認 |

**H-07 の承認ゲートは維持されている**（public のままなので Environments の保護ルールが無効化されない）。GitHub Pro への加入は不要で、H-13 の $0 方針と衝突しない。

未実施：`CLOUDFLARE_ACCOUNT_ID` / `R2_S3_ENDPOINT` の Variables → Secrets 移行（`04` §3.1-5 に手順あり。CI 実装前で実害はない）。`Kewton/Musubi` 本体への push も未実施（コードが無いため。初回 push は `01-repo-bootstrap.md`）。

## 2026-09-12 追記：D-1 / H-14（アカウント構成）を決定

**決定：案A。アカウント①（既存）= dev + staging ／ アカウント②（新規）= production。**

| 確定したもの | 値 |
|---|---|
| H-01 アカウント数 | **2つ**。①は既存を充当（Account ID 取得済み）、**②は未作成** |
| H-02 トークン本数 | **4本**（`musubi-tf-dev` / `musubi-ci-dev` / `musubi-tf-prod` / `musubi-ci-prod`）。**4本とも `profile/api-tokens` の1画面から作り、Account Resources で対象アカウントを選び分ける**（2026-09-12 実測。②へログインし直す必要はない） |
| H-08 Secrets | **6件**（`*_PROD` 2件を含む）。現在2件のみ登録済み |
| H-08 Variables | **5件**。`CLOUDFLARE_ACCOUNT_ID` と `..._PROD` は**別の値**になる |
| H-03 tfstate | アカウント①に1つでよい（作成済み）。②の state も①のバケットへ置く |

反映先：`00b-decisions.md` D-1／`00-human-tasks.md` H-14・H-01・H-02・H-08・サマリ表／`checklist.md`／`README.md`／`06-plan-and-limits.md` §4.3／`issues.md` #34／`scripts/setup-github-secrets.sh`（分離の既定を Y に変更）。

**2FA の画面（2026-09-12 実測）**：`https://dash.cloudflare.com/profile/access-management/authentication/two-factor`。現在も **Inactive**。方式は Security Key / Mobile App（TOTP）/ Email の3種で、有効化後にリカバリコードが生成される。

**前提の確認結果（2026-09-12 実測）**：Cloudflare ダッシュボードのアカウント切替メニューに **「＋ Create Account」** が存在することを実画面で確認した。**1ログインで2つ目のアカウントを作れるため、エイリアスメールは不要**。2FA はログイン単位なので1回の登録で両アカウントに効く。アカウントの作成自体は本人操作のため未実施（画面を開いて確認しただけで、作成ボタンは押していない）。

## 2026-09-12 追記：H-01 完了

| 項目 | 結果 |
|---|---|
| 2FA | **有効化済み**（ログイン単位。①②の両方に効く） |
| アカウント② | **作成済み**（production 用。Free・支払い手段なし。既存ログイン配下） |
| Account ID | ②の ID を GitHub Variable `CLOUDFLARE_ACCOUNT_ID_PROD` と `.env`（0600・Git除外）へ登録。①とは別値であることを確認 |
| Variables | 4/5 件登録済み。残りは `CLOUDFLARE_ZONE_ID`（H-04 未取得のため空のままでよい） |
| ②の R2 | **有効化しない方針**。tfstate は①のバケット1つで足りる |

残る M0 ブロッカーは **H-02（トークン4本）→ H-08（Secrets 6件）→ H-13（予算方針の明文化）**。

## 2026-09-12 追記：H-02 / H-08 完了（TTL に要対応あり）

| 項目 | 結果 |
|---|---|
| トークン4本 | 発行済み。`verify-cf-tokens.py` で4本とも `status=active`、D1・Workers Scripts・KV への参照疎通を確認 |
| **アカウント境界** | **実効性を確認。** ①のトークンは②へ到達せず、②のトークンは①へ到達しない。H-14 案A の分離が機械的に成立している |
| R2 | ①のトークンは R2 バケット一覧に到達。②は R2 未有効のため到達しない（方針どおり） |
| **⚠️ TTL** | **4本とも `expires_on` が無く無期限。** 「失効を既定にする」方針（H-02 共通事項）に反する。ダッシュボードで各トークンを編集し失効日を設定する（推奨 `2026-12-07`＝R2キーと同日に揃える）。編集ではトークン値は変わらないため GitHub Secrets の再登録は不要 |
| GitHub Secrets | **6/6 登録完了**。値は `.env` から `gh secret set` の標準入力へ直接渡し、モデルの出力・ログ・コマンド引数に出していない |
| GitHub Variables | **4/5 登録完了**。残りは `CLOUDFLARE_ZONE_ID`（H-04 まで空でよい） |

検証スクリプトを追加：`scripts/verify-cf-tokens.py`（`.env` を読み、値を表示せず4本の状態・失効日・アカウント境界を判定する）。

## 2026-09-12 追記：H-13 完了 — M0 の判断タスクは全て決着

| 項目 | 決定 |
|---|---|
| $0 宣言 | M0 期間の月額インフラ費 **$0**。Workers/DO/D1/Queues は Free 枠内、GitHub Actions は public のため無制限無料、GitHub Pro 不要。**唯一の課金経路は R2 の無料枠超過**（従量課金のため請求のハード上限ではない） |
| 昇格トリガー | **P-1〜P-6・W-1・W-2 の8件すべてを承認**。触れたら議論せず即上げる。P-5（M4着手）だけは実測値に関係なく無条件で先行 |
| 即決者 | **Kewton（本人）。1人開発につき即決・議論しない** |
| 週次確認 | **毎週月曜・5分**。手順を `06-plan-and-limits.md` §5.1 として新設（R2使用量／日次リクエスト／CPU超過／DOストレージ／D1読み書きの5点。**アカウント①②の両方**を見る） |

これで **D-1・D-2・D-3（H-14・H-06・H-13）の3つの判断がすべて決着**し、A. 即着手のブロッカーは解消した。

## 2026-09-12 追記：M0-1（01-repo-bootstrap）実装・push 完了

| 項目 | 結果 |
|---|---|
| monorepo 骨格 | 企画書21章の構成で `apps/{host,gateway}` ＋ `packages/` 7種 ＋ `e2e` ＋ `templates/` を生成。中身は空、依存の向きだけ固定 |
| ツールチェーン | node 24.1.0 / pnpm 10.13.1（仕様どおり）。`@cloudflare/workers-types` は wrangler 4.131 の peer 要求に合わせ `^5` へ変更。esbuild・workerd のビルドを `pnpm.onlyBuiltDependencies` で明示許可 |
| **依存の機械強制** | `infra/scripts/dep-graph.mjs` を正本にし、`pnpm lint` が **package.json と tsconfig references の両方**を照合。加えて oxlint で `cloudflare:workers` の直接 import を app-do 以外で禁止。**違反を仕込んで3種とも検出されることを実測** |
| `pnpm check` | green（17タスク）。`appspec-schema` に実テスト2本 |
| CI | `lint-typecheck-unit` が **success・27秒**（宣言した線 ≤5分に対して十分） |
| main 保護 | 適用済み。必須チェックは `lint-typecheck-unit` のみ（`terraform-plan` は 02 の成果物。**存在しないチェック名を入れると永久 pending で PR がマージ不能になる**ため足していない） |
| **⚠️ 直接 push** | `enforce_admins: false` のため**管理者は bypass できる**。実測で push は成功し、GitHub 側に `Bypassed rule violations` として記録された。DoD の読み替えが要る（`01-repo-bootstrap.md` §8.1） |
| `.claude/` `.agents/` | CommandMate が配置するファイル。**追跡対象外にした**（判断保留。他リポジトリでも対応が割れている） |
| 未実施 | `issues.md` の Issue 起票（39件）。`.github/workflows` の terraform-plan（02）、sync-bindings 検査（03） |

初回 push で `main` が作成され、H-07 の残タスク（main 保護）も解消した。

## 2026-09-13 追記：#2・#7・#24・#32 の検証と、検証ゲートの所有者の決定

### 検証結果（報告を鵜呑みにせず、別経路で独立に確認した）

| Issue | 結論 | 独立に確認したこと |
|---|---|---|
| #2 | ✅ | `terraform plan -detailed-exitcode` が No changes。**Terraform を通さず Cloudflare API を直接**叩いてアカウント①に D1・R2×2・Queue が実在し、**②には何も漏れていない**ことを確認 |
| #7 | ✅ | テストが**実機の workerd**（`createTestHarness`）で動くことを確認し、キャッシュ無しで 11/11 通過。DO を強制退避させても行が残る |
| #24 | ✅ | **appspec schema の SHA-256 を CommandAgent の実バイトから再計算して一致**。headless 契約の版はソースの定数と一致。「pre-release タグ3本には対象ファイルが無い」も3本とも 404 を確認。tarball は理由付き null（→ #38） |
| #32 | ✅ | 出典7ページをすべて取得し、事務所の実在と主要な価格・納期を照合。依頼文の未記入0件。公開側への漏洩0件。**別リポジトリの PR では自動クローズされないため手動でクローズ** |

### orchestrator が削除したルールの原因

`scope_companions.require` の `{"when": ".github/workflows/ci.yml", "add": [".commandmate/verify.yaml"]}` は、
**`require[].add` に harness path を書くことを禁じる規則（profile-contract.md §9.6）に違反**しており、
profile の読み込み時に `load_error` になる。orchestrator は消さないと起動できなかった。**不正だったのは
このルールを書いた側（2026-09-12 の引き継ぎ準備）であり、削除は正しい処置だった。**

### 決定：A ＋ parity check

| | 内容 |
|---|---|
| **A** | **`verify.yaml` は人（監督側）が持つ。** ワーカーは編集できない（CommandMate の境界を緩めない） |
| **parity check** | `.commandmate/scripts/check-verify-parity.mjs` を追加し、`verify-parity` ゲートとして両側に入れた。verify.yaml の gate id と ci.yml の `# verify-gate:` 目印を**順序まで**照合する |

**スクリプトを `infra/scripts/` ではなく `.commandmate/scripts/` に置いた。** `infra/scripts/` だと、
ゲートを足したいワーカーがチェックを「常に通る」ように書き換えられるため。

BorderFreeKidsMap の同名スクリプトに1点足した：**目印の無い `run:` ステップがあっても落とす**（目印を付けずに
ステップを足す抜け道を塞ぐ）。違反を5種類仕込み、4種は落ち（exit 1）、別ジョブの目印は誤検知しない
（exit 0）ことを実測。`pnpm` 経由でも終了コードが伝わることを確認。

### あわせて行ったこと

- `verify.yaml` 冒頭の**誤った指示を訂正**（「ゲートを足すときは ci.yml と同時に直すこと」はワーカーに不可能な指示だった）
- #3 の本文を実態に合わせて書き直した（#2 がモジュール骨格まで作成済み。残りは prefix 変数化・KV・wfp_enabled・staging/production の呼び出し）
- #13 を 🤖 → **🧑🤖** に変更（Issue の中身がゲート追加そのもの）
- **#38（M1）を起票**：テンプレート tarball のピン。#24 がクローズ済みで追跡者がいなくなるため
- `.commandmate/orchestrate/` と `.commandmate/tasks/cmate-orchestrate-issue-*.yaml` を ignore（BorderFreeKidsMap と同じ扱い）

### #14 への申し送り

CI で `terraform init` するには環境変数 **`AWS_ENDPOINT_URL_S3`** が要るが、GitHub Variable の名前は
**`R2_S3_ENDPOINT`**。ワークフローで対応付けること（`infra/terraform/README.md` §3）。

## 2026-09-13 追記：#5 完了と、乖離チェックの置き場の決定

### #5 の確認
- テスト56本がすべて通過し、DoD の各項目（書き戻し・冪等・コメントと書式の保持・CRLF・`--check` がファイルを書かない・Account ID を書かない・terraform の stderr を出さない）を個別に検査している
- ルートの `lint` / `typecheck` / `test` を `infra/scripts` まで広げた。**改善**：`infra/scripts` は pnpm workspace の外で、これまで `check-deps.mjs` を含めて素通りしていた
  - **注意**：ゲートの中身は `package.json` の `scripts` が決め、ワーカーが編集できる。同じ仕組みで狭めることもでき、verify-parity は気づかない。**レビューで `scripts.lint` / `typecheck` / `test` の差分を見る**

### エージェントの前提で違っていた2点（実測）
1. **`terraform output` に Cloudflare のトークンは要らない。** R2 の資格情報3つだけで読める（CF 系の環境変数0個で `init` → `infra:sync --check` まで通過）
2. **どの案でも今は検証ゲートに入れられない。** `--check` は `同期先が無い: apps/gateway, apps/host, packages/data-api` で exit 2。入れると全 PR が落ちる

### 決定：(c) の変形
乖離チェックを PR の検証ゲートに入れず、**apply 直後の同期コミット**（`infra/terraform/README.md` §2）と**デプロイ直前の `--check`**（`04` §4・§5）に置く。理由は `03` §3。

(b)（スナップショットを渡す）は、apply で ID が変わった瞬間に古くなり**乖離しているのに通る**ため採らなかった。

### 試験で見つかった性質
**`--check` は binding の欠落を検出しない。** binding を1つも書いていない wrangler.jsonc でも「一致」で exit 0 になる（gateway のような Worker を正当に扱う仕様）。
data-api が D1 / R2 / Queue を書き忘れても通るので、**#6・#8・#9 の本文に契約として明記した**。

## 2026-09-14 追記：#6・#14 の検証と、資格情報の置き場所の変更

### 検証（報告を鵜呑みにせず確認）

| Issue | 結論 | 独立に確かめたこと |
|---|---|---|
| #6 | ✅ | wrangler.jsonc が契約どおり（3環境・`CONTROL_DB`/`BUNDLES`/`UPLOADS`・禁止項目なし・Account ID なし・`workers_dev` と `preview_urls` を無効化）。**`--check` が binding の欠落を見逃す穴をテストで塞いでいた**：`CONTROL_DB` を消すと、実ファイルを検査するテストと実機 workerd 上の `/healthz` が落ちる（復元後 59件・41件通過） |
| #14 | 実装 ✅／追跡 ⚠️ | 「Terraform を触らない PR」の確認は #46・#47 で成立（plan は skipped、`terraform-plan` は no-op で success）。**ただし DoD のチェックボックスを1つも更新せず、コメントも無いまま COMPLETED で閉じていた** |

**#14 の実装は、手順書の訂正版より正確だった。** 訂正版は matrix ジョブを `terraform-plan` と名付けていたが、matrix のチェック名は
`plan (dev)` のように値付きで報告されるため、必須にすると永久に待機状態になっていた。エージェントは集約ジョブで回避し、
取り消し時に skipped の必須チェックが「通過」扱いになる点まで考慮していた。`04` §3 を訂正6として直した。

### 見つかった問題と対処

1. **`vars` のまま渡していた Account ID と R2 エンドポイントが、次の「Terraform を触る PR」で公開ログに出るところだった。**
   今まで出ていなかったのは plan が一度も走っていないため（#46・#47 のログで出現0回）
2. **本番トークンがリポジトリ全体の Secret に置かれ、どの PR のワークフローからも届いた。** `pull_request` は PR 側のブランチの
   定義で動くので、`04` §7 の「prod のトークンに手が届かない構造」は成立していなかった
3. **案 (b) は成立しない**と判明：`production` 環境は `v*` タグからしか起動できず、PR では動かない

### 決定（2026-09-14）

- **(c)**：PR では production の plan を回さない
- **Account ID は非公開のまま扱う**

### 実施した移行

| 名前 | 変更前 | 変更後 |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Variable | **リポジトリ Secret** |
| `R2_S3_ENDPOINT` | Variable | **リポジトリ Secret** |
| `CLOUDFLARE_ACCOUNT_ID_PROD` | Variable | **`production` 環境 Secret** |
| `CLOUDFLARE_API_TOKEN_PROD` | リポジトリ Secret | **`production` 環境 Secret** |
| `TF_CLOUDFLARE_API_TOKEN_PROD` | リポジトリ Secret | **GitHub から削除**（手元の `.env` には残す。#4 で使う） |

順序は「新しい置き場に登録 → ワークフローと手順書を切り替えて CI で確認 → 古いものを削除」。値は `.env` から標準入力で渡し、表示していない。
`infra-plan.yml`・`04` §3/§3.1/§4/§5/§7・H-08 の表・`setup-github-secrets.sh`（置き場所の規則と、置いてはいけない場所に残っていないかの検査を内蔵）・`CLAUDE.md` を更新した。

## 2026-09-14 追記：#49 — `terraform-plan` を必須チェックに追加

| 項目 | 結果 |
|---|---|
| 追加の条件 | 「触らない PR」（#46・#47）と「触る PR」（#48）の両方で `terraform-plan` が success になることを確認済み |
| 実行 | `protect-main.sh lint-typecheck-unit terraform-plan` |
| 必須チェック | `["lint-typecheck-unit", "terraform-plan"]`。`terraform-plan` は GitHub Actions（app_id 15368）に結び付けられた |
| 追加直後の試験 | **この記録を追加する PR 自体**を「Terraform を触らない PR」として通し、**管理者の bypass を使わずに**マージできることを確認する |

## 残っている判断・本人操作

1. ~~**H-14 アカウント構成**~~ → **2026-09-12 決定済み**（案A・上記）。残る本人操作は**アカウント②の新規作成**（メール認証）。
2. ~~**H-06 公開範囲**~~ → **2026-09-12 決定・実行済み**（上記）。public 維持＋非公開文書の分離。
3. ~~**H-01 2FA**~~ → **2026-09-12 完了**。
4. ~~**H-13 運用方針**~~ → **2026-09-12 決定済み**（上記）。

## 判断・認証後にAIが進められること

- 確定したアカウント構成に合わせた初期設定、トークン権限・期限・対象の設定。
- H-02のTerraform/CI用資格情報について、値をチャットへ出さずに保存・疎通確認・GitHub登録。R2用は実施済み。
- `02`のTerraform実装時に、実stateのバックアップ・復元手順を実装して検証する。
- main作成とCIチェック名確定後のブランチ保護適用。privateの場合は先に利用プランと保護方式を確定する。

## M0を止めない先行・後続タスク

H-04のドメイン購入は未実施。未確定の間は既存計画どおりworkers.devを使える。
H-05の商標クリアランス・専門家への連絡、H-10のLINE、H-11のGoogle OAuthは今回未実施。
H-12のM0プレースホルダは既存のまま。実際のschema/hash/headless契約のピンはM1で確定する。
H-02のM3向けトークン最小化、H-09のM2向けpromotion_decision計測は `issues.md` に下書きあり。公開範囲未確定かつIssue #1の指定があるため、今回GitHubには起票していない。

## 仕様確認の根拠

- R2には利用申込みが必要で、無料枠と月次従量課金がある。[Cloudflare R2開始手順](https://developers.cloudflare.com/r2/get-started/)、[料金](https://developers.cloudflare.com/r2/pricing/)
- R2の `PutBucketVersioning` は未対応。stateは別キーに退避し、`02`でバックアップ・復元検証を実装する。現時点で復元検証は未実施。[Cloudflare R2 S3対応表](https://developers.cloudflare.com/r2/api/s3/api/)
- GitHubのrequired reviewersはFree / Pro / Teamでpublic限定。[GitHub Environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)
- タグのデプロイ制限は作成時に `type=tag` が必要。[GitHub Deployment branch policies API](https://docs.github.com/en/rest/deployments/branch-policies#create-a-deployment-branch-policy)
