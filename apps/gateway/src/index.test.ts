// gateway Worker の受入試験（Issue #8）。
//
//   1. wrangler が解決した設定で、env ごとに「持つ binding は同じ env の data-api への Service Binding だけ」で、
//      D1 / R2 / DO（と infra:sync が扱う KV・Queue・dispatch）を1つも持たないことを確かめる
//   2. 本物の workerd の上で gateway と data-api を並べて起動し、gateway の /healthz が
//      Service Binding 越しに data-api の /healthz に届き、D1 / R2 / DO の結果まで返ることを確かめる
//   3. 別の env を名乗る data-api に届いたら data_api を ng にする。つまり 2 の d1 / r2 / do の ok は、
//      gateway 自身ではなく Service Binding の先の応答から来ている
//
// モックにしないのは data-api と同じ理由：Service Binding が「結線されている」ことの証明は、
// wrangler が wrangler.jsonc の services を解決した上で実際に呼ぶことでしか得られない。
//
// wrangler / vitest は devDependencies に無い。ルートの package.json に集約してある（app-do・data-api と同じ）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig } from "wrangler";
import { DATA_API_BINDING, GATEWAY_HEALTHZ_CHECKS, HEALTHZ_PATH, PACKAGE_NAME } from "./contract.js";
import type { GatewayHealthzBody } from "./contract.js";
import { SKIPPED } from "./healthz.js";

const CONFIG_PATH = new URL("../wrangler.jsonc", import.meta.url);
/** Service Binding の宛先。data-api の Worker 名の正本はこちら */
const DATA_API_CONFIG_PATH = new URL("../../../packages/data-api/wrangler.jsonc", import.meta.url);
const BOOT_TIMEOUT_MS = 120_000;

const ENVS = ["dev", "staging", "production"] as const;

const readConfig = (path: URL, env: string) =>
  unstable_readConfig({ config: decodeURIComponent(path.pathname), env }, { hideWarnings: true });

describe("gateway パッケージ", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musubi/gateway");
  });
});

describe.each(ENVS)("wrangler.jsonc（env.%s）", (env) => {
  const config = readConfig(CONFIG_PATH, env);
  const dataApi = readConfig(DATA_API_CONFIG_PATH, env);

  it("Worker 名が musubi-<env>-gateway", () => {
    expect(config.name).toBe(`musubi-${env}-gateway`);
  });

  it("Service Binding は DATA_API の1本だけで、同じ env の data-api を指す", () => {
    expect(dataApi.name).toBe(`musubi-${env}-data-api`);
    expect(config.services).toEqual([{ binding: DATA_API_BINDING, service: dataApi.name }]);
  });

  it("D1 / R2 / DO を直接触らない：d1_databases・r2_buckets・durable_objects・migrations が無い", () => {
    expect(config.d1_databases).toEqual([]);
    expect(config.r2_buckets).toEqual([]);
    expect(config.durable_objects.bindings).toEqual([]);
    expect(config.migrations).toEqual([]);
  });

  it("infra:sync が扱う他の binding（KV・Queue・dispatch）も持たない", () => {
    expect(config.kv_namespaces).toEqual([]);
    expect(config.queues.producers ?? []).toEqual([]);
    expect(config.queues.consumers ?? []).toEqual([]);
    expect(config.dispatch_namespaces).toEqual([]);
  });

  it("vars.ENVIRONMENT がその env を名乗る（data-api と同じ値。healthz が突き合わせる）", () => {
    expect(config.vars).toMatchObject({ ENVIRONMENT: env });
    expect(dataApi.vars).toMatchObject({ ENVIRONMENT: env });
  });
});

describe.each(ENVS)("gateway → data-api（env.%s・workerd 上の実機）", (env) => {
  const server = createTestHarness({
    workers: [
      // 先頭が primary。server.fetch は gateway に届く
      { configPath: CONFIG_PATH, env, vars: { GIT_SHA: "test-sha" } },
      { configPath: DATA_API_CONFIG_PATH, env, vars: { GIT_SHA: "test-sha" } },
    ],
  });

  beforeAll(async () => {
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it("GET /healthz が Service Binding 越しに data-api に届き、D1 / R2 / DO まで全部 ok で 200", async () => {
    const res = await server.fetch(HEALTHZ_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GatewayHealthzBody;
    expect(body).toEqual({
      service: "gateway",
      env,
      version: "test-sha",
      checks: { data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
      elapsed_ms: expect.any(Number),
    });
    expect(Object.keys(body.checks)).toEqual([...GATEWAY_HEALTHZ_CHECKS]);
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

describe("別の env の data-api に届いたとき（workerd 上の実機）", () => {
  // Service Binding は Worker 名で結ぶので、名前が合えば中身が別の env の data-api でも届いてしまう。
  // data-api の ENVIRONMENT だけを staging に差し替え、gateway（dev）が届いた応答を突き合わせて止めることを見る。
  // d1 / r2 / do の ok が gateway 自身ではなく、Service Binding の先の応答から来ていることの証明も兼ねる
  // （workerd は宛先の無い Service Binding では起動しないので、「data-api を起動しない」形では確かめられない）。
  const server = createTestHarness({
    workers: [
      { configPath: CONFIG_PATH, env: "dev", vars: { GIT_SHA: "test-sha" } },
      { configPath: DATA_API_CONFIG_PATH, env: "dev", vars: { GIT_SHA: "test-sha", ENVIRONMENT: "staging" } },
    ],
  });

  beforeAll(async () => {
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it("data_api が ng: env mismatch の 503 になり、d1 / r2 / do は確かめなかったと示す", async () => {
    const res = await server.fetch(HEALTHZ_PATH);
    expect(res.status).toBe(503);
    const body = (await res.json()) as GatewayHealthzBody;
    expect(body.env).toBe("dev");
    expect(body.checks).toEqual({ data_api: "ng: env mismatch", d1: SKIPPED, r2: SKIPPED, do: SKIPPED });
  });
});
