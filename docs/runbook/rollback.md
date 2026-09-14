# ロールバック（コード／D1／Terraform）

> 設計の正本：`workspace/mvp/m0/04-cicd.md` §6。進め方は **2026-09-14・Issue #17 で所有者が承認**した次の4つ。
>
> 1. コードの一次手段は **wrangler rollback**（Worker の配備済みの版へ即時に切り替える。build もマイグレーションもしない）。手動実行のワークフロー `rollback.yml` で行い、production は承認つき
> 2. 二次手段は、**古い v タグで `deploy-production.yml` を手動実行し直す**
> 3. **D1 は巻き戻さない**（前方互換の規律。最後の手段は Time Travel）。**Terraform は state の退避と復元**で扱う
> 4. 実演は所有者の立ち会い（§4）

障害のときは §0 の表で手段を決め、その節を上から実行する。

---

## 0. どれを使うか

| 状況 | やること | 節 |
|---|---|---|
| production の新しいコードが悪い | **一次手段**：`rollback.yml` で1つ前の v タグの版へ切り替える | §1.1 |
| 戻した後、直ったコードの版へ戻したい（復帰） | 同じ `rollback.yml` を新しいタグで | §1.2 |
| 一次手段が「版が見つからない」などで使えない | **二次手段**：古い v タグで `deploy-production.yml` を手動実行 | §1.3・§1.4 |
| GitHub Actions が動かない | 🧑 手元から `deploy-worker.ts --rollback-to` | §1.5 |
| staging のコードが悪い | revert の PR を main へ | §1.6 |
| migration の中身・D1 のデータが悪い | **巻き戻さない**。前へ直す／最後の手段は Time Travel | §2 |
| Terraform の apply で環境を壊した | state を退避物から戻し、設定は前へ直して apply し直す | §3 |

---

## 1. コード

### 1.1 一次手段：`rollback.yml`（wrangler rollback）

Worker は配るたびに**版**（コード・Static Assets・binding・secret の組）を残す。`rollback.yml` は3つの Worker を、
配備済みの版のうち **GIT_SHA（deploy の `--var`）が戻し先のタグの commit と一致する版**へ切り替える。

```bash
# 1. 戻し先を決める。ふつうは1つ前の v タグ（今のリリースの直前）
git fetch --tags
git tag -l 'v*' --sort=-v:refname | head -3

# 2. 起動する。--ref は rollback.yml を含む v タグ（ふつうは最新のタグ）。to が戻し先
gh workflow run rollback.yml --ref <最新の v タグ> -f to=<戻し先の v タグ>

# 3. 🧑 承認する（production 環境の必須レビュワー）。承認するまでジョブは始まらない
gh run list --workflow rollback.yml -L 1
gh run watch <run の ID>
```

ジョブがやること（正本は `.github/workflows/rollback.yml` と `infra/scripts/deploy-worker.ts` 冒頭「巻き戻し」）：

| 段 | やること |
|---|---|
| 前提の確認 | v タグから起動したか・`to` が v タグの名前の形か・Secret が揃っているか。**`to` の値は形を確かめるまで表示しない** |
| 戻し先の commit | `to` のタグを fetch し、指す commit を引く |
| ① 切り替え | `deploy-worker.ts --env production --rollback-to <commit>`。下の「読む → 決める → 切り替える」 |
| ② 貫通スモーク | `pnpm smoke --env production --expect-sha <commit>`。host の `/healthz` の version が戻し先の commit であること |

① の中身：

1. **読む（書かない）**：Worker ごとに今のデプロイの版と、直近 10 版の GIT_SHA を読む（`wrangler deployments status` / `versions list` / `versions view` の `--json`）
2. **決める**：戻し先の commit の版が **1つでも見つからなければ、何も切り替えずに落ちる**（→ §1.4）。既にその版の Worker は飛ばす。
   向きは「その commit が最初に配られた時刻」を今の commit と比べて決める
3. **切り替える**：`wrangler rollback <版> --yes` を1つずつ。切り替えるたびに、今のデプロイがその版を 100% で向いたことを読んで確かめる

| 向き | 順 | 理由 |
|---|---|---|
| 古い版へ戻す | **host → gateway → data-api** | 呼ぶ側を先に戻す |
| 新しい版へ進める（§1.2） | **data-api → gateway → host** | 配る順（呼ばれる側を先に置く。`04` §4） |

どちらの順でも、途中の瞬間は「呼ぶ側が古く、呼ばれる側が新しい」になる。これは配っている途中と同じ組み合わせで、
呼ばれる側は1つ前の呼ぶ側を受け付ける（配る順がそれを前提にしている）。**D1 には触れない**（§2）。

**ログの読み方**（公開ログに出るのは版の ID・作成時刻・GIT_SHA の先頭と、伏せた要約だけ。版の記録にある作成者のメールアドレスは出さない）

```
deploy-worker: rollback（env=production）: 3つの Worker を GIT_SHA が <commit> の版へ切り替える。build も D1 マイグレーションもしない
  data-api（musubi-production-data-api）: 今 <版>（GIT_SHA <先頭12桁>・<作成時刻>）。読んだ版 <n>
  …
  host: <今の版> → <戻し先の版>
deploy-worker: 古い版へ戻す。順は host → gateway → data-api
deploy-worker: host: wrangler rollback <版> --name musubi-production-host --message deploy-worker --rollback-to <commit> --yes
  …
deploy-worker: host: 今のデプロイが <版> を 100% で向いていることを確かめた
…
deploy-worker: OK  rollback（env=production）: 3つの Worker が GIT_SHA <commit> の版で動いている（切り替え <n> 秒）
smoke: OK  host → gateway → data_api → d1 / r2 / do（env=production, version="<commit>", elapsed_ms=…）
```

**途中で落ちたら**：ログの「切り替え済み：… 未切り替え：…」を見る。途中の組み合わせは上の理由で動く。
**同じ `to` でもう一度実行すれば、切り替え済みの Worker を飛ばして続きから切り替える。**

> GitHub の Deployments に残る ref は起動したタグ（`--ref`）であり、戻し先ではない。今どの版で動いているかはジョブのログ（と smoke）で見る。
> `rollback.yml` は `deploy-production.yml` と同じ concurrency の group にいる。配っている途中に切り替えは始まらない（逆も）。

### 1.2 復帰：新しい版へ戻す

直ったら（または、戻したのが誤りだったら）、**同じワークフローを新しいタグで**実行する。build し直さないので、戻したときと同じ速さで戻る。

```bash
gh workflow run rollback.yml --ref <最新の v タグ> -f to=<最新の v タグ>
```

順は data-api → gateway → host になる。直したコードを出すときは、ふつうに新しいタグを打つ（`04` §5）。

### 1.3 一次手段が使えないとき

| 状況 | 何が起きるか | どうするか |
|---|---|---|
| 戻し先の commit の版が**直近 10 版に無い**（GIT_SHA の無い版しか無い場合も） | ① が何も切り替えずに落ちる（「版が見つからない」） | §1.4 |
| `rollback.yml` を含まないタグしか無い（**v0.1.0** がそう） | そのタグを `--ref` にできない（ワークフローの定義が無い） | 新しいタグを `--ref` にする。戻し先（`to`）は古いタグでよい |
| 戻し先の版から今までに **Durable Object のクラスを足した・消した** | Cloudflare が rollback を拒否する（Cloudflare の Rollbacks の文書） | 戻せない前提でリリースする。前へ直す（新しいタグ）。二次手段も古い設定にクラスを消す migration が無く通らない見込み（未確認） |
| 版が束縛している **R2 バケット・KV・Queue が消えている** | 同上（拒否） | 前へ直す。Terraform の資源を消すのは、それを使う版が直近に無くなってから |
| 戻し先の版から今までに **合言葉（`MUSUBI_PROBE_TOKEN`）を変えた** | wrangler は「secret が変わった」確認を非対話で yes にして進む（wrangler 4.131.1 のソース。ログに変わった secret の**名前**が出る）。戻した版がどちらの値で動くかは Cloudflare の文書に書かれておらず**未確認**。古い値で動くと ② が「詳細が隠された応答」で落ちる | ② が落ちたら §1.4（今の合言葉を載せて配り直す） |
| 今のデプロイが1つの版に 100% を向けていない（段階的デプロイ） | ① が切り替えずに落ちる | このリポジトリは段階的デプロイを使わない。手で作ったならダッシュボードで 100% に戻してから |
| Worker ごとに向きが混ざる（例：data-api は戻し、host は進める） | ① が切り替えずに落ちる | 途中で落ちた配備と切り替えが重なると起きうる。どちらの順でも途中の組み合わせを保証できないので、§1.4 で配り直して揃える |

### 1.4 二次手段：古い v タグで `deploy-production.yml` を回し直す

```bash
gh workflow run deploy-production.yml --ref <戻し先の v タグ>
# 🧑 承認 → ⓪ 乖離チェック → build → ① migration → ② deploy → ③ smoke（--expect-sha は戻し先の commit）
```

- **戻し先のタグにある `deploy-production.yml` の定義で動く。** `deploy-production.yml` を含むタグ（v0.1.0 以降）だけが使える
- ⓪：戻し先のタグの `wrangler.jsonc` を今の state と照合する。その後に Terraform の資源を変えていれば**ここで止まる**（正しい）。そのときは前へ直す
- ①：戻し先のタグの migration はすべて当たっているので、何も当たらない（`No migrations to apply!`）。**D1 は戻らない**（§2）
- ②：戻し先のコードを**ビルドし直して新しい版を作る**。合言葉は今の `MUSUBI_PROBE_TOKEN` が載る
- 所要は通常のデプロイと同じ（2026-09-14 の v0.1.0 の run は 3分10秒）
- 回し直した後に、一次手段で新しいタグの版へ進めてよい（向きは commit が最初に配られた時刻で決まるので、版の新旧が逆転していても正しい順になる）

### 1.5 GitHub Actions が動かないとき（🧑 手元から）

`rollback.yml` と同じことを手元から行う。**production の資格情報を使うので所有者が行う。**

```bash
cd "$(git rev-parse --show-toplevel)"      # worktree なら先に ./infra/scripts/link-env.sh
set -a; . ./.env; set +a
git fetch --tags
TO_SHA="$(git rev-parse --verify '<戻し先の v タグ>^{commit}')"

CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_PROD" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID_PROD" \
  pnpm exec tsx infra/scripts/deploy-worker.ts --env production --rollback-to "$TO_SHA"

# 宛先は production の host の workers.dev のオリジン（手元では --base-url でよい。ログを公開しないので）
SMOKE_PROBE_TOKEN="$MUSUBI_PROBE_TOKEN_PROD" pnpm smoke --env production --expect-sha "$TO_SHA" --base-url <production の host のオリジン>
```

- 資格情報は**環境変数で明示して渡す。** deploy-worker は wrangler を空の一時ディレクトリで動かすので、`.env` を wrangler に黙って読ませない
  （wrangler は cwd の `.env` を読む。リポジトリ直下の `.env` の `CLOUDFLARE_API_TOKEN` は staging のトークン）
- それも使えなければダッシュボード（Workers & Pages → Worker → Deployments）で版を選んで戻す。**順は §1.1 の表を守る**

### 1.6 staging

staging にタグは無く、main の姿を配る（`04` §4）。**revert の PR を main へ squash merge すれば、deploy-staging が配り直す。**
急ぐなら §1.5 を `--env staging` と staging のトークン（`.env` の `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）で行う。
staging の smoke は合言葉が要らない。次の main へのマージで、戻した版は上書きされる。

---

## 2. D1：巻き戻さない

**D1 にスキーマを巻き戻す機能は無い**（`wrangler d1 migrations` は `create` / `list` / `apply` だけ）。だから規律で避ける。
詳細の正本は [`d1-migration.md`](./d1-migration.md)。ここには判断だけを置く。

| 状況 | やること | 正本 |
|---|---|---|
| コードが悪い（ふつう） | **コードだけ戻す**（§1）。migration は当てたまま | `d1-migration.md` §5.1 |
| migration の中身が悪い。データは壊れていない | **前へ直す**：直す migration を新しい番号で足し、通常の PR → タグで出す | §5.2 |
| データが壊れた／前方互換を破ってしまった | 🧑 **Time Travel**（最後の手段・破壊的・Free は 7日まで）。**コードを先に戻す** | §5.3 |

- コードだけ戻して動くのは、**前方互換規律**（`d1-migration.md` §4.1「1つ前のリリースの data-api が、migration を当てた後のスキーマでそのまま動く」）を守っているから
- **2つ以上前へ戻すときは、その間に入った migration を目で見直してから戻す**（§4.1）。一次手段も二次手段も、スキーマは今のまま
- `rollback.yml` は D1 に触れない。二次手段（§1.4）の ① は古いタグの migration しか持たないので、何も当たらない
- Time Travel で戻すと `d1_migrations` も戻り、**次の CD で同じ migration が当たり直す**（§5.3 の警告）
- R2 のオブジェクトと Durable Object（SQLite）の中身も、どの手段でも戻らない

---

## 3. Terraform：state を退避して戻す

R2 はバケットのバージョニングに対応していないので、**apply の前後に state を別キーへ退避する**（`infra/scripts/tfstate-backup.sh`。手順の正本は [`infra/terraform/README.md`](../../infra/terraform/README.md) §3）。

```bash
# staging / production の apply は必ずこの順（🧑・手元から）
./infra/scripts/tfstate-backup.sh backup <env> pre-apply
terraform -chdir=infra/terraform/envs/<env> plan -out=tfplan
terraform -chdir=infra/terraform/envs/<env> apply tfplan
./infra/scripts/tfstate-backup.sh backup <env> post-apply
./infra/scripts/tfstate-backup.sh verify <env> <list で出た post-apply のキー>
```

### 3.1 state が壊れた（実資源は正しい）

🧑 取り返しがつかないので、スクリプトにせず手で行う（README §3「本当に戻すとき」）。

1. 今の state も `backup` で退避する（戻し先を失わない）
2. 戻したい退避物を `verify` にかけ、exit 0 を確かめる（本物のキーには触れない）
3. 退避物を手元へ取り出し、`terraform -chdir=infra/terraform/envs/<env> state push <file>` で戻す
4. `terraform plan -detailed-exitcode` が exit 0 になることを確かめる

### 3.2 apply で実資源を変えてしまった

**state を戻しても実資源は戻らない。** 実資源は「前の設定を apply し直す」ことで戻す。

1. apply した変更を `git revert` する PR を作る。dev / staging の plan は PR に出る。production は手元で plan する（`04` §3「production の plan を PR で回さない」）
2. 🧑 §3 の順（前後の `backup`）で apply する
3. D1 を作り直した場合は `database_id` が変わる。`pnpm infra:sync --env <env>` で `wrangler.jsonc` へ書き戻してコミットする（README §2）。怠ると次の CD の ⓪ で止まる
4. 次の CD（staging は main、production はタグ）の ⓪ 乖離チェックが通ることを確かめる

**戻らないもの**：消した D1・R2 のデータ（作り直すと空）。だから **`terraform destroy` を staging / production で実行しない**。CI にも destroy のジョブを作らない（`04` §6.3）。

---

## 4. 実演の記録（M0 の DoD）

> **状態：未実施。** Issue #17 の DoD「実際に production を1つ前のバージョンへ戻して復帰させた記録がある」は、この節が埋まるまで満たされない。
> `rollback.yml` を含む v タグが要るので、**この runbook を入れた PR が main に入った後**に、🧑 所有者の立ち会いで行う。

### 4.1 手順

前提：production は **v0.1.0**（`e615787`・2026-09-14 の deploy-production で配備。smoke green）。

1. この runbook を入れた PR を main へ squash merge し、deploy-staging が green になる
2. 新しいタグを打ち、🧑 承認して production へ配る（smoke が新しい commit で green）

   ```bash
   git fetch origin && git checkout main && git pull --ff-only
   git tag -a v0.1.1 -m "M0: rollback runbook" && git push origin v0.1.1
   ```

3. **1つ前へ戻す**：`gh workflow run rollback.yml --ref v0.1.1 -f to=v0.1.0` → 🧑 承認
4. **新しい版へ戻す**：`gh workflow run rollback.yml --ref v0.1.1 -f to=v0.1.1` → 🧑 承認
5. 下の表とチェックを埋め、`workspace/mvp/m0/05-acceptance.md` の C-8・C-9 とロールバック所要時間に転記する

### 4.2 記録

| 段 | 日時（JST） | ワークフローの run | 結果 | 切り替え（deploy-worker の OK 行） | smoke の version |
|---|---|---|---|---|---|
| 2. v0.1.1 を配る | | | | — | |
| 3. v0.1.0 へ戻す | | | | ___ 秒 | `e615787…` |
| 4. v0.1.1 へ戻す | | | | ___ 秒 | |

- [ ] 3 の順が host → gateway → data-api、4 の順が data-api → gateway → host
- [ ] 3 の smoke が v0.1.0 の commit で green（古い版が動いている）、4 の smoke が v0.1.1 の commit で green
- [ ] どちらのジョブにも build・D1 マイグレーション・乖離チェックの段が無い
- [ ] ログに workers.dev のホスト名・Account ID・メールアドレス・合言葉が出ていない
- [ ] 承認してから smoke green までの時間（ジョブの所要）を 05 のロールバック所要時間（C-8）に記録した

### 4.3 PR の段階で確かめたこと（production に触れていない）

**2026-09-14・main = `e615787`・wrangler 4.131.1**

| 確かめたこと | 手順 | 結果 |
|---|---|---|
| wrangler rollback の非対話の挙動 | wrangler 4.131.1 のソース（`src/versions/rollback`） | 版を省くと「1つ前のデプロイの 100% の版」。message と確認は非対話で既定値（yes）。secret が変わった版へは確認を yes にして強制で戻す。出力に作成者のメールアドレスは出ない |
| 版の JSON の形 | staging の host に対して `deployments status` / `versions list` / `versions view` の `--json` を**読むだけ**（staging のトークン） | `versions view` の binding `GIT_SHA` は `plain_text` で 40 桁の commit。`versions list` は作成時刻の昇順で、`metadata.author_email` を含む（だから JSON はログに出さない） |
| 読む → 決める → 切り替える → 確かめる | `infra/scripts/deploy-worker.test.ts`（偽の wrangler） | 戻す・進める・既に切り替え済み・配っている途中で落ちた後・見つからない・向きが混ざる・rollback の失敗と続きからの再実行・切り替わっていない・JSON が壊れている。ログにメールアドレス・Account ID・ホスト名が出ない |
| 実物の wrangler が呼び方を受け付ける | 同上。資格情報を渡さず `deployments status` / `versions list` / `versions view` / `rollback` を動かす | 4つとも引数の解釈を通り、認証の手前（`CLOUDFLARE_API_TOKEN` が要る）で止まる。Cloudflare に届かない |
| `rollback.yml` の形 | 同上（前提の確認と、タグから commit を引くスクリプトは bash で動かす）・`actionlint` | 起動条件・`to` の検査（注入になる値を表示せずに落とす）・資格情報の置き場所・並び。actionlint の指摘 0 |
