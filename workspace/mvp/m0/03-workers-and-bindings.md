# 03：Workers ＋ Service Bindings — 「結線されている」ことの証明

> 対応DoD：**M0-4 メインアプリのデプロイ確立（host＋gateway＋data-api、Service Bindings結線）** ／ **M0-3 の wrangler 層**
> 前提：`02` の dev 資源が apply 済み
> 担当：🤖
> **プラン前提：Cloudflare Free** — CPU **10ms/リクエスト**・100k req/日。これが host の設計を決める（→ [`06-plan-and-limits.md`](./06-plan-and-limits.md) §4.1）

---

## 1. M0で結線するトポロジ

```
                      Internet
                          │
                          ▼
        ┌─────────────────────────────────┐
        │  apps/host                      │   ★Static Assets（SPAシェル）で配信
        │  PWA Host Shell                 │     → ページロードでは Worker が起動しない
        │  ＋ 最小Worker（/api/* /healthz）  │     → 無償枠の 100k req/日 を消費しない
        └───────────────┬─────────────────┘
                        │ Service Binding: GATEWAY
                        ▼
        ┌─────────────────────────────────┐
        │  apps/gateway  (Workers)        │   Community Gateway
        │  認証・AppGrant検査（M2で中身）    │   ★D1/R2/DO を直接触らない
        └───────────────┬─────────────────┘
                        │ Service Binding: DATA_API
                        ▼
        ┌─────────────────────────────────┐
        │  packages/data-api  (Workers)   │   ★唯一の権限強制点
        │  外部ルートを持たない（SB専用）      │
        └──┬──────────┬──────────┬────────┘
           │          │          │
      D1(control)  R2(bundles)  DO(app-do / SQLite)
```

**M0で実装するのは health chain だけ。** 認証も権限もデータモデルも入れない。
証明したいのは「**この矢印が全部つながっていて、CIから配れて、消しても復元できる**」ことだけ。

---

## 2. wrangler.jsonc の書き方（サービス単位の正本）

各Workerに1ファイル。環境は `env.*` で分岐する。

```jsonc
// packages/data-api/wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "musubi-dev-data-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",       // ★着手時の日付に固定
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "workers_dev": true,

  "d1_databases": [
    { "binding": "CONTROL_DB", "database_name": "musubi-dev-control", "database_id": "<TF_OUTPUT>" }
  ],
  "r2_buckets": [
    { "binding": "BUNDLES", "bucket_name": "musubi-dev-bundles" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "APP_DO", "class_name": "AppInstanceDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AppInstanceDO"] }
  ],

  "env": {
    "staging": {
      "name": "musubi-staging-data-api",
      "workers_dev": false,
      "d1_databases": [
        { "binding": "CONTROL_DB", "database_name": "musubi-staging-control", "database_id": "<TF_OUTPUT>" }
      ],
      "r2_buckets": [{ "binding": "BUNDLES", "bucket_name": "musubi-staging-bundles" }],
      "durable_objects": { "bindings": [{ "name": "APP_DO", "class_name": "AppInstanceDO" }] }
    },
    "production": {
      "name": "musubi-production-data-api",
      "workers_dev": false,
      "d1_databases": [
        { "binding": "CONTROL_DB", "database_name": "musubi-production-control", "database_id": "<TF_OUTPUT>" }
      ],
      "r2_buckets": [{ "binding": "BUNDLES", "bucket_name": "musubi-production-bundles" }],
      "durable_objects": { "bindings": [{ "name": "APP_DO", "class_name": "AppInstanceDO" }] }
    }
  }
}
```

> ⚠️ **wrangler の env は継承しない**（`d1_databases` 等の配列は env ごとに丸ごと書き直しになる）。冗長でも全部書く。ここを「継承するはず」と誤解するのがこの構成で一番多い事故。

```jsonc
// apps/gateway/wrangler.jsonc（要点のみ）
{
  "name": "musubi-dev-gateway",
  "main": "src/index.ts",
  "services": [
    { "binding": "DATA_API", "service": "musubi-dev-data-api" }
  ],
  "env": {
    "staging":    { "name": "musubi-staging-gateway",
                    "services": [{ "binding": "DATA_API", "service": "musubi-staging-data-api" }] },
    "production": { "name": "musubi-production-gateway",
                    "services": [{ "binding": "DATA_API", "service": "musubi-production-data-api" }] }
  }
}
```

```jsonc
// apps/host/wrangler.jsonc（要点のみ）
{
  "name": "musubi-dev-host",
  "main": "src/worker.ts",              // ★SSRエントリではない。/api/* と /healthz だけを見る薄いWorker
  "assets": {
    "directory": "dist/client",         // ★ Vite のクライアントビルド出力（SPAシェル）
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/healthz"]   // ← これ以外は Worker を通さず静的配信
  },
  "services": [{ "binding": "GATEWAY", "service": "musubi-dev-gateway" }]
}
```

### なぜ SSR ではなく SPAシェルなのか（無償プラン前提の確定事項）

Free は **1リクエストあたり CPU 10ms**。TanStack Start の SSR はこれを超える場面があり得る。一方、企画書11章が TanStack Start を選んだ根拠は「**招待制（SEO無関係）・PWA・リアルタイム**だから Next.js の主戦場（SSR/RSC）は要らない」——**つまり SSR は最初から要件ではない**。

| | SSR配信 | **SPAシェル配信（採用）** |
|---|---|---|
| CPU 10ms | 超えるリスクあり | シェルは静的配信＝Worker CPU 0 |
| 100k req/日 | ページロードごとに消費 | **静的アセットは無料・無制限で消費しない** |
| SEO | 効く | 不要（招待制） |
| 初回描画 | 速い | シェルキャッシュ後は同等 |

**副次効果が大きい**：日次リクエスト予算をページロードではなく **API呼び出しだけに使える**。TTSU（企画書16章）の観点でも、シェルがエッジキャッシュから即返るのは有利。

> **要確認**（→ `06` §7 #4）：Workers Static Assets へのリクエストが 100k/日 を消費しないことを Analytics で実測確認する。
> **要確認**：TanStack Start × `@cloudflare/vite-plugin` の SPAモードでの出力パスと `assets` 設定の統合方法は、採用バージョンの公式テンプレートに従う（バージョン差が大きい）。M1で SSR が必要になったら、その時に Workers Paid へ昇格する（`06` §5 P-1）。

---

## 3. Terraform出力 → wrangler への同期（`infra:sync`）

**問題**：D1 の `database_id` は destroy/apply で変わる。人手コピペを許すと「手作業ゼロ」が崩れる。

**解決**：`terraform output -json bindings` を読み、各 `wrangler.jsonc` の該当フィールドを**冪等に書き戻す**スクリプト。

```
infra/scripts/sync-bindings.ts
  入力: infra/terraform/envs/<env>/  の terraform output -json bindings
  出力: apps/*/wrangler.jsonc, packages/data-api/wrangler.jsonc の
        d1_databases[].database_id / bucket_name / queue name を更新
  性質: 冪等（変化がなければ書き込まない）
```

**乖離チェックの置き場（2026-09-13 決定：(c) の変形）**

乖離が生まれる原因は2つしかない。**`terraform apply`**（D1 は作り直すと ID が変わる）と、**`wrangler.jsonc` の手修正**である。
apply は CI では行わず、人が立ち会う回にしか起きない。だからチェックは PR ではなく、次の2か所に置く。

| タイミング | やること | 置き場 |
|---|---|---|
| **apply の直後** | `pnpm infra:sync --env <env>` で書き戻し、そのままコミットする | `infra/terraform/README.md` §2（#4 の立ち会い手順） |
| **デプロイの直前** | `pnpm infra:sync --env <env> --check`。乖離があればデプロイしない | `04` §4（staging）・§5（production） |

**PR の検証ゲート（lint-typecheck-unit / verify.yaml）には入れない。** 理由：

- **スナップショットを渡す形は空振りする。** apply で ID が変わった瞬間に古くなり、実物とズレているのに通る。
  置き場も無い（Account ID を含むのでコミットできない、Artifact は public で公開される、Secret は手で更新するので古くなる）
- **PR で実物を読む形は、ワーカーのローカル検証を本物の state に触れさせる**（verify-parity により verify.yaml にも同じゲートが要る）
- 同期先の wrangler.jsonc と staging の state が揃うまで、**全 PR が落ちる**

手修正による乖離は PR では捕まらないが、main へのマージ直後に staging へ自動デプロイされる段で捕まり、**本番には届かない**。

> **必要な資格情報は R2（tfstate の backend）の3つだけ。** `terraform output` は state を読むだけなので Cloudflare のトークンは要らない
> （2026-09-13 実測：CF 系の環境変数0個で `init` → `infra:sync --check` まで通過、出力に Account ID なし）。

> ⚠️ **`--check` は「binding が欠けていること」を検出しない。** Terraform 由来の binding を1つも持たない Worker（gateway）を
> 正当に扱うための仕様で、data-api が D1 / R2 / Queue の binding を書き忘れても通る。
> **binding を書く責任は各 Worker の wrangler.jsonc を作る Issue（#6・#8・#9）にある。**

> **なぜ生成ファイルにしないのか**：企画書11章が「wrangler.jsonc＝サービス単位の**正本**」と定めている。生成物にすると正本が Terraform 側に移り、二層の線が崩れる。
> **だからこう扱う**：wrangler.jsonc は人間が読み書きする正本。ただし**Terraform由来のID欄だけは機械が同期し、乖離をCIが落とす**。正本性と手作業ゼロを両立させる唯一の形。

---

## 4. Durable Object の扱い（先に決めておく）

企画書9章：**1アプリインスタンス＝1 DO（SQLite付き）／D1はControl Plane専用**。

- クラス名は `AppInstanceDO` で固定（M1以降で改名しない。改名＝migration）
- 初回 migration は必ず **`new_sqlite_classes`**（`new_classes` ではない。KVバックエンドで作ると後から SQLite に移せない）
  - **Free プランでは選択肢ですらない**：Free で使えるのは SQLite型 DO のみ（2025-04〜）。KV型は有償。**無償プラン前提が、正しい選択を強制してくれている**
  - Free の DO ストレージは **アカウント合計 5GB／1オブジェクト 1GB**（→ `06` §2）。1アプリインスタンス＝1DO なので、1GB を1つのミニアプリが超えることは当面ない
- DO は **data-api にだけバインドする**（gateway/host には出さない）
- クラスを消すときは `deleted_classes` migration が必要。**M0のうちに一度、追加→削除の migration を通しておく**と、後で怖くなくなる

```ts
// packages/app-do/src/index.ts（M0の最小実装）
import { DurableObject } from "cloudflare:workers";

export class AppInstanceDO extends DurableObject {
  async healthz(): Promise<{ ok: true; rows: number }> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _probe (k TEXT PRIMARY KEY, v TEXT)"
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO _probe (k, v) VALUES ('healthz', ?)",
      new Date().toISOString()
    );
    const rows = [...this.ctx.storage.sql.exec("SELECT count(*) AS c FROM _probe")];
    return { ok: true, rows: Number((rows[0] as { c: number }).c) };
  }
}
```

> RPC（`DurableObject` サブクラスのメソッド直接呼び出し）を使うと、data-api 側から型付きで叩ける。**「端から端まで型を通す」（企画書9章）を DO 境界でも守る。**

---

## 5. 貫通スモーク（M0-4 の証拠）

**`GET /healthz` を host に投げると、host→gateway→data-api→{D1,R2,DO} を全部踏んで JSON が返る。** これが M0-4 の合格証。

```ts
// packages/data-api/src/index.ts（抜粋）
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/healthz") return new Response("not found", { status: 404 });

    const checks: Record<string, string> = {};

    // D1（Control Plane）
    try {
      await env.CONTROL_DB.prepare("SELECT 1").first();
      checks.d1 = "ok";
    } catch (e) { checks.d1 = `ng: ${(e as Error).message}`; }

    // R2（bundle置き場）
    try {
      await env.BUNDLES.put("_probe/healthz", new Date().toISOString());
      checks.r2 = (await env.BUNDLES.head("_probe/healthz")) ? "ok" : "ng: head miss";
    } catch (e) { checks.r2 = `ng: ${(e as Error).message}`; }

    // Durable Object（SQLite）
    try {
      const stub = env.APP_DO.get(env.APP_DO.idFromName("_probe"));
      const r = await stub.healthz();
      checks.do = r.ok ? "ok" : "ng";
    } catch (e) { checks.do = `ng: ${(e as Error).message}`; }

    const ok = Object.values(checks).every(v => v === "ok");
    return Response.json(
      { service: "data-api", env: env.ENVIRONMENT, version: env.GIT_SHA, checks },
      { status: ok ? 200 : 503 }
    );
  }
};
```

gateway は `env.DATA_API.fetch()` で中継し自分の結果を足す、host は `env.GATEWAY.fetch()` で中継して集約する。最終的な応答：

```json
{
  "service": "host",
  "env": "staging",
  "version": "a1b2c3d",
  "checks": { "gateway": "ok", "data_api": "ok", "d1": "ok", "r2": "ok", "do": "ok" },
  "elapsed_ms": 43
}
```

**セキュリティ上の注意**：`production` の `/healthz` は**構成情報を返さない**（`{"ok":true}` のみ）。詳細版は `X-Musubi-Probe: <secret>` ヘッダ付きのときだけ返す。企画書12章の姿勢（本番資格情報・内部構成を露出させない）をヘルスチェックにも適用する。

```ts
// infra/scripts/smoke.ts が叩く
// pnpm smoke --env staging  →  終了コード 0/1 で CI が判定
```

### 無償枠の実測をスモークに埋め込む（`06` §7 の #1・#2 を潰す）

M0のスモークは「つながっているか」だけでなく、**Free の上限に対する余裕**も測る。各Workerが自分の CPU 時間を応答に載せる：

```ts
// 各Workerで
const t0 = performance.now();
// ... 処理 ...
const cpu_ms = performance.now() - t0;   // ※wall clock。CPU時間の近似として記録する
```

```json
{
  "service": "host",
  "checks": { "gateway": "ok", "data_api": "ok", "d1": "ok", "r2": "ok", "do": "ok" },
  "budget": {
    "host_ms": 1.2, "gateway_ms": 0.8, "data_api_ms": 4.1,
    "chain_total_ms": 6.1,
    "limit_ms": 10
  }
}
```

**これで確定させたい2点**（`06` §7）
1. **CPU時間は各Worker独立か、チェーン合算か** — 合算なら `chain_total_ms` が 10ms 上限に対する実数になる。3ホップで余裕がどれだけあるかがここで分かる
2. **Service Binding 呼び出しが課金リクエストとして別カウントされるか** — スモークを既知の回数だけ叩き、Workers Analytics のリクエスト数と突き合わせる（1回のスモークで +1 か +3 か）

> 実測結果は `05-acceptance.md` の清算表と `06` §8 に記録する。**「たぶん大丈夫」で M1 に進まない。**

> ⚠️ `performance.now()` は Workers では実CPU時間ではなく、I/O待ちを含まない近似になる。**厳密なCPU時間は Workers Analytics / Workers Logs 側の値を正とする。** 応答に載せる値は「異常に大きくないか」の早期検知用と割り切る。

---

## 6. ローカル開発（企画書11章「wrangler dev で9割再現」）

```bash
# 複数Workerを同時に起動し、Service Bindings をローカルで解決させる
pnpm exec wrangler dev -c apps/host/wrangler.jsonc \
                       -c apps/gateway/wrangler.jsonc \
                       -c packages/data-api/wrangler.jsonc
```

> **要確認**：複数 config の同時起動（マルチワーカー dev）は wrangler のバージョンによって指定方法が異なる。使用バージョンで実際に Service Binding がローカル解決されることを確認し、できなければ `wrangler dev --x-remote-bindings` 等の代替を検討して `docs/runbook/local-dev.md` に確定手順を書く。**M0のDoDに含める。**

**ローカルで再現できない3つの穴**（企画書11章で確定済み・M0で明文化しておく）

| 穴 | M0での扱い |
|---|---|
| WfP dispatch | staging 担当。M0では使わない（`02` の `wfp_enabled=false`） |
| LINE Login | M2。devチャネル（🧑 H-10）／mock |
| 外部送信 | **dry-runスタブを一級市民に**（M0では送信先がまだ無いので、`connector` パッケージに dry-run インターフェースだけ切っておく） |

---

## 7. D1 マイグレーション

- 置き場：`packages/control-plane/migrations/NNNN_<名前>.sql`（wrangler の d1 migrations 規約に合わせる。D1 は Control Plane 専用）
- M0の中身：`0001_musubi_meta.sql`（`_musubi_meta` テーブル1つ。migration機構が動くことの確認が目的）
- 適用（リポジトリ直下から）：

```bash
pnpm exec wrangler d1 migrations apply CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc [--local|--remote]
```

- staging / production は **CDで適用する**（`04` §4・§5）。手で当てない
- **`--remote` は `infra:sync` で `database_id` が書き戻された後でないと当たらない**（`<TF_OUTPUT>` のままでは実物を指さない）

**SQL は control-plane、適用は data-api の設定（2026-09-14 決定・#12）**

当初は「`packages/control-plane` で `wrangler d1 migrations apply` を実行する」形だったが、そのままでは動かない。

- `packages/control-plane` には wrangler の設定ファイルが無く、どの D1 に適用するか解決できない
- `CONTROL_DB` を binding しているのは `packages/data-api/wrangler.jsonc` だけで、`database_id` が `infra:sync` で書き戻されるのもそこだけ
- control-plane に設定ファイルを足しても `infra:sync` の同期対象外なので、`database_id` が仮の値のまま残る

だから data-api の3環境の `CONTROL_DB` に `"migrations_dir": "../control-plane/migrations"` を書き（パスは設定ファイルのディレクトリから解決される）、
リポジトリ直下から `--config` で指す。`packages/data-api/src/index.test.ts` が、この適用コマンドで env.dev に `--local` で全部当たることを毎回確かめる。

> **ロールバックは D1 にネイティブ機能が無い。** 前方互換のみのマイグレーション規律（列は足すが消さない・destructive変更は2段階リリース）と、
> 適用・巻き戻しの手順は `docs/runbook/d1-migration.md` に書いた。**これをM0で書いておかないと、M2で必ず事故る。**

---

## 8. このステップのDoD

- [ ] host / gateway / data-api の3Workerが dev に deploy できる
- [ ] `GET https://musubi-dev-host.<subdomain>.workers.dev/healthz` が **全チェック ok** で 200 を返す
- [ ] gateway から D1/R2/DO を直接触っていない（lint の `no-restricted-imports` で機械強制されている）
- [ ] `pnpm infra:sync --env dev` が冪等（2回目で差分なし）
- [ ] `wrangler dev` の複数Worker起動でローカルでも `/healthz` が全 ok（穴があれば `docs/runbook/local-dev.md` に明記）
- [ ] DO の migration を `new_sqlite_classes` で切ってある
- [ ] `docs/runbook/d1-migration.md` に前方互換規律が書かれている
- [ ] production の `/healthz` が構成情報を漏らさない
- [ ] **host が SPAシェル配信**になっており、ページロードで Worker が起動しない
- [ ] スモークが CPU時間と `chain_total_ms` を記録し、**10ms に対する余裕が判明している**
- [ ] `06` §7 の要確認 #1（CPU独立/合算）・#2（リクエストカウント）・#4（静的アセット無料）が実測で潰れている
