// gateway Worker の受入試験（Issue #8）。
//
//   1. wrangler が解決した設定で、env ごとに「持つ binding は同じ env の data-api への Service Binding だけ」で、
//      D1 / R2 / DO（と infra:sync が扱う KV・Queue・dispatch）を1つも持たないことを確かめる
//   2. 本物の workerd の上で gateway と data-api を並べて起動し、gateway の /healthz が
//      Service Binding 越しに data-api の /healthz に届き、D1 / R2 / DO の結果まで返ることを確かめる
//   3. 別の env を名乗る data-api に届いたら data_api を ng にする。つまり 2 の d1 / r2 / do の ok は、
//      gateway 自身ではなく Service Binding の先の応答から来ている
//   4. production の設定では、/healthz の詳細を X-Musunest-Probe が secret と一致したときだけ返す（Issue #55）。
//      ヘッダ無し・誤った値・正しい値の3通りと、secret を置いていない production（常に隠す）を workerd 上で確かめる
//
// モックにしないのは data-api と同じ理由：Service Binding が「結線されている」ことの証明は、
// wrangler が wrangler.jsonc の services を解決した上で実際に呼ぶことでしか得られない。
//
// wrangler / vitest は devDependencies に無い。ルートの package.json に集約してある（app-do・data-api と同じ）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig } from "wrangler";
import type { TestHarness } from "wrangler";
import {
  DATA_API_BINDING,
  GATEWAY_HEALTHZ_CHECKS,
  HEALTHZ_PATH,
  PACKAGE_NAME,
  PROBE_HEADER,
  PROBE_TOKEN_SECRET,
} from "./contract.js";
import type { GatewayHealthzBody, HealthzDetail } from "./contract.js";
import { SKIPPED } from "./healthz.js";

const CONFIG_PATH = new URL("../wrangler.jsonc", import.meta.url);
/** Service Binding の宛先。data-api の Worker 名の正本はこちら */
const DATA_API_CONFIG_PATH = new URL("../../../packages/data-api/wrangler.jsonc", import.meta.url);
const BOOT_TIMEOUT_MS = 120_000;

const ENVS = ["dev", "staging", "production"] as const;

/** 詳細を隠す env（03 §5「セキュリティ上の注意」）。dev / staging は今の応答のまま */
const DETAIL: Readonly<Record<(typeof ENVS)[number], HealthzDetail>> = { dev: "public", staging: "public", production: "probe" };

/**
 * テスト用の secret。実物は wrangler secret で置き、リポジトリに書かない。
 * workerd の上では secret も vars も同じ env の文字列なので、harness の vars で渡す。
 */
const PROBE_TOKEN = "test-probe-token-0123456789abcdef";

const readConfig = (path: URL, env: string) =>
  unstable_readConfig({ config: decodeURIComponent(path.pathname), env }, { hideWarnings: true });

describe("gateway パッケージ", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/gateway");
  });
});

describe.each(ENVS)("wrangler.jsonc（env.%s）", (env) => {
  const config = readConfig(CONFIG_PATH, env);
  const dataApi = readConfig(DATA_API_CONFIG_PATH, env);

  it("Worker 名が musunest-<env>-gateway", () => {
    expect(config.name).toBe(`musunest-${env}-gateway`);
  });

  it("Service Binding は DATA_API の1本だけで、同じ env の data-api を指す", () => {
    expect(dataApi.name).toBe(`musunest-${env}-data-api`);
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

  it(`vars.HEALTHZ_DETAIL が ${DETAIL[env]}（production だけ詳細を隠す）`, () => {
    expect(config.vars).toMatchObject({ HEALTHZ_DETAIL: DETAIL[env] });
  });

  it("MUSUNEST_PROBE_TOKEN を vars に書かない（wrangler secret。リポジトリに値を置かない）", () => {
    expect(Object.keys(config.vars)).not.toContain(PROBE_TOKEN_SECRET);
  });
});

describe.each(ENVS)("gateway → data-api（env.%s・workerd 上の実機）", (env) => {
  // production は詳細を X-Musunest-Probe 付きのときだけ返す。dev / staging は secret もヘッダも無しで今の応答を返す
  const probe = DETAIL[env] === "probe";
  const server = createTestHarness({
    workers: [
      // 先頭が primary。server.fetch は gateway に届く
      { configPath: CONFIG_PATH, env, vars: { GIT_SHA: "test-sha", ...(probe ? { [PROBE_TOKEN_SECRET]: PROBE_TOKEN } : {}) } },
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
    const res = await server.fetch(HEALTHZ_PATH, { headers: probe ? { [PROBE_HEADER]: PROBE_TOKEN } : {} });
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

/** 誤った値。長さが違う・前方一致・大文字小文字違い・空（時間一定の比較でも「一致しない」と判定されること） */
const WRONG_PROBES = [
  ["同じ長さの別の値", PROBE_TOKEN.replace(/f$/, "0")],
  ["前方一致（短い）", PROBE_TOKEN.slice(0, -1)],
  ["後ろに足した（長い）", `${PROBE_TOKEN}0`],
  ["大文字にした", PROBE_TOKEN.toUpperCase()],
  ["空", ""],
] as const;

/** harness の fetch が返す Response（undici の型で、workers-types の Response とは別） */
type HarnessResponse = Awaited<ReturnType<TestHarness["fetch"]>>;

/** 構成情報（service・env・version・checks のキー・ng の文言）が本文に1つも無い */
async function expectHidden(res: HarnessResponse, status: 200 | 503): Promise<void> {
  expect(res.status).toBe(status);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ ok: status === 200 });
  for (const leaked of ["gateway", "production", "test-sha", "data_api", "d1", "mismatch", "elapsed_ms"]) {
    expect(text).not.toContain(leaked);
  }
}

describe("production の /healthz は X-Musunest-Probe が正しいときだけ詳細を返す（workerd 上の実機・Issue #55 の受入試験）", () => {
  // production の設定（HEALTHZ_DETAIL=probe）そのままに、secret だけテスト用の値を渡す。
  // data-api の ENVIRONMENT を staging にした 503 の組も並べ、隠した応答が ng の文言も漏らさないことを見る。
  const ok = createTestHarness({
    workers: [
      { configPath: CONFIG_PATH, env: "production", vars: { GIT_SHA: "test-sha", [PROBE_TOKEN_SECRET]: PROBE_TOKEN } },
      { configPath: DATA_API_CONFIG_PATH, env: "production", vars: { GIT_SHA: "test-sha" } },
    ],
  });
  const ng = createTestHarness({
    workers: [
      { configPath: CONFIG_PATH, env: "production", vars: { GIT_SHA: "test-sha", [PROBE_TOKEN_SECRET]: PROBE_TOKEN } },
      { configPath: DATA_API_CONFIG_PATH, env: "production", vars: { GIT_SHA: "test-sha", ENVIRONMENT: "staging" } },
    ],
  });

  beforeAll(async () => {
    await Promise.all([ok.listen(), ng.listen()]);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([ok.close(), ng.close()]);
  }, BOOT_TIMEOUT_MS);

  it("ヘッダ無し：{\"ok\":true} と 200 だけを返す", async () => {
    await expectHidden(await ok.fetch(HEALTHZ_PATH), 200);
  });

  it.each(WRONG_PROBES)("誤った値（%s）：{\"ok\":true} と 200 だけを返す", async (_, value) => {
    await expectHidden(await ok.fetch(HEALTHZ_PATH, { headers: { [PROBE_HEADER]: value } }), 200);
  });

  it("正しい値：詳細（service・env・version・checks・elapsed_ms）を返す", async () => {
    const res = await ok.fetch(HEALTHZ_PATH, { headers: { [PROBE_HEADER]: PROBE_TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      service: "gateway",
      env: "production",
      version: "test-sha",
      checks: { data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
      elapsed_ms: expect.any(Number),
    });
  });

  it("ヘッダ名は大文字小文字を区別しない（HTTP ヘッダの規則どおり）", async () => {
    const res = await ok.fetch(HEALTHZ_PATH, { headers: { [PROBE_HEADER.toLowerCase()]: PROBE_TOKEN } });
    expect(await res.json()).toMatchObject({ service: "gateway" });
  });

  it("ng のとき、ヘッダ無し・誤った値は {\"ok\":false} と 503 だけで、ng の文言を載せない", async () => {
    await expectHidden(await ng.fetch(HEALTHZ_PATH), 503);
    await expectHidden(await ng.fetch(HEALTHZ_PATH, { headers: { [PROBE_HEADER]: WRONG_PROBES[0][1] } }), 503);
  });

  it("ng のとき、正しい値なら ng の文言まで返す（HTTP ステータスは同じ 503）", async () => {
    const res = await ng.fetch(HEALTHZ_PATH, { headers: { [PROBE_HEADER]: PROBE_TOKEN } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as GatewayHealthzBody;
    expect(body.checks).toEqual({ data_api: "ng: env mismatch", d1: SKIPPED, r2: SKIPPED, do: SKIPPED });
  });

  it("404 / 405 はヘッダの有無で変わらない（構成情報を含まない）", async () => {
    for (const headers of [{}, { [PROBE_HEADER]: PROBE_TOKEN }]) {
      expect((await ok.fetch("/", { headers })).status).toBe(404);
      expect((await ok.fetch(HEALTHZ_PATH, { method: "POST", headers })).status).toBe(405);
    }
  });
});

describe("secret を置いていない production（workerd 上の実機）", () => {
  // 閉じる側に倒す：secret が無ければ、どんな値のヘッダが付いていても詳細を返さない
  const server = createTestHarness({
    workers: [
      { configPath: CONFIG_PATH, env: "production", vars: { GIT_SHA: "test-sha" } },
      { configPath: DATA_API_CONFIG_PATH, env: "production", vars: { GIT_SHA: "test-sha" } },
    ],
  });

  beforeAll(async () => {
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it.each([
    ["ヘッダ無し", undefined],
    ["テスト用の値", PROBE_TOKEN],
    ["空", ""],
    ["undefined という文字列", "undefined"],
  ] as const)("%s でも {\"ok\":true} だけを返す", async (_, value) => {
    const res = await server.fetch(HEALTHZ_PATH, { headers: value === undefined ? {} : { [PROBE_HEADER]: value } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
