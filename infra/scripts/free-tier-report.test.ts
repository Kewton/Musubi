// 無償枠の集計（free-tier-report.ts）の受入試験（Issue #26）。**実環境には一切届かない。**
//
// GraphQL の応答は、2026-09-14 にアカウント①で記録した応答の形を固定データにして返す（Account ID・トークン・namespace の ID は作り物）。
//
//   1. 契約：Worker 名が各 wrangler.jsonc の env.<env>.name と一致する。上限と昇格トリガーの線（06 §5）。読むデータセットと欄
//   2. 期間と資格情報：UTC の日付・既定の 7 日・Analytics が読める幅。①と②が同じアカウントを指していたら止める
//   3. 読み取り：GraphQL の応答を行にする。errors は伏せてから落とし、認可エラーは「トークンを作らずに止める」。行が上限に達したら落とす
//   4. 判定：P-1（上限超過の起動）・P-2（3 日続けて 5 万）・P-3（2.5 GB）・P-4（D1 の行）とチェーン合計の上界
//   5. CLI：GraphQL の読み取りしか呼ばない。出力に Account ID・トークン・namespace の ID・MUSUNEST 以外の Worker 名が無い。終了コード
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SPECS,
  ACCOUNTS,
  CHAIN_MARGIN_FLOOR_MS,
  cpuCautions,
  datesOf,
  EXIT_NG,
  EXIT_OK,
  EXIT_TOUCHED,
  FREE_LIMITS,
  isExceeded,
  isMusunest,
  judgeTriggers,
  MAX_DAYS,
  musunestScript,
  parsePeriod,
  parseReport,
  readCredentials,
  REPORT_QUERY,
  ReportError,
  ROW_LIMIT,
  runCli,
  summarizeAccount,
  summarizeCpu,
  summarizeD1,
  summarizeExceeded,
  summarizeRequests,
  summarizeStorage,
  TRIGGERS,
  type AccountData,
  type CliIo,
  type InvocationRow,
  type Period,
} from "./free-tier-report.ts";
import { UNKNOWN_SCRIPT, WORKERS, type Worker } from "./measure-free-tier.ts";
import { ENVS } from "./sync-bindings.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONFIG_PATHS: Readonly<Record<Worker, string>> = {
  host: "apps/host/wrangler.jsonc",
  gateway: "apps/gateway/wrangler.jsonc",
  "data-api": "packages/data-api/wrangler.jsonc",
};

// ── 固定データ（作り物の ID）─────────────────────────────────────────────────────

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PROD_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
const TOKEN = "test-token_ABCdef0123456789";
const PROD_TOKEN = "prod-token_XYZ9876543210fedcba";
const NAMESPACE_ID = "aaaabbbbccccddddeeeeffff00001111";
const OTHER_SCRIPT = "someone-elses-worker";

const ENV_BOTH = {
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN_PROD: PROD_TOKEN,
  CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT_ID,
};

const WEEK: Period = { since: "2026-09-08", until: "2026-09-14" };

/**
 * 2026-09-14 15:00 UTC ごろ、アカウント①を 2026-09-08〜2026-09-14 で読んだ応答。値はそのまま（ID だけ作り物）。
 *   - 起動は 09-14（staging を作った日）の3つの Worker だけ。host・gateway は sampleInterval が 1 でない
 *   - DO（SQLite）は 1 namespace・24,576 bytes。KV 型 DO は無い。D1 は 8 行読み 11 行書いた
 */
const RECORDED = {
  invocations: [
    {
      avg: { sampleInterval: 1 },
      dimensions: { date: "2026-09-14", scriptName: "musunest-staging-data-api", status: "success" },
      max: { cpuTime: 5685 },
      sum: { cpuTimeUs: 177654, errors: 0, requests: 68, subrequests: 68 },
    },
    {
      avg: { sampleInterval: 1.1363636363636365 },
      dimensions: { date: "2026-09-14", scriptName: "musunest-staging-gateway", status: "success" },
      max: { cpuTime: 1993 },
      sum: { cpuTimeUs: 67038, errors: 0, requests: 75, subrequests: 75 },
    },
    {
      avg: { sampleInterval: 1.1384615384615384 },
      dimensions: { date: "2026-09-14", scriptName: "musunest-staging-host", status: "success" },
      max: { cpuTime: 1846 },
      sum: { cpuTimeUs: 58770, errors: 0, requests: 74, subrequests: 74 },
    },
  ],
  doSqlStorage: [{ dimensions: { date: "2026-09-14", namespaceId: NAMESPACE_ID }, max: { storedBytes: 24576 } }],
  doKvStorage: [],
  d1: [{ dimensions: { date: "2026-09-14" }, sum: { rowsRead: 8, rowsWritten: 11 } }],
};

/**
 * 2026-09-14 16:14 UTC にアカウント②を同じ期間で読んだ集計の出力から組み立てた応答（production を作った日。行の分け方と cpuTimeUs は丸めた値）。
 *   - host 14 回（サンプリングあり）max 3.30 ms・gateway 9 回 max 2.34 ms・data-api 7 回 max 11.30 ms（単体で上限を超えた。status は success）
 */
const PRODUCTION_SPECS: readonly RowSpec[] = [
  { name: "musunest-production-host", requests: 14, cpuMaxUs: 3_300, cpuTimeUs: 24_640, sampleInterval: 1.4 },
  { name: "musunest-production-gateway", requests: 9, cpuMaxUs: 2_340, cpuTimeUs: 16_470 },
  { name: "musunest-production-data-api", requests: 7, cpuMaxUs: 11_300, cpuTimeUs: 42_630 },
];

function withAccount(account: object) {
  return structuredClone({ data: { viewer: { accounts: [account] } }, errors: null });
}

const recordedBody = () => withAccount(RECORDED);

interface RowSpec {
  readonly date?: string;
  readonly name: string;
  readonly status?: string;
  readonly requests: number;
  readonly cpuMaxUs?: number;
  readonly cpuTimeUs?: number;
  readonly subrequests?: number;
  readonly sampleInterval?: number;
}

function gqlInvocation(spec: RowSpec) {
  return {
    avg: { sampleInterval: spec.sampleInterval ?? 1 },
    dimensions: { date: spec.date ?? "2026-09-14", scriptName: spec.name, status: spec.status ?? "success" },
    max: { cpuTime: spec.cpuMaxUs ?? 1_000 },
    sum: {
      cpuTimeUs: spec.cpuTimeUs ?? 500 * spec.requests,
      errors: spec.status === undefined || spec.status === "success" ? 0 : spec.requests,
      requests: spec.requests,
      subrequests: spec.subrequests ?? spec.requests,
    },
  };
}

function gqlBody(parts: {
  readonly invocations?: readonly RowSpec[];
  readonly storage?: readonly { readonly date: string; readonly bytes: number }[];
  readonly d1?: readonly { readonly date: string; readonly read: number; readonly written: number }[];
}) {
  return withAccount({
    invocations: (parts.invocations ?? []).map(gqlInvocation),
    doSqlStorage: (parts.storage ?? []).map((s, i) => ({
      dimensions: { date: s.date, namespaceId: `${NAMESPACE_ID.slice(0, 31)}${i}` },
      max: { storedBytes: s.bytes },
    })),
    doKvStorage: [],
    d1: (parts.d1 ?? []).map((d) => ({ dimensions: { date: d.date }, sum: { rowsRead: d.read, rowsWritten: d.written } })),
  });
}

const dataOf = (body: unknown): AccountData => parseReport(body, "アカウント①", []);
const rowsOf = (specs: readonly RowSpec[]): readonly InvocationRow[] => dataOf(gqlBody({ invocations: specs })).invocations;

/** 期間の日付ごとに、1つの Worker が requests 回ずつ起動した行。 */
const daily = (requests: readonly number[], name = musunestScript("production", "host")): RowSpec[] =>
  datesOf(WEEK).flatMap((date, i) => ((requests[i] ?? 0) > 0 ? [{ date, name, requests: requests[i] ?? 0 }] : []));

// ── 1. 契約 ───────────────────────────────────────────────────────────────

describe("契約：Worker 名・アカウント・上限と昇格トリガー", () => {
  const readConfig = (path: string) =>
    parse(readFileSync(join(ROOT, path), "utf8")) as { env: Record<string, { name: string }> };

  it.each(ENVS.flatMap((env) => WORKERS.map((worker) => [env, worker] as const)))(
    "%s の %s の Worker 名が wrangler.jsonc の env.<env>.name と一致する",
    (env, worker) => {
      expect(readConfig(CONFIG_PATHS[worker]).env[env]?.name).toBe(musunestScript(env, worker));
      expect(isMusunest(musunestScript(env, worker))).toBe(true);
    },
  );

  it("MUSUNEST 以外の名前・__unknown__ は MUSUNEST に数えない", () => {
    expect(isMusunest(OTHER_SCRIPT)).toBe(false);
    expect(isMusunest(UNKNOWN_SCRIPT)).toBe(false);
    expect(isMusunest("musunest-staging-host-old")).toBe(false);
  });

  it("アカウント①は dev と staging、②は production（06 §4.3 案A）。3つの環境がどちらか一方にだけある", () => {
    expect(ACCOUNT_SPECS["1"].envs).toEqual(["dev", "staging"]);
    expect(ACCOUNT_SPECS["2"].envs).toEqual(["production"]);
    expect(ACCOUNTS.flatMap((key) => ACCOUNT_SPECS[key].envs).toSorted()).toEqual([...ENVS].toSorted());
    expect(ACCOUNT_SPECS["2"]).toMatchObject({
      tokenVar: "CLOUDFLARE_API_TOKEN_PROD",
      accountIdVar: "CLOUDFLARE_ACCOUNT_ID_PROD",
    });
  });

  it("Free の上限は 2026-09-14 の一次情報どおり", () => {
    expect(FREE_LIMITS).toEqual({
      dailyRequests: 100_000,
      cpuMs: 10,
      doStoredBytes: 5_000_000_000,
      d1RowsReadPerDay: 5_000_000,
      d1RowsWrittenPerDay: 100_000,
    });
  });

  it("昇格トリガーの線は 06 §5 で承認したとおり（上限の 50%・P-2 は 3 日連続）", () => {
    expect(TRIGGERS).toEqual({
      p2DailyRequests: 50_000,
      p2ConsecutiveDays: 3,
      p3DoStoredBytes: 2_500_000_000,
      p4RowsReadPerDay: 2_500_000,
      p4RowsWrittenPerDay: 50_000,
    });
    expect(CHAIN_MARGIN_FLOOR_MS).toBe(3);
  });

  it("GraphQL は、スキーマで確かめたデータセットと欄を日付で絞って読むだけ（書き込みをしない）", () => {
    for (const piece of [
      "workersInvocationsAdaptive(",
      "sum { requests errors subrequests cpuTimeUs }",
      "max { cpuTime }",
      "avg { sampleInterval }",
      "dimensions { date scriptName status }",
      "durableObjectsSqlStorageGroups(",
      "durableObjectsStorageGroups(",
      "max { storedBytes }",
      "d1AnalyticsAdaptiveGroups(",
      "sum { rowsRead rowsWritten }",
      "filter: { date_geq: $since, date_leq: $until }",
    ]) {
      expect(REPORT_QUERY).toContain(piece);
    }
    expect(REPORT_QUERY).toMatch(/^query /);
    expect(REPORT_QUERY).not.toMatch(/mutation/i);
  });
});

// ── 2. 期間と資格情報 ─────────────────────────────────────────────────────────

describe("期間：UTC の日付", () => {
  const now = Date.parse("2026-09-14T15:00:00Z");

  it("既定は今日（UTC）までの 7 日", () => {
    expect(parsePeriod({}, now)).toEqual({ since: "2026-09-08", until: "2026-09-14" });
    // 日本時間では 15 日でも、UTC の日付で決める
    expect(parsePeriod({}, Date.parse("2026-09-14T23:59:59Z"))).toEqual({ since: "2026-09-08", until: "2026-09-14" });
  });

  it("--until だけなら、その日までの 7 日。両方渡せばそのまま", () => {
    expect(parsePeriod({ until: "2026-09-10" }, now)).toEqual({ since: "2026-09-04", until: "2026-09-10" });
    expect(parsePeriod({ since: "2026-09-12", until: "2026-09-12" }, now)).toEqual({ since: "2026-09-12", until: "2026-09-12" });
  });

  it("日付の形・前後・幅・未来・遡りすぎを落とす", () => {
    for (const raw of [
      { since: "2026-9-8" },
      { since: "2026-02-30" },
      { until: "2026-09-14T00:00:00Z" },
      { since: "2026-09-14", until: "2026-09-13" },
      { until: "2026-09-15" },
      { since: "2026-06-01" },
    ]) {
      expect(() => parsePeriod(raw, now), JSON.stringify(raw)).toThrow(ReportError);
    }
    expect(() => parsePeriod({ since: "2026-08-14", until: "2026-09-14" }, now)).toThrow(`${MAX_DAYS} 日まで`);
    expect(() => parsePeriod({ since: "2026-06-01", until: "2026-06-10" }, now)).toThrow("89 日前まで");
    expect(parsePeriod({ since: "2026-08-15", until: "2026-09-14" }, now).since).toBe("2026-08-15");
  });

  it("datesOf は両端を含む古い順の日付", () => {
    expect(datesOf({ since: "2026-08-30", until: "2026-09-02" })).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });
});

describe("資格情報", () => {
  it("選んだアカウントの分だけ読む（①だけなら②の変数は要らない）", () => {
    const one = readCredentials({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }, ["1"]);
    expect([...one.keys()]).toEqual(["1"]);
    const both = readCredentials(ENV_BOTH, ["1", "2"]);
    expect(both.get("2")).toEqual({ token: PROD_TOKEN, accountId: PROD_ACCOUNT_ID });
  });

  it("無い・形が違う資格情報は、値を出さずに落とす", () => {
    const cases: Record<string, string | undefined>[] = [
      { CLOUDFLARE_API_TOKEN: TOKEN },
      { CLOUDFLARE_API_TOKEN: "has space", CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "not-an-account" },
    ];
    for (const env of cases) {
      expect(() => readCredentials(env, ["1"])).toThrow(ReportError);
      try {
        readCredentials(env, ["1"]);
      } catch (e) {
        expect(String(e)).not.toContain(TOKEN);
        expect(String(e)).not.toContain("not-an-account");
      }
    }
  });

  it("①と②が同じアカウントを指していたら止める（同じ数字を2回数えない）", () => {
    expect(() => readCredentials({ ...ENV_BOTH, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID.toUpperCase() }, ["1", "2"])).toThrow(
      "同じアカウント",
    );
    expect(() => readCredentials({ ...ENV_BOTH, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID }, ["1"])).toThrow("同じアカウント");
  });
});

// ── 3. 読み取り ───────────────────────────────────────────────────────────────

describe("読み取り：GraphQL の応答", () => {
  it("記録した応答を行にする。namespace の ID は持たない", () => {
    const data = dataOf(recordedBody());
    expect(data.invocations).toHaveLength(3);
    expect(data.invocations[0]).toEqual({
      date: "2026-09-14",
      scriptName: "musunest-staging-data-api",
      status: "success",
      requests: 68,
      errors: 0,
      subrequests: 68,
      cpuTimeUs: 177654,
      cpuMaxUs: 5685,
      sampleInterval: 1,
    });
    expect(data.doStorage).toEqual([{ date: "2026-09-14", storedBytes: 24576 }]);
    expect(data.d1).toEqual([{ date: "2026-09-14", rowsRead: 8, rowsWritten: 11 }]);
    expect(JSON.stringify(data)).not.toContain(NAMESPACE_ID);
  });

  it("errors は伏せてから落とす。認可エラーは「トークンを作らずに止める」", () => {
    const failed = { data: null, errors: [{ message: `bad account ${ACCOUNT_ID} token ${TOKEN}` }] };
    expect(() => parseReport(failed, "アカウント①", [TOKEN, ACCOUNT_ID])).toThrow(ReportError);
    try {
      parseReport(failed, "アカウント①", [TOKEN, ACCOUNT_ID]);
    } catch (e) {
      expect(String(e)).not.toContain(ACCOUNT_ID);
      expect(String(e)).not.toContain(TOKEN);
    }
    const denied = { data: null, errors: [{ message: "not authorized for that account" }] };
    expect(() => parseReport(denied, "アカウント②", [])).toThrow("トークンを作らずに止める");
  });

  it("アカウントが無い・形が違う・行が上限に達した応答は落とす", () => {
    expect(() => dataOf({ data: { viewer: { accounts: [] } } })).toThrow("アカウント①");
    const broken = recordedBody();
    (broken.data.viewer.accounts[0] as { invocations: unknown[] }).invocations[0] = { dimensions: {} };
    expect(() => dataOf(broken)).toThrow("応答の形が違う");
    const full = gqlBody({ invocations: Array.from({ length: ROW_LIMIT }, () => ({ name: OTHER_SCRIPT, requests: 1 })) });
    expect(() => dataOf(full)).toThrow("期間を短くして読む");
  });
});

// ── 4. 判定 ───────────────────────────────────────────────────────────────

describe("P-2：日次リクエスト", () => {
  it("記録した応答：最大は 09-14 の 217 回（Service Binding の先も数える）", () => {
    const summary = summarizeRequests(dataOf(recordedBody()).invocations, WEEK);
    expect(summary.days).toHaveLength(7);
    expect(summary.max).toEqual({ date: "2026-09-14", total: 217, musunest: 217, unknown: 0, other: 0 });
    expect(summary).toMatchObject({ daysOver: 0, longestRunOver: 0, otherScripts: 0, unknown: 0, sampled: true, touched: false });
  });

  it("50,000 を超えた日が 3 日続けば触れた", () => {
    const summary = summarizeRequests(rowsOf(daily([0, 50_001, 60_000, 70_000, 0, 0, 0])), WEEK);
    expect(summary).toMatchObject({ daysOver: 3, longestRunOver: 3, touched: true });
  });

  it("2 日ずつ途切れた・ちょうど 50,000 の日は、連続に数えない", () => {
    expect(summarizeRequests(rowsOf(daily([60_000, 60_000, 0, 60_000, 60_000, 0, 0])), WEEK)).toMatchObject({
      daysOver: 4,
      longestRunOver: 2,
      touched: false,
    });
    expect(summarizeRequests(rowsOf(daily([60_000, 50_000, 60_000, 60_000, 0, 0, 0])), WEEK).touched).toBe(false);
  });

  it("MUSUNEST 以外の Worker も合計に入れる（上限はアカウント単位）", () => {
    const rows = rowsOf([
      ...daily([30_000, 30_000, 30_000]),
      ...daily([30_000, 30_000, 30_000], OTHER_SCRIPT),
    ]);
    const summary = summarizeRequests(rows, WEEK);
    expect(summary.max).toMatchObject({ total: 60_000, musunest: 30_000, other: 30_000 });
    expect(summary).toMatchObject({ otherScripts: 1, touched: true, overAtStart: true });
  });

  it("名前が __unknown__ の起動は合計に入れ、その他の Worker とは分けて数える", () => {
    const summary = summarizeRequests(rowsOf([{ name: UNKNOWN_SCRIPT, requests: 30 }, { name: OTHER_SCRIPT, requests: 2 }]), WEEK);
    expect(summary.max).toEqual({ date: "2026-09-14", total: 32, musunest: 0, unknown: 30, other: 2 });
    expect(summary).toMatchObject({ otherScripts: 1, unknown: 30 });
  });
});

describe("P-1：上限超過の起動", () => {
  it("status が exceeded で始まるものを数える", () => {
    expect(isExceeded("exceededResources")).toBe(true);
    for (const status of ["success", "clientDisconnected", "scriptThrewException", "internalError"]) {
      expect(isExceeded(status)).toBe(false);
    }
  });

  it("MUSUNEST の Worker に 1 回でもあれば触れた。名前が __unknown__ の起動も MUSUNEST に数える", () => {
    expect(summarizeExceeded(rowsOf([{ name: musunestScript("production", "data-api"), status: "exceededResources", requests: 1 }])))
      .toEqual({ musunest: 1, unknown: 0, other: 0, touched: true });
    expect(summarizeExceeded(rowsOf([{ name: UNKNOWN_SCRIPT, status: "exceededResources", requests: 2 }]))).toMatchObject({
      unknown: 2,
      touched: true,
    });
  });

  it("MUSUNEST 以外の Worker の超過は参考に出すだけで、触れたことにしない", () => {
    expect(
      summarizeExceeded(
        rowsOf([
          { name: OTHER_SCRIPT, status: "exceededResources", requests: 5 },
          { name: musunestScript("staging", "host"), status: "scriptThrewException", requests: 3 },
        ]),
      ),
    ).toEqual({ musunest: 0, unknown: 0, other: 5, touched: false });
  });
});

describe("CPU 時間：チェーン合計の上界", () => {
  it("記録した応答：staging の max の和は 9.52 ms（余裕 0.48 ms）。dev は起動なし", () => {
    const rows = dataOf(recordedBody()).invocations;
    const staging = summarizeCpu(rows, "staging");
    expect(staging.workers.map((w) => [w.worker, w.requests, w.cpuMaxMs])).toEqual([
      ["host", 74, 1.846],
      ["gateway", 75, 1.993],
      ["data-api", 68, 5.685],
    ]);
    expect(staging.chainMaxMs).toBeCloseTo(9.524, 6);
    expect(staging.marginMs).toBeCloseTo(0.476, 6);
    expect(staging.workers[2]?.cpuMeanMs).toBeCloseTo(177.654 / 68, 6);
    expect(staging.workers.map((w) => w.subrequestsPerRequest)).toEqual([1, 1, 1]);
    expect(staging.workers.map((w) => w.sampled)).toEqual([true, true, false]);
    expect(summarizeCpu(rows, "dev")).toMatchObject({ chainMaxMs: undefined, marginMs: undefined });
  });

  it("日と status をまたいで、回数は足し、max は最大を取る。MUSUNEST 以外の Worker は見ない", () => {
    const rows = rowsOf([
      { date: "2026-09-13", name: musunestScript("production", "host"), requests: 10, cpuMaxUs: 1_200, cpuTimeUs: 6_000 },
      { date: "2026-09-14", name: musunestScript("production", "host"), requests: 30, cpuMaxUs: 2_400, cpuTimeUs: 18_000 },
      { date: "2026-09-14", name: musunestScript("production", "host"), status: "clientDisconnected", requests: 1, cpuMaxUs: 900 },
      { name: musunestScript("production", "gateway"), requests: 41, cpuMaxUs: 1_000 },
      { name: OTHER_SCRIPT, requests: 5, cpuMaxUs: 300_000 },
    ]);
    const production = summarizeCpu(rows, "production");
    expect(production.workers[0]).toMatchObject({ requests: 41, cpuMaxMs: 2.4 });
    // data-api が起動していないので、チェーンの上界は出さない
    expect(production.chainMaxMs).toBeUndefined();
  });
});

describe("CPU 時間の注意（昇格トリガーではない）", () => {
  it("記録した応答：staging は余裕 0.48 ms、production は data-api が単体で上限を超えた。dev は出さない", () => {
    const one = summarizeAccount("1", dataOf(recordedBody()), WEEK);
    const two = summarizeAccount("2", dataOf(gqlBody({ invocations: PRODUCTION_SPECS })), WEEK);
    expect(two.cpu[0]?.chainMaxMs).toBeCloseTo(16.94, 6);
    expect(cpuCautions([one, two])).toEqual([
      "staging の CPU 時間: チェーン合計の上界 9.52 ms（余裕 0.48 ms）。余裕が 3 ms 未満（05 §3.5 の処置の線。昇格するかを人が決める）",
      "production の CPU 時間: data-api が単体で上限を超えた記録（max 11.30 ms）・チェーン合計の上界 16.94 ms（余裕 -6.94 ms）。" +
        "余裕が 3 ms 未満（05 §3.5 の処置の線。昇格するかを人が決める）",
    ]);
    // 上限を超えた記録があっても、エラー（exceededResources）が無ければ P-1 には触れていない
    expect(two.exceeded.touched).toBe(false);
  });

  it("余裕が 3 ms 以上で、単体でも超えていなければ何も出さない", () => {
    const quiet = rowsOf(WORKERS.map((worker) => ({ name: musunestScript("staging", worker), requests: 20, cpuMaxUs: 2_000 })));
    expect(cpuCautions([summarizeAccount("1", { invocations: quiet, doStorage: [], d1: [] }, WEEK)])).toEqual([]);
  });
});

describe("P-3・P-4：DO の保存容量と D1 の行", () => {
  it("DO は日ごとに namespace の max を足し、その最大を取る。2.5 GB を超えたら触れた", () => {
    const storage = (bytes: readonly { date: string; bytes: number }[]) =>
      summarizeStorage(dataOf(gqlBody({ storage: bytes })).doStorage, WEEK);
    expect(
      storage([
        { date: "2026-09-13", bytes: 1_000_000_000 },
        { date: "2026-09-14", bytes: 1_200_000_000 },
        { date: "2026-09-14", bytes: 1_300_000_000 },
      ]),
    ).toEqual({ maxBytes: 2_500_000_000, maxDate: "2026-09-14", touched: false });
    expect(storage([{ date: "2026-09-14", bytes: 2_500_000_001 }]).touched).toBe(true);
    expect(storage([])).toEqual({ maxBytes: 0, maxDate: undefined, touched: false });
  });

  it("D1 は読み取り 2,500,000 行/日・書き込み 50,000 行/日を超えたら触れた", () => {
    const d1 = (rows: readonly { date: string; read: number; written: number }[]) =>
      summarizeD1(dataOf(gqlBody({ d1: rows })).d1, WEEK);
    expect(d1([{ date: "2026-09-14", read: 8, written: 11 }])).toEqual({
      maxRead: { date: "2026-09-14", rows: 8 },
      maxWritten: { date: "2026-09-14", rows: 11 },
      touched: false,
    });
    expect(d1([{ date: "2026-09-10", read: 2_500_000, written: 50_000 }]).touched).toBe(false);
    expect(d1([{ date: "2026-09-10", read: 2_500_001, written: 0 }]).touched).toBe(true);
    expect(d1([{ date: "2026-09-10", read: 0, written: 50_001 }]).touched).toBe(true);
  });
});

describe("昇格トリガーの判定", () => {
  it("記録した応答なら P-1〜P-4 は触れていない。P-5・P-6 は人が決める", () => {
    const verdicts = judgeTriggers([summarizeAccount("1", dataOf(recordedBody()), WEEK)]);
    expect(verdicts.map((v) => [v.id, v.state])).toEqual([
      ["P-1", "clear"],
      ["P-2", "clear"],
      ["P-3", "clear"],
      ["P-4", "clear"],
      ["P-5", "human"],
      ["P-6", "human"],
    ]);
  });

  it("触れたアカウントを理由に書く", () => {
    const touched = summarizeAccount("2", dataOf(gqlBody({ storage: [{ date: "2026-09-14", bytes: 3_000_000_000 }] })), WEEK);
    const quiet = summarizeAccount("1", dataOf(recordedBody()), WEEK);
    const p3 = judgeTriggers([quiet, touched]).find((v) => v.id === "P-3");
    expect(p3).toMatchObject({ state: "touched" });
    expect(p3?.reason).toContain("アカウント②");
    expect(p3?.reason).not.toContain("アカウント①");
  });
});

// ── 5. CLI ────────────────────────────────────────────────────────────────

interface Harness {
  readonly code: number;
  readonly out: readonly string[];
  readonly all: string;
  readonly calls: readonly { readonly token: string; readonly variables: Record<string, unknown> }[];
}

async function runHarness(
  argv: readonly string[],
  options: {
    readonly env?: Record<string, string | undefined>;
    readonly respond?: (accountId: string) => unknown;
    readonly status?: number;
  } = {},
): Promise<Harness> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { token: string; variables: Record<string, unknown> }[] = [];
  const io: CliIo = {
    env: options.env ?? ENV_BOTH,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: async (input, init) => {
      // GraphQL の読み取りしか呼ばない（Worker にも、他の API にも届かない）
      expect(String(input)).toBe("https://api.cloudflare.com/client/v4/graphql");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toBe(REPORT_QUERY);
      const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      calls.push({ token, variables: body.variables });
      if (options.status !== undefined) return new Response("{}", { status: options.status });
      return Response.json(options.respond?.(String(body.variables.accountTag)) ?? gqlBody({}));
    },
    now: () => Date.parse("2026-09-14T15:00:00Z"),
    requestTimeoutMs: 1_000,
  };
  const code = await runCli(argv, io);
  return { code, out, all: [...out, ...err].join("\n"), calls };
}

/** 出力のどこにも ID・トークン・MUSUNEST 以外の Worker 名が無い。 */
function expectNothingSecret(run: Harness): void {
  for (const secret of [ACCOUNT_ID, PROD_ACCOUNT_ID, TOKEN, PROD_TOKEN, NAMESPACE_ID, OTHER_SCRIPT, "https://"]) {
    expect(run.all).not.toContain(secret);
  }
}

describe("CLI", () => {
  it("既定では①と②を1回ずつ、それぞれのトークンと Account ID で、今日までの 7 日を読み、触れていなければ exit 0", async () => {
    const run = await runHarness([], {
      respond: (accountId) =>
        accountId === ACCOUNT_ID
          ? recordedBody()
          : gqlBody({ invocations: [...daily([0, 0, 0, 0, 3, 5, 8]), { name: OTHER_SCRIPT, requests: 1 }] }),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toEqual([
      { token: TOKEN, variables: { accountTag: ACCOUNT_ID, since: "2026-09-08", until: "2026-09-14" } },
      { token: PROD_TOKEN, variables: { accountTag: PROD_ACCOUNT_ID, since: "2026-09-08", until: "2026-09-14" } },
    ]);
    expect(run.out.at(-1)).toMatch(/^free-tier-report: OK/);
    expect(run.all).toContain("══ アカウント①（dev + staging）");
    expect(run.all).toContain("══ アカウント②（production）");
    expect(run.all).toContain("最大 217 req/日（2026-09-14。MUSUNEST 217・名前なし 0・その他 0）");
    expect(run.all).toContain("チェーン合計の上界（期間中の max の和） 9.52 ms（余裕 0.48 ms）");
    expect(run.all).toContain(`合算で判定されるなら余裕が ${CHAIN_MARGIN_FLOOR_MS} ms 未満`);
    expect(run.all).toContain("最大 0.02 MB（24,576 bytes・2026-09-14）");
    expect(run.all).toContain("その他の Worker 1 本（名前は出さない）");
    expect(run.all).toContain("課金額: API では読めない");
    expect(run.all).toContain("free-tier-report: 注意 staging の CPU 時間: チェーン合計の上界 9.52 ms（余裕 0.48 ms）");
    expectNothingSecret(run);
  });

  it("--account 1 なら①だけを読み、②の資格情報は要らない", async () => {
    const run = await runHarness(["--account", "1", "--since", "2026-09-12", "--until", "2026-09-14"], {
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      respond: () => recordedBody(),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.variables).toEqual({ accountTag: ACCOUNT_ID, since: "2026-09-12", until: "2026-09-14" });
    expect(run.all).not.toContain("アカウント②");
    expect(run.all).toContain("期間が 7 日より短い");
  });

  it("作ったばかりの Worker の名前が __unknown__ なら、CPU 時間に入れずに読み直すよう注記する", async () => {
    const run = await runHarness(["--account", "2"], {
      respond: () => gqlBody({ invocations: [{ name: UNKNOWN_SCRIPT, requests: 30, cpuMaxUs: 4_000 }] }),
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.all).toContain("最大 30 req/日（2026-09-14。MUSUNEST 0・名前なし 30・その他 0）  その他の Worker 0 本");
    expect(run.all).toContain(`名前が ${UNKNOWN_SCRIPT} の起動が 30 回あり、どの Worker か決められないので CPU 時間に入れていない`);
    expect(run.all).toContain("production: 期間中の起動なし");
  });

  it("P-1〜P-4 のどれかに触れたら exit 2（議論せず即上げる）", async () => {
    const run = await runHarness(["--account", "2"], {
      respond: () => gqlBody({ invocations: [{ name: musunestScript("production", "host"), status: "exceededResources", requests: 1 }] }),
    });
    expect(run.code).toBe(EXIT_TOUCHED);
    expect(run.all).toContain("P-1: 触れた — MUSUNEST の Worker に上限超過");
    expect(run.out.at(-1)).toContain("P-1 に触れた。議論せず即上げる");
  });

  it("API が 403 なら、トークンを作らずに止める（exit 1）", async () => {
    const run = await runHarness(["--account", "2"], { status: 403 });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("アカウント②（production） の Analytics（GraphQL）を読む権限が足りない。トークンを作らずに止める");
    expectNothingSecret(run);
  });

  it("資格情報が足りない・期間が不正なら、API を呼ばずに exit 1", async () => {
    const missing = await runHarness([], { env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID } });
    expect(missing.code).toBe(EXIT_NG);
    expect(missing.calls).toHaveLength(0);
    expect(missing.all).toContain("CLOUDFLARE_API_TOKEN_PROD と CLOUDFLARE_ACCOUNT_ID_PROD が要る");
    const wide = await runHarness(["--since", "2026-08-01"]);
    expect(wide.code).toBe(EXIT_NG);
    expect(wide.calls).toHaveLength(0);
    const account = await runHarness(["--account", "3"]);
    expect(account.code).toBe(EXIT_NG);
    expect(account.calls).toHaveLength(0);
  });

  it("引数の誤りは値を出さずに exit 1", async () => {
    const run = await runHarness([ACCOUNT_ID]);
    expect(run.code).toBe(EXIT_NG);
    expectNothingSecret(run);
  });
});
