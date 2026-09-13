// data-api Worker の受入試験（Issue #6）。
//
//   1. 外部ルートを持たないことを、wrangler が解決した設定で env ごとに確かめる
//   2. D1 / R2 / DO の binding が env ごとに書かれ、DO の migration が app-do の正本と一致する
//   3. 本物の workerd の上で /healthz が 200 を返し、D1 / R2 / DO を実際に踏んでいる
//
// モックにしないのは app-do と同じ理由：binding が「解決している」ことの証明は、
// 解決した binding を実際に叩くことでしか得られない。
//
// wrangler / vitest は devDependencies に無い。ルートの package.json に集約してある（app-do と同じ）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig } from "wrangler";
import type { DataApiEnv } from "./cloudflare.js";
import { PROBE_DO_NAME, PROBE_OBJECT_KEY } from "./cloudflare.js";
import {
  BUNDLES_BINDING,
  CONTROL_DB_BINDING,
  HEALTHZ_PATH,
  PACKAGE_NAME,
  UPLOADS_BINDING,
} from "./contract.js";
import type { HealthzBody } from "./contract.js";

// tsconfig の lib は ES2022 ＋ workers-types だけなので ImportMeta.url が型に無い。
// このファイルは workerd ではなく Node（vitest）の側で動くので、ここだけ局所的に補う。
const HERE = (import.meta as ImportMeta & { url: string }).url;
const CONFIG_PATH = new URL("../wrangler.jsonc", HERE);
/** DO の class_name / migration の正本（03 §4・app-do の wrangler.jsonc 冒頭） */
const APP_DO_CONFIG_PATH = new URL("../../app-do/wrangler.jsonc", HERE);
const BOOT_TIMEOUT_MS = 120_000;

const ENVS = ["dev", "staging", "production"] as const;

const readConfig = (path: URL, env?: string) =>
  unstable_readConfig(
    { config: decodeURIComponent(path.pathname), ...(env === undefined ? {} : { env }) },
    { hideWarnings: true },
  );

describe("data-api パッケージ", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musubi/data-api");
  });
});

describe.each(ENVS)("wrangler.jsonc（env.%s）", (env) => {
  const config = readConfig(CONFIG_PATH, env);
  const appDo = readConfig(APP_DO_CONFIG_PATH);

  it("Worker 名が musubi-<env>-data-api（gateway の Service Binding の宛先）", () => {
    expect(config.name).toBe(`musubi-${env}-data-api`);
  });

  it("外部ルートを持たない：workers.dev・Preview URL・routes のどれも無い", () => {
    // Service Binding は呼ぶ側が Worker 名で結ぶので、到達経路を1つも作らなくても届く。
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes ?? []).toEqual([]);
    expect(config.route).toBeUndefined();
  });

  it("D1 は CONTROL_DB の1つだけで、その env の control データベースを指す", () => {
    expect(config.d1_databases).toEqual([
      expect.objectContaining({
        binding: CONTROL_DB_BINDING,
        database_name: `musubi-${env}-control`,
        database_id: expect.any(String),
      }),
    ]);
  });

  it("R2 は BUNDLES と UPLOADS で、その env のバケットを指す", () => {
    expect(config.r2_buckets).toEqual([
      expect.objectContaining({ binding: BUNDLES_BINDING, bucket_name: `musubi-${env}-bundles` }),
      expect.objectContaining({ binding: UPLOADS_BINDING, bucket_name: `musubi-${env}-uploads` }),
    ]);
  });

  it("DO の binding と migration が app-do の正本と一致する（new_sqlite_classes）", () => {
    expect(config.durable_objects.bindings).toEqual(appDo.durable_objects.bindings);
    expect(config.migrations).toEqual(appDo.migrations);
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["AppInstanceDO"] }]);
  });

  it("vars.ENVIRONMENT がその env を名乗る", () => {
    expect(config.vars).toMatchObject({ ENVIRONMENT: env });
  });

  it("infra:sync が扱えない binding（KV・Queue consumer）を持たない", () => {
    expect(config.kv_namespaces).toEqual([]);
    expect(config.queues.consumers ?? []).toEqual([]);
  });
});

describe.each(ENVS)("data-api Worker（env.%s・workerd 上の実機）", (env) => {
  const server = createTestHarness({
    workers: [{ configPath: CONFIG_PATH, env, vars: { GIT_SHA: "test-sha" } }],
  });

  beforeAll(async () => {
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it("GET /healthz が 200 を返し、D1 / R2 / DO が全部 ok", async () => {
    const res = await server.fetch(HEALTHZ_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthzBody;
    expect(body).toEqual({
      service: "data-api",
      env,
      version: "test-sha",
      checks: { d1: "ok", r2: "ok", do: "ok" },
      elapsed_ms: expect.any(Number),
    });
  });

  it("binding が解決している：healthz が R2 と DO（SQLite）に実際に書いている", async () => {
    await server.fetch(HEALTHZ_PATH);
    const worker = server.getWorker<DataApiEnv>();

    const bindings = await worker.getEnv();
    expect(Object.keys(bindings)).toEqual(
      expect.arrayContaining([CONTROL_DB_BINDING, BUNDLES_BINDING, UPLOADS_BINDING, "APP_DO"]),
    );
    expect(await bindings.BUNDLES.head(PROBE_OBJECT_KEY)).not.toBeNull();

    const sql = await worker.getDurableObjectStorage("APP_DO", { name: PROBE_DO_NAME });
    expect(await sql.exec("SELECT k FROM _probe")).toEqual([{ k: "healthz" }]);
  });

  it("/healthz 以外のパスは 404", async () => {
    const res = await server.fetch("/");
    expect(res.status).toBe(404);
  });

  it("GET 以外は 405", async () => {
    const res = await server.fetch(HEALTHZ_PATH, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});
