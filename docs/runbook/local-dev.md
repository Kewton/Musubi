# ローカル開発（host・gateway・data-api を `wrangler dev` で並べる）

3つの Worker を1つの `wrangler dev` で起動し、host → gateway → data-api → {D1, R2, DO} の Service Binding を手元で解決させる手順と、
**ローカルで再現できない3点**の扱い。手順書は `workspace/mvp/m0/03-workers-and-bindings.md` §6。

> **実物の D1 / R2 に触らない。** `--local` を外さない。`--remote` も remote binding も使わない（§3）。

下の手順は 2026-09-14 に**書いたとおりに実行して**動くことを確かめた（§5）。wrangler 4.131.1・@cloudflare/vite-plugin 1.54.8。

---

## 早見表

| やりたいこと | どうする |
|---|---|
| 初めて起動する | §1 を上から |
| コードを変えた | wrangler dev を Ctrl+C で止めて §1.2 から |
| ローカルのデータを消す | §2.3 |
| WfP dispatch・LINE Login・外部送信を試す | ローカルではできない（§4） |

コマンドはすべて**リポジトリ直下**で打つ。

---

## 1. 起動する

### 1.1 依存を入れる（worktree を作ったとき・依存を変えたとき）

```bash
pnpm install
```

### 1.2 ビルドする

```bash
pnpm build
```

- gateway は `@musubi/data-api` の、data-api は `@musubi/app-do` の `dist/` を import する。ビルドしないと起動しない
- host は `vite build` の出力（`apps/host/dist/`）を並べる。host は**ビルドの時点で** `CLOUDFLARE_ENV` によって env が決まり、未指定なら env.dev（`apps/host/wrangler.jsonc` 冒頭）。
  turbo はこの値を host の build へ渡すので（`apps/host/turbo.json`）、**`CLOUDFLARE_ENV` を付けずに**打つ。シェルに `CLOUDFLARE_ENV=staging` などが残っていると staging のビルドになる
- staging / production 向けにビルドした後でも、`CLOUDFLARE_ENV` 無しで `pnpm build` をやり直せば env.dev の出力に戻る（キャッシュの鍵に env が入るので、別のキャッシュが当たるか作り直す）。
  出力のディレクトリ名は env によらず `musubi_dev_host` なので、名前では見分けられない。中身の env はこれで確かめる（`dev` と出る）

  ```bash
  node -p 'require("./apps/host/dist/musubi_dev_host/wrangler.json").targetEnvironment'
  ```

### 1.3 D1 にマイグレーションを当てる

```bash
pnpm exec wrangler d1 migrations apply CONTROL_DB --env dev --config packages/data-api/wrangler.jsonc --local
```

`d1-migration.md` §2.1 と同じコマンド。当たる先は `packages/data-api/.wrangler/state/v3/d1/`（ignore 済み）。2回目は `No migrations to apply!`。

### 1.4 起動する（ターミナル1）

```bash
pnpm exec wrangler dev --local --env dev \
  -c apps/host/dist/musubi_dev_host/wrangler.json \
  -c apps/gateway/wrangler.jsonc \
  -c packages/data-api/wrangler.jsonc \
  --persist-to packages/data-api/.wrangler/state
```

`Ready on http://localhost:8787` が出たら起動済み。止めるときは Ctrl+C。

| 指定 | 理由 |
|---|---|
| `--local` | remote binding を無効にする（§3） |
| `--env dev` | gateway と data-api の binding（services・D1・R2・DO）は env.dev にしか書いていない。env へ継承されない欄だから |
| host を**先頭**に置く | 先頭の Worker が 8787 で受ける。gateway と data-api にはそこから Service Binding で届く |
| host は**ビルドの出力**（`apps/host/dist/musubi_dev_host/wrangler.json`）を指す | `apps/host/wrangler.jsonc` を指すと起動しない（§1.6） |
| `--persist-to packages/data-api/.wrangler/state` | 省くと先頭の設定の隣（`apps/host/dist/musubi_dev_host/.wrangler/state`）に作られる。§1.3 と別の、マイグレーションの当たっていない D1 になり、ビルドのたびに消える |

起動時に出る次の2つは想定どおりで、無視してよい。

- host の設定に environment `dev` が無いという WARNING（Worker 名が `musubi-dev-host-dev` と表示される）。ビルドの出力は env を解決済みで、env のブロックを持たない
- binding の表の `[not connected]`。同じプロセスで起動する Worker とは起動後につながる（§1.5 ① の `"gateway":"ok"` で確かめる）

**`Ready on` のポートが 8787 であることを見る。** 8787 が使われていると、wrangler は黙って別のポート（8788 など）で起動する（2026-09-14 実測）。
そのまま §1.5 を打つと、前に起動して残っている古い wrangler dev を確かめることになる。残っているものを止めてから起動し直す。

### 1.5 確かめる（ターミナル2）

```bash
# ① host → gateway → data-api → D1 / R2 / DO が全部 ok で 200
curl -s -w '\n%{http_code}\n' http://localhost:8787/healthz

# ② / が SPAシェル（ビルドした index.html そのもの）を返す
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:8787/
curl -s http://localhost:8787/ | cmp - apps/host/dist/client/index.html && echo "SPAシェルと一致"

# ③ 起動中の Worker が使っている D1 に §1.3 のマイグレーションが当たっている
#    （wrangler dev のローカル専用 API /cdn-cgi/local/explorer/api で、起動中の D1 に問い合わせる）
node --input-type=module -e '
const base = "http://localhost:8787/cdn-cgi/local/explorer/api/d1/database";
const [db] = (await (await fetch(base)).json()).result;
const res = await (await fetch(`${base}/${db.uuid}/raw`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sql: "SELECT name FROM d1_migrations ORDER BY id" }),
})).json();
if (!res.success) { console.error(db.name, res.errors); process.exit(1); }
console.log(db.name, res.result[0].results.rows.flat());
'
```

**③ を省かない。** data-api の healthz は D1 に `SELECT 1` しか打たない（`packages/data-api/src/cloudflare.ts`）ので、
`--persist-to` を省いて空の D1 で動いていても ① は全部 ok になる。2026-09-14 実測で、そのとき ③ は
`no such table: d1_migrations` を出して exit 1 になる。

同じ3つの Worker の並びは `apps/host/src/worker/index.test.ts` が workerd の上で毎回確かめている（`pnpm test`）。この手順はそれを手で動かすためのもの。

### 1.6 採らなかった形（2026-09-14 実測）

| 形 | 結果 |
|---|---|
| `03` §6 のとおり `-c apps/host/wrangler.jsonc` を並べる | 起動しない（``The `assets` property in your configuration is missing the required `directory` property.``）。`assets.directory` は vite-plugin がビルドの出力に書き込む（`apps/host/wrangler.jsonc` 冒頭） |
| `apps/host` の `vite dev` に gateway と data-api を補助 Worker（`auxiliaryWorkers`・`devOnly: true`）として並べる（`vite.config.ts` に一時的に足して試した） | `/healthz` は全 ok になるが、`/` が host Worker の `{"error":"not found"}`（404）になる。SPAシェルはビルド時に prerender Worker が描くもので、dev サーバーには無い（`apps/host/vite.config.ts` 冒頭） |

---

## 2. ローカルの状態

### 2.1 置き場所

`packages/data-api/.wrangler/state/v3/` に D1（`d1/`）・R2（`r2/`）・DO（`do/`）がまとまる（ignore 済み）。
D1 / R2 / DO を binding しているのは data-api だけなので、置き場も data-api に寄せてある。
`d1 migrations apply --local` が `--persist-to` 無しで当てる先と同じ場所である。

### 2.2 `database_id` が変わったとき

ローカルの D1 は `database_id` ごとに1つある。`infra:sync` で ID が書き戻されると空の DB に切り替わるので、§1.3 からやり直す（`d1-migration.md` §2.1）。

### 2.3 消す

wrangler dev を止めてから消し、§1.3 からやり直す。

```bash
rm -rf packages/data-api/.wrangler/state
```

---

## 3. 実物に触らない

- **`--local` を外さない。** `wrangler dev --help` の説明は「Run locally with remote bindings disabled」
- **`--remote` を付けない。wrangler.jsonc の binding に `"remote": true` を書かない。** 実環境の D1 / R2 に書き込む経路になる
- リポジトリ直下で打つと、wrangler は直下の `.env` を環境変数に読み込む（wrangler 4.131.1 の実装）。
  資格情報が手元にある状態で動くので、remote binding を有効にすれば本当に実物へ届く
- 2026-09-14 実測：§1.4 のコマンドに `--log-level debug` を足して起動し `/healthz` と `/` を叩いた間、
  debug ログに Cloudflare API へのリクエスト（`START CF API REQUEST`）は 0 件だった
- ローカルで起動するのは env.dev だけにする。staging / production の設定では確かめていない

---

## 4. ローカルで再現できない3点（企画書11章）

扱いは `03` §6 の表に沿う。

| 穴 | ローカルで何が起きるか | M0 での扱い | 代わりに何で確かめるか |
|---|---|---|---|
| **WfP dispatch** | wrangler 4.131.1 は dispatch namespace の binding を `not supported` と表示し、呼ぶと `Binding DISPATCHER needs to be run remotely` で失敗する（2026-09-14 実測。一時的な設定で試した）。つなぐには remote binding が要り、§3 に反する | **使わない。** `wfp_enabled` を validation で `false` に固定してあり（`infra/terraform/modules/musubi-env/variables.tf`）、どの wrangler.jsonc にも `dispatch_namespaces` が無い。Free 前提（CLAUDE.md） | 解禁（`06` §5 の W-1 / W-2。M5〜M6）の後に **staging** で確かめる（`03` §6） |
| **LINE Login** | LINE のサーバーとの往復（認可画面・コールバック）が要り、手元の workerd の中では閉じない | **対象が無い。** 認証は M2 で入る（gateway の中身は M2。`03` §1） | M2 で、dev 用の LINE Login チャネル（`00-human-tasks.md` H-10・#22）で実物と往復する。それ以外は mock（`03` §6） |
| **外部送信** | 送った結果は外部サービスに届いて初めて分かる。手元から送れば実物に届き、取り消せない | **対象が無い。** 外へ送るコードは M0 に無い（`packages/connector` は空） | 送る処理を足すときは、宛先に届かない **dry-run** を一級市民として先に用意し、ローカルと自動テストはそれで動かす（`03` §6）。dry-run のインターフェースはまだ無い（この runbook の対象外） |

---

## 5. 実行記録

**2026-09-14・main = `468c44c`・macOS・Node 24.1.0・pnpm 10.13.1・wrangler 4.131.1・@cloudflare/vite-plugin 1.54.8**

`packages/data-api/.wrangler/state` と `apps/host/dist` を消した状態から、§1.1〜§1.5 のコマンドを書いたとおりに実行した。

| 手順 | 結果 |
|---|---|
| §1.1 `pnpm install` | exit 0 |
| §1.2 `pnpm build` | exit 0 |
| §1.3 マイグレーション | `0001_musubi_meta.sql` が ✅。2回目は `No migrations to apply!` |
| §1.4 起動 | `Ready on http://localhost:8787` |
| §1.5 ① `/healthz` | `200` と下の JSON |
| §1.5 ② `/` | `200 text/html; charset=utf-8`。本文は `apps/host/dist/client/index.html` と一致 |
| §1.5 ③ D1 | `CONTROL_DB [ '0001_musubi_meta.sql' ]`（exit 0）。§1.4 から `--persist-to` の行を外して起動し直すと、① と ② は同じまま ③ が `no such table: d1_migrations` で exit 1。戻すと exit 0 |

```json
{"service":"host","env":"dev","version":"local","checks":{"gateway":"ok","data_api":"ok","d1":"ok","r2":"ok","do":"ok"},"elapsed_ms":16}
```
