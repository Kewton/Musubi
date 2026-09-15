// AppInstanceDO の受入試験。**本物の workerd の上で動かす。**
//
// なぜモックにしないか：受入条件は「migration が適用できる」「SQLite の読み書きが動く」
// 「WebSocket の接続が張れる」である。DurableObjectState を差し替えた偽物で緑にしても、
// それは偽物が動いた証明にしかならない（cmate-worker-development 規律1「空振りのゲート」）。
//
// wrangler の test harness は wrangler.jsonc をそのまま読み、migrations を適用してから
// workerd を起動する。つまり **このファイルが緑であること自体が new_sqlite_classes の適用証拠**。
//
// import 元が devDependencies に無いのは意図的である。ルートの package.json が
// wrangler を宣言しており（この monorepo は vitest / tsc / oxlint も同じくルート集約）、
// packages/app-do 側に足すと pnpm-lock.yaml の更新が要る。Issue #7 の scope はこの
// パッケージの中だけなので、lockfile には触れない。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestHarness,
  unstable_getDurableObjectClassNameToUseSQLiteMap,
  unstable_readConfig,
} from "wrangler";
import {
  APP_INSTANCE_DO_CLASS_NAME,
  APP_INSTANCE_DO_INITIAL_MIGRATION_TAG,
  PACKAGE_NAME,
} from "./contract.js";

// tsconfig の lib は ES2022 ＋ workers-types だけなので ImportMeta.url が型に無い。
// このファイルは workerd ではなく Node（vitest）の側で動くので、ここだけ局所的に補う。
const CONFIG_PATH = new URL(
  "../wrangler.jsonc",
  (import.meta as ImportMeta & { url: string }).url,
);
const BOOT_TIMEOUT_MS = 120_000;

describe("app-do パッケージ", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/app-do");
  });
});

describe("wrangler.jsonc の migration", () => {
  const config = unstable_readConfig({ config: decodeURIComponent(CONFIG_PATH.pathname) });

  it("初回 migration が new_sqlite_classes で AppInstanceDO を作る", () => {
    expect(config.migrations).toEqual([
      {
        tag: APP_INSTANCE_DO_INITIAL_MIGRATION_TAG,
        new_sqlite_classes: [APP_INSTANCE_DO_CLASS_NAME],
      },
    ]);
  });

  it("new_classes（KV バックエンド）を一度も使っていない", () => {
    // KV 型で作ると後から SQLite へ移せない。Free ではそもそも使えない（03 §4）。
    for (const migration of config.migrations ?? []) {
      expect(migration).not.toHaveProperty("new_classes");
    }
  });

  it("migration を適用すると AppInstanceDO が SQLite バックエンドになる", () => {
    // wrangler が deploy / dev の前に走らせるのと同じ適用ロジック。
    // 不整合な migration 列ならここで UserError を投げる。
    const backend = unstable_getDurableObjectClassNameToUseSQLiteMap(config.migrations);
    expect(backend.get(APP_INSTANCE_DO_CLASS_NAME)).toBe(true);
  });

  it("DO バインドの class_name が正本の定数と一致する", () => {
    expect(config.durable_objects.bindings).toEqual([
      { name: "APP_DO", class_name: APP_INSTANCE_DO_CLASS_NAME },
    ]);
  });

  it("配備対象にならない（ルートを持たず workers_dev も切ってある）", () => {
    // DO に触れてよいのは data-api だけ（CLAUDE.md 不変条件・03 §4）。
    expect(config.workers_dev).toBe(false);
    expect(config.routes ?? []).toEqual([]);
  });
});

describe("AppInstanceDO（workerd 上の実機）", () => {
  const server = createTestHarness({ workers: [{ configPath: CONFIG_PATH }] });

  beforeAll(async () => {
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it("healthz が SQLite に書いて数え直す", async () => {
    const res = await server.fetch("/healthz?app=healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rows: 1 });
  });

  it("SQLite ストレージへの読み書きが往復する", async () => {
    const put = await server.fetch("/kv/greeting?app=kv", {
      method: "PUT",
      body: "むすび",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ key: "greeting", value: "むすび" });

    const got = await server.fetch("/kv/greeting?app=kv");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ key: "greeting", value: "むすび" });

    const list = await server.fetch("/kv?app=kv");
    expect(await list.json()).toMatchObject([{ key: "greeting", value: "むすび" }]);

    const removed = await server.fetch("/kv/greeting?app=kv", { method: "DELETE" });
    expect(await removed.json()).toEqual({ key: "greeting", deleted: true });

    const missing = await server.fetch("/kv/greeting?app=kv");
    expect(missing.status).toBe(404);
  });

  it("書いた行が DO の再起動をまたいで残る（durable である）", async () => {
    await server.fetch("/kv/persisted?app=evict", { method: "PUT", body: "残る" });

    const worker = server.getWorker();
    await worker.evictDurableObject(APP_INSTANCE_DO_CLASS_NAME, { name: "evict" });

    const got = await server.fetch("/kv/persisted?app=evict");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ key: "persisted", value: "残る" });
  });

  it("DO の外から SQL を投げても同じ行が見える", async () => {
    await server.fetch("/kv/sql?app=sql", { method: "PUT", body: "行" });

    const sql = await server
      .getWorker()
      .getDurableObjectStorage(APP_INSTANCE_DO_CLASS_NAME, { name: "sql" });
    const rows = await sql.exec("SELECT key, value FROM kv ORDER BY key");

    expect(rows).toEqual([{ key: "sql", value: "行" }]);
  });

  it("WebSocket の接続が張れて、受け取った本文が SQLite に残る", async () => {
    const res = await server.fetch("/ws?app=ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);

    const ws = res.webSocket;
    expect(ws).not.toBeNull();
    if (!ws) return;

    ws.accept();
    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("echo timeout")), 10_000);
      ws.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      });
      ws.send("こんにちは");
    });
    expect(JSON.parse(echoed)).toMatchObject({ type: "echo", text: "こんにちは" });

    ws.close(1000, "done");

    const list = await server.fetch("/kv?app=ws");
    expect(await list.json()).toMatchObject([{ value: "こんにちは" }]);
  });
});
