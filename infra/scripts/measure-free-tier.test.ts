// 無償枠の実測（measure-free-tier.ts）の受入試験（Issue #25）。**実環境には一切届かない。**
//
// Cloudflare の API（サブドメイン・GraphQL）は、2026-09-14 に staging で記録した応答の形を固定データにして返す
// （サブドメイン・Account ID は作り物）。host への GET も差し替える。
// ヘッダがそのまま届くことだけは、ローカル（127.0.0.1）の HTTP サーバで確かめる。
//
//   1. 契約：Worker 名が各 wrangler.jsonc の env.staging と一致する。/ と深いリンクは run_worker_first に当たらず、/healthz は当たる
//   2. 読み取り：GraphQL の応答を窓ごとの行にする。errors は伏せてから落とし、認可エラーは「トークンを作らずに止める」
//   3. 判定：要確認 4（Static Assets）・要確認 2（Service Binding）・CPU 時間（要確認 1 を含む）。サンプリングの揺れを許す幅と、
//      Worker の名前が __unknown__ の間は判定しないこと
//   4. CLI：送る回数の上限・ヘッダ・窓・反映待ち・終了コード。出力に URL・サブドメイン・Account ID・トークンが無い
//   5. nodeGet：sec-fetch-mode: navigate が書き換えられずに届く
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  aboutSent,
  ANALYTICS_QUERY,
  analyticsVariables,
  countsOf,
  DEEP_LINK_PATH,
  DEFAULT_PLAN,
  EXIT_NG,
  EXIT_OK,
  EXIT_UNDETERMINED,
  FREE_CPU_LIMIT_MS,
  judgeAssets,
  judgeCpu,
  judgeServiceBinding,
  MAX_REQUESTS,
  MeasureError,
  NAVIGATION_HEADERS,
  nodeGet,
  parseAnalytics,
  parseWindow,
  readCredentials,
  requestCount,
  ROOT_PATH,
  runCli,
  sanitize,
  scriptName,
  TARGET_ENV,
  UNKNOWN_SCRIPT,
  windowOf,
  WORKERS,
  type CliIo,
  type DriveRecord,
  type HttpResponse,
  type InvocationRow,
  type MeasurePolicy,
  type Worker,
} from "./measure-free-tier.ts";
import { HEALTHZ_PATH } from "./smoke.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONFIG_PATHS: Readonly<Record<Worker, string>> = {
  host: "apps/host/wrangler.jsonc",
  gateway: "apps/gateway/wrangler.jsonc",
  "data-api": "packages/data-api/wrangler.jsonc",
};

const readConfig = (path: string) => parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

// ── 固定データ（作り物の ID）─────────────────────────────────────────────────────

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PROD_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
const TOKEN = "test-token_ABCdef0123456789";
const SUBDOMAIN = "fake-sub-7f3a";
const HOSTNAME = `musubi-staging-host.${SUBDOMAIN}.workers.dev`;

/**
 * 2026-09-14 に staging で記録した応答（1回目の実測：/ と深いリンク 計 20 回・/healthz 20 回）。値はそのまま。
 *   - ページの窓：Worker の起動は 0、assets は 22 回
 *   - healthz の窓：host は sampleInterval 1.5 の重みで 27 回と出た。gateway・data-api は 20 回
 */
const RECORDED = {
  pagesInvocations: [],
  pagesAssets: [{ dimensions: { statusCode: 200 }, sum: { requests: 22 } }],
  healthzInvocations: [
    {
      avg: { sampleInterval: 1.5 },
      dimensions: { scriptName: "musubi-staging-host" },
      max: { cpuTime: 1564 },
      quantiles: { cpuTimeP50: 595, cpuTimeP99: 1564 },
      sum: { cpuTimeUs: 18224, errors: 0, requests: 27 },
    },
    {
      avg: { sampleInterval: 1 },
      dimensions: { scriptName: "musubi-staging-gateway" },
      max: { cpuTime: 1179 },
      quantiles: { cpuTimeP50: 611, cpuTimeP99: 1179 },
      sum: { cpuTimeUs: 12663, errors: 0, requests: 20 },
    },
    {
      avg: { sampleInterval: 1 },
      dimensions: { scriptName: "musubi-staging-data-api" },
      max: { cpuTime: 3770 },
      quantiles: { cpuTimeP50: 2276, cpuTimeP99: 3770 },
      sum: { cpuTimeUs: 47783, errors: 0, requests: 20 },
    },
  ],
};

/** 同じ窓を、Worker の名前が Analytics に反映される前（09:14 UTC まで）に読んだときの形。名前だけが __unknown__ だった。 */
const recordedBeforeNames = () =>
  withAccount({
    ...RECORDED,
    healthzInvocations: RECORDED.healthzInvocations.map((row) => ({ ...row, dimensions: { scriptName: UNKNOWN_SCRIPT } })),
  });

/** 記録した応答の GraphQL の本文。試験ごとに複製する（形を壊す試験が他を巻き込まないように）。 */
const recordedBody = () => withAccount(RECORDED);

function withAccount(account: object) {
  return structuredClone({ data: { viewer: { accounts: [account] } }, errors: null });
}

interface RowSpec {
  readonly name: string;
  readonly requests: number;
  readonly cpuTimeUs?: number;
  readonly cpuMaxUs?: number;
  readonly sampleInterval?: number;
  readonly errors?: number;
}

/** GraphQL の応答の1行（workersInvocationsAdaptive）。 */
function gqlRow(spec: RowSpec) {
  const cpuTimeUs = spec.cpuTimeUs ?? 1_000 * spec.requests;
  const cpuMaxUs = spec.cpuMaxUs ?? Math.round(cpuTimeUs / Math.max(1, spec.requests));
  return {
    avg: { sampleInterval: spec.sampleInterval ?? 1 },
    dimensions: { scriptName: spec.name },
    max: { cpuTime: cpuMaxUs },
    quantiles: { cpuTimeP50: Math.round(cpuMaxUs * 0.6), cpuTimeP99: cpuMaxUs },
    sum: { cpuTimeUs, errors: spec.errors ?? 0, requests: spec.requests },
  };
}

function gqlBody(parts: { readonly pages?: readonly RowSpec[]; readonly assets?: number; readonly healthz?: readonly RowSpec[] }) {
  return withAccount({
    pagesInvocations: (parts.pages ?? []).map(gqlRow),
    pagesAssets:
      parts.assets === undefined || parts.assets === 0 ? [] : [{ dimensions: { statusCode: 200 }, sum: { requests: parts.assets } }],
    healthzInvocations: (parts.healthz ?? []).map(gqlRow),
  });
}

/** healthz の窓で、3つの Worker が n 回ずつ（最大は host 0.8 ms・gateway 0.6 ms・data-api 2.5 ms）。 */
const chain = (n: number): RowSpec[] => [
  { name: scriptName("host"), requests: n, cpuTimeUs: 600 * n, cpuMaxUs: 800 },
  { name: scriptName("gateway"), requests: n, cpuTimeUs: 450 * n, cpuMaxUs: 600 },
  { name: scriptName("data-api"), requests: n, cpuTimeUs: 1_900 * n, cpuMaxUs: 2_500 },
];

const rowsOf = (specs: readonly RowSpec[]): readonly InvocationRow[] =>
  parseAnalytics(gqlBody({ healthz: specs }), []).healthz.invocations;

// ── 1. 契約 ───────────────────────────────────────────────────────────────

describe("契約：宛先の Worker と経路", () => {
  it.each(WORKERS)("%s の Worker 名が wrangler.jsonc の env.staging.name と一致する", (worker) => {
    const config = readConfig(CONFIG_PATHS[worker]) as { env: Record<string, { name: string }> };
    expect(TARGET_ENV).toBe("staging");
    expect(config.env[TARGET_ENV]?.name).toBe(scriptName(worker));
  });

  const runWorkerFirst = (readConfig(CONFIG_PATHS.host) as { assets: { run_worker_first: string[] } }).assets
    .run_worker_first;
  const matches = (path: string) =>
    runWorkerFirst.some((pattern) => new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(path));

  it("/ と深いリンクは run_worker_first に当たらない（Static Assets が返すはずのパス）", () => {
    expect(matches(ROOT_PATH)).toBe(false);
    expect(matches(DEEP_LINK_PATH)).toBe(false);
  });

  it("/healthz は run_worker_first に当たる（host → gateway → data-api を踏む）", () => {
    expect(matches(HEALTHZ_PATH)).toBe(true);
  });

  it("ページの GET はブラウザのページ遷移と同じヘッダを付ける", () => {
    expect(NAVIGATION_HEADERS).toMatchObject({ "sec-fetch-mode": "navigate", accept: "text/html" });
  });

  it(`既定の回数は上限（${MAX_REQUESTS} 回）以内`, () => {
    expect(requestCount(DEFAULT_PLAN)).toBeLessThanOrEqual(MAX_REQUESTS);
  });

  it("Free の CPU 時間の上限は 10 ms（2026-09-14 の一次情報）", () => {
    expect(FREE_CPU_LIMIT_MS).toBe(10);
  });

  it("GraphQL は一次情報とスキーマで確かめたデータセットと欄を読む", () => {
    for (const piece of [
      "workersInvocationsAdaptive",
      "workersAssetsRequestsAdaptiveGroups",
      "sum { requests errors cpuTimeUs }",
      "max { cpuTime }",
      "quantiles { cpuTimeP50 cpuTimeP99 }",
      "avg { sampleInterval }",
      "dimensions { scriptName }",
      "dimensions { statusCode }",
      "scriptName_in: $scripts",
      "hostname: $hostname",
    ]) {
      expect(ANALYTICS_QUERY).toContain(piece);
    }
    // 応答にサブドメインもスクリプトの ID も載せない
    expect(ANALYTICS_QUERY).not.toMatch(/dimensions \{[^}]*(hostname|scriptTag|scriptVersion)/);
  });

  it("GraphQL の変数：3つの Worker 名と __unknown__、host のホスト名、2つの窓", () => {
    const record: DriveRecord = {
      pages: { window: { since: "2026-09-14T09:00:00Z", until: "2026-09-14T09:00:10Z" }, sent: 20 },
      healthz: { window: { since: "2026-09-14T09:00:20Z", until: "2026-09-14T09:00:40Z" }, sent: 20 },
    };
    expect(analyticsVariables(ACCOUNT_ID, HOSTNAME, record)).toEqual({
      accountTag: ACCOUNT_ID,
      scripts: ["musubi-staging-host", "musubi-staging-gateway", "musubi-staging-data-api", UNKNOWN_SCRIPT],
      hostname: HOSTNAME,
      pagesSince: "2026-09-14T09:00:00Z",
      pagesUntil: "2026-09-14T09:00:10Z",
      healthzSince: "2026-09-14T09:00:20Z",
      healthzUntil: "2026-09-14T09:00:40Z",
    });
  });
});

describe("資格情報と窓", () => {
  const env = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };

  it("CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を読む", () => {
    expect(readCredentials(env)).toEqual({ token: TOKEN, accountId: ACCOUNT_ID });
  });

  it.each([
    ["トークンが無い", { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }],
    ["Account ID が空", { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "" }],
    ["Account ID の形でない", { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "not-an-account" }],
    ["トークンに改行", { CLOUDFLARE_API_TOKEN: `${TOKEN}\n`, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }],
    ["production のアカウントを指している", { ...env, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID.toUpperCase() }],
  ])("%s なら落とし、値を出さない", (_, input) => {
    let error: unknown;
    try {
      readCredentials(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MeasureError);
    const message = (error as Error).message;
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(ACCOUNT_ID);
    expect(message).not.toContain("not-an-account");
  });

  it("別のアカウントの CLOUDFLARE_ACCOUNT_ID_PROD があっても通る", () => {
    expect(readCredentials({ ...env, CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT_ID }).accountId).toBe(ACCOUNT_ID);
  });

  it("窓は前後に 2 秒足して秒に丸める", () => {
    expect(windowOf(Date.parse("2026-09-14T09:00:00.400Z"), Date.parse("2026-09-14T09:00:05.100Z"))).toEqual({
      since: "2026-09-14T08:59:58Z",
      until: "2026-09-14T09:00:08Z",
    });
  });

  it.each([
    "2026-09-14T09:00:00Z",
    "2026-09-14T09:00:00Z/",
    "2026-09-14 09:00:00/2026-09-14 09:01:00",
    "2026-09-14T09:01:00Z/2026-09-14T09:00:00Z",
  ])("読めない窓（%s）は落とす", (raw) => {
    expect(() => parseWindow(raw, "--pages-window")).toThrow(MeasureError);
  });
});

// ── 2. 読み取り ─────────────────────────────────────────────────────────────

describe("parseAnalytics：GraphQL の応答を窓ごとの行にする", () => {
  it("記録した応答を読める", () => {
    const snapshot = parseAnalytics(recordedBody(), []);
    expect(snapshot.pages).toEqual({ invocations: [], assets: 22 });
    expect(snapshot.healthz.invocations[0]).toEqual({
      scriptName: "musubi-staging-host",
      requests: 27,
      errors: 0,
      cpuTimeUs: 18224,
      cpuMaxUs: 1564,
      cpuP50Us: 595,
      cpuP99Us: 1564,
      sampleInterval: 1.5,
    });
  });

  it("assets は行の requests を足す。行が無ければ 0", () => {
    expect(parseAnalytics(gqlBody({ assets: 20 }), []).pages.assets).toBe(20);
    expect(parseAnalytics(gqlBody({}), []).pages.assets).toBe(0);
  });

  it("errors は Account ID・サブドメイン・ホスト名・UUID を伏せてから落とす", () => {
    const uuid = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    const body = { data: null, errors: [{ message: `unknown field "count" for account ${ACCOUNT_ID} host ${HOSTNAME} version ${uuid}` }] };
    let message = "";
    try {
      parseAnalytics(body, [ACCOUNT_ID, SUBDOMAIN]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('unknown field \\"count\\"');
    expect(message).not.toContain(ACCOUNT_ID);
    expect(message).not.toContain(SUBDOMAIN);
    expect(message).not.toContain(uuid);
  });

  it("認可エラーは「トークンを作らずに止める」", () => {
    const body = { data: null, errors: [{ message: "not authorized for that account" }] };
    expect(() => parseAnalytics(body, [])).toThrow(/トークンを作らずに止める/);
  });

  it("形が違えば落とす", () => {
    const body = recordedBody() as { data: { viewer: { accounts: { healthzInvocations: { sum: Record<string, unknown> }[] }[] } } };
    body.data.viewer.accounts[0]!.healthzInvocations[0]!.sum.requests = "27";
    expect(() => parseAnalytics(body, [])).toThrow(/sum\.requests が数でない/);
    expect(() => parseAnalytics({ data: { viewer: { accounts: [] } } }, [])).toThrow(/アカウントが無い/);
  });

  it("sanitize は32桁の16進と workers.dev のホスト名を伏せ、長さを切る", () => {
    expect(sanitize(`x ${PROD_ACCOUNT_ID} y a-b.c.workers.dev`, [])).toBe(JSON.stringify("x <伏せた> y <伏せた>.workers.dev"));
    expect(sanitize("z".repeat(500), []).length).toBeLessThan(220);
  });

  it("送った数くらい（半分から倍まで）を同じとみなす。記録した揺れ（27・26・17・22・11 / 20）は全部入る", () => {
    for (const value of [20, 27, 26, 17, 22, 11, 10, 40]) expect(aboutSent(value, 20)).toBe(true);
    for (const value of [0, 9, 41]) expect(aboutSent(value, 20)).toBe(false);
  });

  it("countsOf は Worker ごとと __unknown__ を分けて数える", () => {
    expect(countsOf(parseAnalytics(recordedBeforeNames(), []).healthz.invocations)).toEqual({
      counts: { host: 0, gateway: 0, "data-api": 0 },
      unknown: 67,
    });
    expect(countsOf(parseAnalytics(recordedBody(), []).healthz.invocations)).toEqual({
      counts: { host: 27, gateway: 20, "data-api": 20 },
      unknown: 0,
    });
  });
});

// ── 3. 判定 ─────────────────────────────────────────────────────────────────

describe("judgeAssets：要確認 4（Static Assets は Worker を起動するか）", () => {
  const pages = (specs: readonly RowSpec[], assets: number) => parseAnalytics(gqlBody({ pages: specs, assets }), []).pages;

  it("記録した応答：Worker の起動が 0 で assets が送った数くらい（22 / 20）なら、起動しない", () => {
    expect(judgeAssets(parseAnalytics(recordedBody(), []).pages, 20)).toMatchObject({
      outcome: "not-invoked",
      counts: { host: 0, gateway: 0, "data-api": 0 },
      assets: 22,
    });
  });

  it("host が起動していれば、起動する（100k/日 を消費する）", () => {
    expect(judgeAssets(pages([{ name: scriptName("host"), requests: 10 }], 20), 20).outcome).toBe("invoked");
  });

  it("名前の無い起動があれば判定しない", () => {
    expect(judgeAssets(pages([{ name: UNKNOWN_SCRIPT, requests: 1 }], 20), 20)).toMatchObject({ outcome: "undetermined", unknown: 1 });
  });

  it("assets が送った数の半分に届かなければ判定しない", () => {
    expect(judgeAssets(pages([], 9), 20).outcome).toBe("undetermined");
  });
});

describe("judgeServiceBinding：要確認 2（Service Binding の先は別の requests か）", () => {
  it("記録した応答：gateway・data-api も送った数くらい（27・20・20 / 20）なら、別に数える。サンプリングを残す", () => {
    expect(judgeServiceBinding(parseAnalytics(recordedBody(), []).healthz.invocations, 20)).toMatchObject({
      outcome: "separate",
      counts: { host: 27, gateway: 20, "data-api": 20 },
      sampled: true,
    });
  });

  it("host だけが起動していれば、別に数えない", () => {
    expect(judgeServiceBinding(rowsOf(chain(20).slice(0, 1)), 20).outcome).toBe("not-separate");
  });

  it("host の回数が送った数と合わなければ（他のリクエストが混ざった）判定しない", () => {
    expect(judgeServiceBinding(rowsOf(chain(45)), 20).outcome).toBe("undetermined");
  });

  it("gateway だけが起動していなければ判定しない", () => {
    expect(judgeServiceBinding(rowsOf(chain(20).filter((spec) => spec.name !== scriptName("gateway"))), 20).outcome).toBe(
      "undetermined",
    );
  });

  it("記録した応答（名前が反映される前）は判定せず、時間を空けて読み直すよう言う", () => {
    const finding = judgeServiceBinding(parseAnalytics(recordedBeforeNames(), []).healthz.invocations, 20);
    expect(finding).toMatchObject({ outcome: "undetermined", unknown: 67 });
    expect(finding.reason).toContain("時間を空けて読み直す");
  });
});

describe("judgeCpu：Free の上限に対する余裕", () => {
  it("max の和が上限内なら、合算しても収まる。余裕と平均の和を出す", () => {
    const finding = judgeCpu(rowsOf(chain(20)), 20, 10);
    expect(finding).toMatchObject({ outcome: "within", downstreamExcluded: true });
    if (finding.outcome === "undetermined") throw new Error("unreachable");
    expect(finding.chainMaxMs).toBeCloseTo(3.9);
    expect(finding.marginMs).toBeCloseTo(6.1);
    expect(finding.chainMeanMs).toBeCloseTo(2.95);
    expect(finding.workers[0]).toEqual({ worker: "host", p50Ms: 0.48, p99Ms: 0.8, maxMs: 0.8, meanMs: 0.6, sampled: false });
  });

  it("記録した応答：チェーン合計の上界 6.51 ms（余裕 3.49 ms）。host の平均は下流の和より小さい", () => {
    const finding = judgeCpu(parseAnalytics(recordedBody(), []).healthz.invocations, 20, FREE_CPU_LIMIT_MS);
    expect(finding).toMatchObject({ outcome: "within", downstreamExcluded: true });
    if (finding.outcome === "undetermined") throw new Error("unreachable");
    expect(finding.chainMaxMs).toBeCloseTo(6.513);
    expect(finding.marginMs).toBeCloseTo(3.487);
    expect(finding.chainMeanMs).toBeCloseTo(18.224 / 27 + 12.663 / 20 + 47.783 / 20);
    expect(finding.workers.map((w) => [w.worker, w.sampled])).toEqual([
      ["host", true],
      ["gateway", false],
      ["data-api", false],
    ]);
  });

  it("単体では上限内でも、max の和が上限を超えれば over-if-summed", () => {
    expect(judgeCpu(rowsOf(chain(20).map((spec) => ({ ...spec, cpuMaxUs: 4_000 }))), 20, 10).outcome).toBe("over-if-summed");
  });

  it("単体で上限を超えれば over", () => {
    const specs = chain(20).map((spec, i) => (i === 2 ? { ...spec, cpuMaxUs: 10_500 } : spec));
    expect(judgeCpu(rowsOf(specs), 20, 10).outcome).toBe("over");
  });

  it("host の平均が下流の平均の和以上なら、下流を含まないとは言わない", () => {
    const specs = chain(20).map((spec, i) => (i === 0 ? { ...spec, cpuTimeUs: 100_000 } : spec));
    expect(judgeCpu(rowsOf(specs), 20, 10)).toMatchObject({ downstreamExcluded: false });
  });

  it("Worker が欠けている・回数が合わない・名前が無いなら判定しない", () => {
    expect(judgeCpu(rowsOf(chain(20).slice(0, 2)), 20, 10).outcome).toBe("undetermined");
    expect(judgeCpu(rowsOf(chain(5)), 20, 10).outcome).toBe("undetermined");
    expect(judgeCpu(parseAnalytics(recordedBeforeNames(), []).healthz.invocations, 20, 10).outcome).toBe("undetermined");
  });
});

// ── 4. CLI ────────────────────────────────────────────────────────────────

/** 試験用の方針。待ちの形は MEASURE_POLICY と同じで、時計は差し替える。 */
const FAST: MeasurePolicy = {
  requestTimeoutMs: 1_000,
  phaseGapMs: 8_000,
  firstReadDelayMs: 60_000,
  pollIntervalMs: 30_000,
  maxWaitMs: 5 * 60_000,
};

interface Sent {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface Harness {
  readonly code: number;
  readonly out: string[];
  readonly all: string;
  readonly sent: Sent[];
  readonly graphql: { readonly variables: Record<string, unknown> }[];
  readonly apiCalls: number;
}

const HOST_HEALTHZ_OK = JSON.stringify({
  service: "host",
  env: "staging",
  version: "a1b2c3d",
  checks: { gateway: "ok", data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
  elapsed_ms: 40,
});

interface HarnessOptions {
  readonly env?: Record<string, string | undefined>;
  /** n 回目（1 始まり）の GraphQL の応答 */
  readonly analytics?: (read: number) => unknown;
  /** host への GET の応答を差し替える */
  readonly respond?: (path: string, headers: Readonly<Record<string, string>>) => Omit<HttpResponse, "date">;
  readonly apiStatus?: number;
}

async function runHarness(argv: readonly string[], options: HarnessOptions = {}): Promise<Harness> {
  let now = Date.parse("2026-09-14T09:00:00.300Z");
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const graphql: { variables: Record<string, unknown> }[] = [];
  let apiCalls = 0;
  const io: CliIo = {
    env: options.env ?? { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: async (input, init) => {
      apiCalls++;
      const url = String(input);
      expect(url.startsWith("https://api.cloudflare.com/client/v4/")).toBe(true);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      if (options.apiStatus !== undefined) return new Response("{}", { status: options.apiStatus });
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/workers/subdomain`)) {
        expect(init?.method ?? "GET").toBe("GET");
        return Response.json({ success: true, errors: [], result: { subdomain: SUBDOMAIN } });
      }
      if (url.endsWith("/graphql")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
        expect(body.query).toBe(ANALYTICS_QUERY);
        graphql.push({ variables: body.variables });
        return Response.json(options.analytics?.(graphql.length) ?? gqlBody({}));
      }
      throw new Error(`想定外の API: ${url}`);
    },
    get: async (url, headers) => {
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe(HOSTNAME);
      sent.push({ path: url.pathname, headers });
      now += 150;
      const date = new Date(now).toUTCString();
      if (options.respond !== undefined) return { ...options.respond(url.pathname, headers), date };
      if (url.pathname === HEALTHZ_PATH) {
        return { status: 200, contentType: "application/json", date, text: HOST_HEALTHZ_OK };
      }
      return { status: 200, contentType: "text/html; charset=utf-8", date, text: "<!doctype html><div id=app></div>" };
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    policy: FAST,
  };
  const code = await runCli(argv, io);
  return { code, out, all: [...out, ...err].join("\n"), sent, graphql, apiCalls };
}

/** 出力のどこにも宛先・ID・トークンが無い。 */
function expectNothingSecret(run: Harness): void {
  for (const secret of [SUBDOMAIN, HOSTNAME, ACCOUNT_ID, TOKEN, "workers.dev", "https://"]) {
    expect(run.all).not.toContain(secret);
  }
}

/** 既定の回数（ページ 20・/healthz 20）がそのまま反映された応答。 */

/** 既定の回数（ページ 20・/healthz 20）がそのまま反映された応答。 */
const settled = gqlBody({ pages: [], assets: 20, healthz: chain(20) });

describe("CLI：送って、反映を待って、判定する", () => {
  it("既定では / と深いリンクを 10 回ずつ・/healthz を 20 回、合計 40 回だけ送り、判定できれば exit 0", async () => {
    const run = await runHarness([], {
      analytics: (read) => (read === 1 ? gqlBody({ assets: 8, healthz: chain(3) }) : settled),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.sent).toHaveLength(40);
    expect(run.sent.filter((s) => s.path === ROOT_PATH)).toHaveLength(10);
    expect(run.sent.filter((s) => s.path === DEEP_LINK_PATH)).toHaveLength(10);
    expect(run.sent.filter((s) => s.path === HEALTHZ_PATH)).toHaveLength(20);
    // ページを全部送ってから /healthz を送る
    expect(run.sent.findIndex((s) => s.path === HEALTHZ_PATH)).toBe(20);
    for (const s of run.sent.slice(0, 20)) expect(s.headers).toMatchObject(NAVIGATION_HEADERS);
    // 1回目は途中まで、2回目と3回目が同じ値で反映済み
    expect(run.graphql).toHaveLength(3);
    expect(run.out.at(-1)).toMatch(/^measure: OK/);
    expect(run.all).toContain("判定: Worker を起動しない（100k/日 を消費しない）");
    expect(run.all).toContain("判定: 別に数える（host への 1 回が 3 requests になる）");
    expect(run.all).toContain("判定: 合算しても上限（10 ms）に収まる");
    expectNothingSecret(run);
  });

  it("窓は Date ヘッダから作り、ページの窓と /healthz の窓は重ならない。読み直すための窓を出す", async () => {
    const run = await runHarness([], { analytics: () => settled });
    const variables = run.graphql[0]?.variables ?? {};
    expect(variables).toMatchObject({ accountTag: ACCOUNT_ID, hostname: HOSTNAME });
    const pagesUntil = Date.parse(String(variables.pagesUntil));
    const healthzSince = Date.parse(String(variables.healthzSince));
    expect(pagesUntil).toBeLessThan(healthzSince);
    expect(run.all).toContain(
      `--pages-window ${String(variables.pagesSince)}/${String(variables.pagesUntil)} --healthz-window ${String(variables.healthzSince)}/${String(variables.healthzUntil)}`,
    );
  });

  it(`合計が ${MAX_REQUESTS} 回を超える指定は、1回も送らず API も呼ばずに exit 1`, async () => {
    const run = await runHarness(["--pages", "15", "--healthz", "21"]);
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(0);
    expect(run.apiCalls).toBe(0);
    expect(run.all).toContain("1回の実測は 50 回まで");
  });

  it("CLOUDFLARE_ACCOUNT_ID が production のアカウントなら、1回も送らずに exit 1", async () => {
    const run = await runHarness([], {
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(0);
    expect(run.apiCalls).toBe(0);
    expectNothingSecret(run);
  });

  it("API が 403 なら、トークンを作らずに止める（exit 1・1回も送らない）", async () => {
    const run = await runHarness([], { apiStatus: 403 });
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(0);
    expect(run.all).toContain("トークンを作らずに止める");
  });

  it("ページが SPAシェルでなければ（Worker が JSON を返した）その場で止め、Analytics を読まずに exit 1", async () => {
    const run = await runHarness([], {
      respond: (path) =>
        path === DEEP_LINK_PATH
          ? { status: 404, contentType: "application/json", text: '{"error":"not found"}' }
          : { status: 200, contentType: "text/html", text: "<!doctype html>" },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(2);
    expect(run.graphql).toHaveLength(0);
    expect(run.all).toContain(`ページ の 2 回目（${DEEP_LINK_PATH}）: HTTP 404`);
    expectNothingSecret(run);
  });

  it("/healthz が全層 ok でなければその場で止める", async () => {
    const run = await runHarness([], {
      respond: (path) =>
        path === HEALTHZ_PATH
          ? { status: 503, contentType: "application/json", text: HOST_HEALTHZ_OK.replace('"do":"ok"', '"do":"ng: boom"') }
          : { status: 200, contentType: "text/html", text: "<!doctype html>" },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.sent).toHaveLength(21);
    expect(run.graphql).toHaveLength(0);
  });

  it("反映を待ちきれなければ、上限までしか読まず、最後の値で判定して exit 2", async () => {
    const run = await runHarness([], {
      analytics: (read) => gqlBody({ assets: read * 2, healthz: chain(read) }),
    });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    // 最初に読んでから 5 分まで・30 秒ごと → 0 秒から 300 秒までの 11 回
    expect(run.graphql).toHaveLength(11);
    expect(run.all).toContain("反映を待ちきれなかった");
    expect(run.all).toContain("時間を空けて読み直す: --pages-window ");
  });

  it("記録した応答なら判定でき、サンプリングを注記して exit 0", async () => {
    const run = await runHarness([], { analytics: () => recordedBody() });
    expect(run.code).toBe(EXIT_OK);
    expect(run.all).toContain("サンプリングあり");
    expect(run.all).toContain("チェーン合計の上界（max の和）  6.51 ms（余裕 3.49 ms）");
    expectNothingSecret(run);
  });

  it("名前が反映される前の応答なら、判定できないとして exit 2", async () => {
    const run = await runHarness([], { analytics: () => recordedBeforeNames() });
    expect(run.code).toBe(EXIT_UNDETERMINED);
    expect(run.all).toContain("時間を空けて読み直す");
    expectNothingSecret(run);
  });

  it("ページで Worker が起動していれば、前提が崩れたとして exit 1", async () => {
    const run = await runHarness([], {
      analytics: () => gqlBody({ pages: [{ name: scriptName("host"), requests: 10 }], assets: 20, healthz: chain(20) }),
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("100k/日 を消費する");
  });

  it("窓を渡すと GET を送らずに読み直す（最初の待ちも無い）", async () => {
    const run = await runHarness(
      ["--pages-window", "2026-09-14T09:00:00Z/2026-09-14T09:00:10Z", "--healthz-window", "2026-09-14T09:00:20Z/2026-09-14T09:00:40Z"],
      { analytics: () => settled },
    );
    expect(run.code).toBe(EXIT_OK);
    expect(run.sent).toHaveLength(0);
    expect(run.graphql).toHaveLength(2);
    expect(run.graphql[0]?.variables).toMatchObject({ pagesSince: "2026-09-14T09:00:00Z", healthzUntil: "2026-09-14T09:00:40Z" });
  });

  it("重なる窓・片方だけの窓は落とす", async () => {
    const overlap = await runHarness([
      "--pages-window",
      "2026-09-14T09:00:00Z/2026-09-14T09:00:30Z",
      "--healthz-window",
      "2026-09-14T09:00:20Z/2026-09-14T09:00:40Z",
    ]);
    expect(overlap.code).toBe(EXIT_NG);
    expect(overlap.apiCalls).toBe(0);
    const half = await runHarness(["--pages-window", "2026-09-14T09:00:00Z/2026-09-14T09:00:30Z"]);
    expect(half.code).toBe(EXIT_NG);
  });

  it("引数の誤りは値を出さずに exit 1", async () => {
    const run = await runHarness(["https://secret.example.workers.dev"]);
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).not.toContain("secret.example");
  });
});

// ── 5. nodeGet ────────────────────────────────────────────────────────────

/** 受けたヘッダを覚えるローカル（127.0.0.1）の HTTP サーバ。 */
async function withServer(run: (origin: string, received: Record<string, string | string[] | undefined>[]) => Promise<void>) {
  const received: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((req, res) => {
    received.push(req.headers);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html>");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, received);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe("nodeGet：host への GET", () => {
  it("sec-fetch-mode: navigate が書き換えられずに届き、status・content-type・Date・本文を返す", async () => {
    await withServer(async (origin, received) => {
      const res = await nodeGet(new URL(DEEP_LINK_PATH, origin), NAVIGATION_HEADERS, 2_000);
      expect(res).toMatchObject({ status: 200, contentType: "text/html", text: "<!doctype html>" });
      expect(Number.isNaN(Date.parse(res.date ?? ""))).toBe(false);
      expect(received[0]?.["sec-fetch-mode"]).toBe("navigate");
    });
  });

  it("（使わない理由）Node の fetch は sec-fetch-mode を cors に書き換える。これが落ちたら冒頭の理由を見直す", async () => {
    await withServer(async (origin, received) => {
      await (await fetch(new URL(DEEP_LINK_PATH, origin), { headers: NAVIGATION_HEADERS })).text();
      expect(received[0]?.["sec-fetch-mode"]).toBe("cors");
    });
  });
});
