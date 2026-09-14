// pnpm smoke の受入試験（Issue #10）。**実環境には一切届かない**（宛先はローカルの HTTP サーバと workerd だけ）。
//
//   1. 契約：checks のキーの並びとパスが host の Worker の contract と一致し、package.json の smoke がこのファイルを指す
//   2. 判定（judge）：各層の失敗を観測の形で与え、どの層で切れたかを1行で言い分ける
//   3. 各層の失敗を再現するローカルの HTTP サーバに CLI を向ける（届かない・タイムアウト・想定外のステータス・HTML・checks の ng）
//   4. 1回だけ・上限つき：ok なら1リクエストで終わる。再試行は伝播待ちで直り得る失敗だけで、回数と総時間の上限で止まる。
//      既定の上限は、初回デプロイで workers.dev の経路ができるまでの 404 を待ちきる幅にしてある（Issue #16）
//   5. 宛先の URL を出さない：出力とエラーのどこにも、宛先のホスト名・ポート・URL として渡した値が混ざらない
//   6. X-Musubi-Probe（Issue #55）：SMOKE_PROBE_TOKEN をヘッダにだけ載せ、出力のどこにも出さない。
//      --env production では必須で、無ければ判定を始めずに exit 1
//   7. host・gateway・data-api を workerd 上で並べた実機（host の受入試験と同じ形）に CLI を向ける。
//      production の設定（詳細を隠す host）でも、SMOKE_PROBE_TOKEN を載せて詳細を取れる
//
// 7 の host は wrangler.jsonc（env.dev / env.production）を解決した設定のまま、Worker の入口（main）をそのまま動かす。
// vite build はしない：ここで確かめたいのは応答の形と経路で、SPA シェルの中身ではない（ビルドの出力は host の受入試験が見る）。
// だから Static Assets にはダミーの index.html を置き、run_worker_first は host の設定の値を使う。
//
// data-api は @musubi/app-do の dist を読む。`pnpm test` は turbo run test（^build を先に済ませる）の後にここを走らせる。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig, type TestHarness, type TestHarnessOptions } from "wrangler";
import {
  HEALTHZ_PATH as HOST_HEALTHZ_PATH,
  HOST_HEALTHZ_CHECKS as HOST_CONTRACT_CHECKS,
  PROBE_HEADER as HOST_PROBE_HEADER,
  PROBE_TOKEN_SECRET,
  WORKER_ROUTES,
} from "../../apps/host/src/worker/contract.ts";
import {
  EXIT_NG,
  EXIT_OK,
  formatLayers,
  HEALTHZ_PATH,
  HOST_HEALTHZ_CHECKS,
  judge,
  PROBE_HEADER,
  PROBE_REQUIRED_ENVS,
  PROBE_TOKEN_ENV,
  RETRY_POLICY,
  runCli,
  type Check,
  type CliIo,
  type Expectation,
  type HostHealthz,
  type Observation,
  type RetryPolicy,
  type Verdict,
} from "./smoke.ts";
import { ENVS, type Env } from "./sync-bindings.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 試験用の再試行の方針。待ちを短くしただけで、形は RETRY_POLICY と同じ。 */
const FAST: RetryPolicy = { maxAttempts: 3, retryIntervalMs: 10, requestTimeoutMs: 2_000, deadlineMs: 10_000 };

/** 数字が2つ以上続かない SHA。ポート番号（宛先）が出力に混ざっていないかを数字の並びで判定するので、偶然一致させない */
const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

const HEALTHY: HostHealthz = {
  service: "host",
  env: "dev",
  version: SHA,
  checks: { gateway: "ok", data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
  elapsed_ms: 12.5,
};

const DEV: Expectation = { env: "dev", sha: undefined };

/** 試験用の X-Musubi-Probe の値。出力に混ざっていないかを文字列で探すので、他に現れない並びにしてある */
const PROBE_TOKEN = "smoke-probe-token-7c1e9a";

/** SPA シェルの代わり。host の受入試験が見る本物と同じく、HTML 文書として始まる。 */
const SHELL = '<!DOCTYPE html><html lang="ja"><head><title>Musubi</title></head><body><div id="root"></div></body></html>';

const response = (status: number, body: unknown, contentType = "application/json"): Observation => ({
  kind: "response",
  status,
  contentType,
  text: typeof body === "string" ? body : JSON.stringify(body),
});

/** NG の判定の理由。ok と判定されていたら落とす。 */
function reasonOf(verdict: Verdict): string {
  if (verdict.ok) throw new Error("ok と判定された");
  return verdict.reason;
}

const withChecks = (checks: Partial<HostHealthz["checks"]>): HostHealthz => ({
  ...HEALTHY,
  checks: { ...HEALTHY.checks, ...checks },
});

/** 手前の層が ng のとき、host・gateway がその先に載せる固定文（apps/host・apps/gateway の SKIPPED）。 */
const skippedAfter = (layer: "gateway" | "data_api", checks: readonly Check[]): Partial<HostHealthz["checks"]> =>
  Object.fromEntries(checks.map((check) => [check, `ng: skipped (${layer} ng)`]));

/** gateway で切れた応答（別の環境の gateway に結んだ） */
const GATEWAY_NG = withChecks({ gateway: "ng: env mismatch", ...skippedAfter("gateway", ["data_api", "d1", "r2", "do"]) });
/** data_api で切れた応答（data-api が 500 を返した） */
const DATA_API_NG = withChecks({ data_api: "ng: HTTP 500", ...skippedAfter("data_api", ["d1", "r2", "do"]) });

/** SPA シェルの HTML が返ったときの最後の1行 */
const HTML_VERDICT =
  "smoke: NG [host] 応答が JSON でない: HTML が返った" +
  "（SPA シェルなら /healthz が Worker に届いていない。assets.run_worker_first を確かめる）";

// ── CLI を動かす道具 ───────────────────────────────────────────────────────

interface Run {
  code: number;
  out: string[];
  err: string[];
  /** out と err を全部つないだもの。宛先が混ざっていないかをこれで見る */
  all: string;
  /** fetch を呼んだ回数 */
  requests: number;
}

async function smoke(argv: readonly string[], io: Partial<CliIo> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  let requests = 0;
  const fetchImpl = io.fetch ?? fetch;
  const code = await runCli(argv, {
    env: {},
    now: () => performance.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    policy: FAST,
    ...io,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: (input, init) => {
      requests++;
      return fetchImpl(input, init);
    },
  });
  return { code, out, err, all: [...out, ...err].join("\n"), requests };
}

/** 最後の1行（どの層で切れたか）。 */
const verdictLine = (run: Run): string => run.out.at(-1) ?? "";

/** 宛先（オリジン・ホスト名・ポート）が出力のどこにも無い。 */
function expectNoDestination(run: Run, origin: string): void {
  const url = new URL(origin);
  expect(run.all).not.toContain(origin);
  expect(run.all).not.toContain(url.hostname);
  if (url.port !== "") expect(run.all).not.toContain(url.port);
}

interface LocalServer {
  readonly origin: string;
  /** 受けたリクエストの数 */
  readonly count: () => number;
  close(): Promise<void>;
}

/** 各層の失敗を再現するローカルの HTTP サーバ。 */
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<LocalServer> {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    handler(req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    count: () => count,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

const json = (status: number, body: unknown) => (_: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** 待ちの間に時計だけを進める。実時間を使わずに総時間の上限を確かめる。 */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// ── 1. 契約 ───────────────────────────────────────────────────────────────

describe("host の Worker の contract との一致", () => {
  it("checks のキーの並びが host の HOST_HEALTHZ_CHECKS と一致する", () => {
    expect([...HOST_HEALTHZ_CHECKS]).toEqual([...HOST_CONTRACT_CHECKS]);
  });

  it("叩くパスが host の HEALTHZ_PATH で、Worker が先に受ける run_worker_first に入っている", () => {
    expect(HEALTHZ_PATH).toBe(HOST_HEALTHZ_PATH);
    expect(WORKER_ROUTES).toContain(HEALTHZ_PATH);
  });

  it("X-Musubi-Probe のヘッダ名が host の PROBE_HEADER と一致する", () => {
    expect(PROBE_HEADER).toBe(HOST_PROBE_HEADER);
  });

  it("SMOKE_PROBE_TOKEN を必須にする env が、host と gateway の wrangler.jsonc で詳細を隠す env（HEALTHZ_DETAIL が public でない）と一致する", () => {
    for (const config of [HOST_CONFIG_PATH, GATEWAY_CONFIG_PATH]) {
      const hiding = ENVS.filter((env) => {
        const { vars } = unstable_readConfig({ config, env }, { hideWarnings: true });
        return vars["HEALTHZ_DETAIL"] !== "public";
      });
      expect(hiding).toEqual([...PROBE_REQUIRED_ENVS]);
    }
  });

  it("pnpm smoke がこのスクリプトを tsx で動かす", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["smoke"]).toBe("tsx infra/scripts/smoke.ts");
  });
});

// ── 2. 判定 ───────────────────────────────────────────────────────────────

describe("judge：どの層で切れたか", () => {
  it("200 で全部 ok なら ok", () => {
    expect(judge(response(200, HEALTHY), DEV)).toMatchObject({ ok: true, status: 200 });
  });

  it("届かなければ host（伝播待ちで直り得るので再試行する）", () => {
    expect(judge({ kind: "unreachable", reason: "届かない（ECONNREFUSED）" }, DEV)).toEqual({
      ok: false,
      layers: ["host"],
      reason: "届かない（ECONNREFUSED）",
      retryable: true,
    });
  });

  it.each([404, 500, 522, 302])("HTTP %i は想定外のステータスとして host で切れる（再試行する）", (status) => {
    const verdict = judge(response(status, "x", "text/plain"), DEV);
    expect(verdict).toMatchObject({ ok: false, layers: ["host"], retryable: true });
    expect(reasonOf(verdict)).toContain(`想定外の HTTP ステータス ${status}`);
  });

  it("SPA シェルの HTML が返れば、JSON でないとして host で切れ、run_worker_first を指す（再試行しない）", () => {
    for (const contentType of ["text/html; charset=utf-8", "application/octet-stream"]) {
      const verdict = judge(response(200, SHELL, contentType), DEV);
      expect(verdict).toMatchObject({ ok: false, layers: ["host"], retryable: false });
      expect(reasonOf(verdict)).toContain("応答が JSON でない: HTML が返った");
      expect(reasonOf(verdict)).toContain("assets.run_worker_first");
    }
  });

  it("HTML でもない JSON でない応答は content-type の media type だけを出す", () => {
    const verdict = judge(response(503, "Service Unavailable", "text/plain; charset=utf-8"), DEV);
    expect(verdict).toMatchObject({ ok: false, layers: ["host"], retryable: false });
    expect(reasonOf(verdict)).toBe("応答が JSON でない（content-type: text/plain）");
  });

  it.each([
    ["JSON オブジェクトでない", [HEALTHY], "JSON オブジェクトではない"],
    ["gateway の応答（宛先の取り違え）", { ...HEALTHY, service: "gateway" }, 'service が "gateway"（host ではない Worker に届いた'],
    ["checks のキーが足りない", { ...HEALTHY, checks: { gateway: "ok", data_api: "ok", d1: "ok", r2: "ok" } }, "checks に do が無い"],
    ["checks に契約に無いキー", withChecks({ kv: "ok" } as Partial<HostHealthz["checks"]>), 'checks に契約に無いキーがある（"kv"）'],
    ["checks の値が ok でも ng: でもない", withChecks({ r2: "fine" }), 'checks の r2 が "ok" でも "ng: …" でもない'],
    ["version が無い", { ...HEALTHY, version: undefined }, "version が文字列ではない"],
  ])("host の healthz の形でなければ host で切れる（%s・再試行しない）", (_, body, reason) => {
    const verdict = judge(response(200, body), DEV);
    expect(verdict).toMatchObject({ ok: false, layers: ["host"], retryable: false });
    expect(reasonOf(verdict)).toContain(`host の healthz の形でない: ${reason}`);
  });

  it.each([
    [200, { ok: true }],
    [503, { ok: false }],
  ] as const)("詳細が隠された応答（HTTP %i）は host で切れる（再試行しない）", (status, body) => {
    const shown = JSON.stringify(body);
    const withProbe = judge(response(status, body), { ...DEV, probe: true });
    expect(withProbe).toMatchObject({ ok: false, layers: ["host"], retryable: false });
    expect(reasonOf(withProbe)).toBe(
      `詳細が隠された応答（${shown} だけ）: X-Musubi-Probe が受け付けられなかった` +
        "（SMOKE_PROBE_TOKEN と host の secret MUSUBI_PROBE_TOKEN が一致しているかを確かめる）",
    );

    const withoutProbe = judge(response(status, body), DEV);
    expect(withoutProbe).toMatchObject({ ok: false, layers: ["host"], retryable: false });
    expect(reasonOf(withoutProbe)).toBe(
      `詳細が隠された応答（${shown} だけ）: この host は X-Musubi-Probe が無いと詳細を返さない` +
        "（SMOKE_PROBE_TOKEN を渡すか、host の vars.HEALTHZ_DETAIL を確かめる）",
    );
  });

  it("ok 以外のキーも持つ応答は隠された応答ではなく、host の healthz の形として読む", () => {
    const verdict = judge(response(200, { ok: true, service: "host" }), DEV);
    expect(reasonOf(verdict)).toContain("host の healthz の形でない");
  });

  it("HTTP ステータスと checks が食い違えば host で切れる", () => {
    for (const [status, body] of [
      [200, withChecks({ d1: "ng: D1_ERROR" })],
      [503, HEALTHY],
    ] as const) {
      const verdict = judge(response(status, body), DEV);
      expect(verdict).toMatchObject({ ok: false, layers: ["host"], retryable: false });
      expect(reasonOf(verdict)).toContain(`HTTP ${status} と checks が食い違う`);
    }
  });

  it("env が --env と一致しなければ host で切れる（checks が ok でも。再試行しない）", () => {
    const verdict = judge(response(200, { ...HEALTHY, env: "staging" }), DEV);
    expect(verdict).toMatchObject({ ok: false, layers: ["host"], retryable: false });
    expect(reasonOf(verdict)).toContain('env が一致しない（期待 dev、応答 "staging"');
  });

  it("version が --expect-sha と一致しなければ host で切れる（デプロイの反映待ちなので再試行する）", () => {
    const verdict = judge(response(200, HEALTHY), { env: "dev", sha: "fedcba9" });
    expect(verdict).toMatchObject({ ok: false, layers: ["host"], retryable: true });
    expect(reasonOf(verdict)).toContain(`version が --expect-sha と一致しない（期待 fedcba9、応答 "${SHA}"`);
  });

  it("--expect-sha は先頭の一致で照合し、大文字小文字を区別しない", () => {
    for (const sha of [SHA, SHA.slice(0, 7), SHA.slice(0, 12).toUpperCase()]) {
      expect(judge(response(200, HEALTHY), { env: "dev", sha }).ok).toBe(true);
    }
    expect(judge(response(200, { ...HEALTHY, version: "local" }), { env: "dev", sha: SHA.slice(0, 7) }).ok).toBe(false);
  });

  it.each([
    [
      "gateway",
      GATEWAY_NG,
      ["gateway"],
      '"ng: env mismatch"（host までは届いた）',
    ],
    [
      "data_api",
      DATA_API_NG,
      ["data_api"],
      '"ng: HTTP 500"（host → gateway までは届いた）',
    ],
    ["d1", withChecks({ d1: "ng: D1_ERROR" }), ["d1"], '"ng: D1_ERROR"（host → gateway → data_api までは届いた）'],
    [
      "d1 と do（兄弟は全部並べる）",
      withChecks({ d1: "ng: D1_ERROR", do: "ng: AppInstanceDO healthz not ok" }),
      ["d1", "do"],
      'd1="ng: D1_ERROR", do="ng: AppInstanceDO healthz not ok"（host → gateway → data_api までは届いた）',
    ],
    // 手前が ng なら、その先の値が ok でも確かめられていない
    ["gateway（その先が ok でも）", withChecks({ gateway: "ng: TypeError" }), ["gateway"], '"ng: TypeError"（host までは届いた）'],
  ])("checks の最初に ok でない層で切れる：%s（再試行する）", (_, body, layers, reason) => {
    expect(judge(response(503, body), DEV)).toEqual({ ok: false, layers, reason, retryable: true, body, status: 503 });
  });

  it("層ごとの表は、切れた層より先を値ではなく「未確認」と出す", () => {
    expect(formatLayers(503, DATA_API_NG)).toEqual([
      "  OK  host      HTTP 503",
      "  OK  gateway",
      '  NG  data_api  "ng: HTTP 500"',
      "  --  d1        未確認",
      "  --  r2        未確認",
      "  --  do        未確認",
    ]);
  });
});

// ── 3〜5. CLI とローカルの HTTP サーバ ───────────────────────────────────────

describe("CLI：各層の失敗を再現するローカルの HTTP サーバ", () => {
  it("全部 ok なら exit 0。1リクエストで終わり、層ごとの表と OK の1行を出す", async () => {
    const server = await listen(json(200, HEALTHY));
    try {
      const run = await smoke(["--env", "dev", "--expect-sha", SHA.slice(0, 7)], { env: { SMOKE_BASE_URL: server.origin } });
      expect(run.code).toBe(EXIT_OK);
      expect(server.count()).toBe(1);
      expect(run.out).toEqual([
        `smoke: GET /healthz（env=dev, expect-sha=${SHA.slice(0, 7)}）`,
        "  OK  host      HTTP 200",
        "  OK  gateway",
        "  OK  data_api",
        "  OK  d1",
        "  OK  r2",
        "  OK  do",
        `smoke: OK  host → gateway → data_api → d1 / r2 / do（env=dev, version="${SHA}", elapsed_ms=12.5）`,
      ]);
      expect(run.err).toEqual([]);
      expectNoDestination(run, server.origin);
    } finally {
      await server.close();
    }
  });

  it("host に届かない（接続が拒否される）：host で切れ、試行の上限で打ち切る", async () => {
    const server = await listen(json(200, HEALTHY));
    await server.close();
    const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.requests).toBe(FAST.maxAttempts);
    expect(run.out).toContain("smoke: 試行 1/3 NG [host] 届かない（ECONNREFUSED） … 0.01 秒後に再試行");
    expect(run.out.slice(-2)).toEqual(["smoke: 試行 3/3 回で打ち切った", "smoke: NG [host] 届かない（ECONNREFUSED）"]);
    expectNoDestination(run, server.origin);
  });

  it("host が応答しない：1回の GET をタイムアウトで打ち切り、host で切れる", async () => {
    const server = await listen(() => {
      // 応答しない
    });
    try {
      const startedAt = performance.now();
      const run = await smoke(["--env", "dev"], {
        env: { SMOKE_BASE_URL: server.origin },
        policy: { ...FAST, maxAttempts: 2, requestTimeoutMs: 200 },
      });
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(run.code).toBe(EXIT_NG);
      expect(server.count()).toBe(2);
      expect(verdictLine(run)).toBe("smoke: NG [host] 届かない: タイムアウト（0.2 秒）");
      expectNoDestination(run, server.origin);
    } finally {
      await server.close();
    }
  });

  it("想定外の HTTP ステータス（404）：host で切れる", async () => {
    const server = await listen((_, res) => {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<h1>There is nothing here yet</h1>");
    });
    try {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin } });
      expect(run.code).toBe(EXIT_NG);
      expect(verdictLine(run)).toBe("smoke: NG [host] 想定外の HTTP ステータス 404（healthz は 200 か 503）");
      expectNoDestination(run, server.origin);
    } finally {
      await server.close();
    }
  });

  it("リダイレクトは辿らない：3xx は host で切れ、転送先には1回も届かない", async () => {
    const target = await listen(json(200, HEALTHY));
    const server = await listen((_, res) => {
      res.writeHead(302, { location: `${target.origin}/healthz` });
      res.end();
    });
    try {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin } });
      expect(run.code).toBe(EXIT_NG);
      expect(target.count()).toBe(0);
      expect(verdictLine(run)).toBe("smoke: NG [host] 想定外の HTTP ステータス 302（healthz は 200 か 503。リダイレクトは辿らない）");
      expectNoDestination(run, server.origin);
      expectNoDestination(run, target.origin);
    } finally {
      await server.close();
      await target.close();
    }
  });

  it("SPA シェルの HTML が返る：host で切れ、待っても直らないので1回で落とす", async () => {
    const server = await listen((_, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SHELL);
    });
    try {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin } });
      expect(run.code).toBe(EXIT_NG);
      expect(server.count()).toBe(1);
      expect(run.out).toHaveLength(2);
      expect(verdictLine(run)).toBe(HTML_VERDICT);
    } finally {
      await server.close();
    }
  });

  it("data_api で切れた：層ごとの表でその先を未確認と出し、最後の1行で data_api を名指す", async () => {
    const server = await listen(json(503, DATA_API_NG));
    try {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin }, policy: { ...FAST, maxAttempts: 1 } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.out.slice(1)).toEqual([
        "  OK  host      HTTP 503",
        "  OK  gateway",
        '  NG  data_api  "ng: HTTP 500"',
        "  --  d1        未確認",
        "  --  r2        未確認",
        "  --  do        未確認",
        "smoke: 試行 1/1 回で打ち切った",
        'smoke: NG [data_api] "ng: HTTP 500"（host → gateway までは届いた）',
      ]);
    } finally {
      await server.close();
    }
  });
});

describe("1回だけ・上限つき（定期ポーリングしない）", () => {
  it("伝播待ち（古い version）の後に ok になれば exit 0。ok になった後は叩かない", async () => {
    let served = 0;
    const server = await listen((req, res) => {
      served++;
      json(200, served === 1 ? { ...HEALTHY, version: "f9e8d7c6b5a4" } : HEALTHY)(req, res);
    });
    try {
      const run = await smoke(["--env", "dev", "--expect-sha", SHA], { env: { SMOKE_BASE_URL: server.origin } });
      expect(run.code).toBe(EXIT_OK);
      expect(run.out[1]).toBe(
        `smoke: 試行 1/3 NG [host] version が --expect-sha と一致しない（期待 ${SHA}、応答 "f9e8d7c6b5a4"。` +
          "デプロイが反映されていない） … 0.01 秒後に再試行",
      );
      await new Promise((done) => setTimeout(done, 100));
      expect(server.count()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("待っても直らない失敗（env の不一致）は再試行しない", async () => {
    const server = await listen(json(200, { ...HEALTHY, env: "staging" }));
    try {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin } });
      expect(run.code).toBe(EXIT_NG);
      expect(server.count()).toBe(1);
      expect(verdictLine(run)).toContain("smoke: NG [host] env が一致しない");
    } finally {
      await server.close();
    }
  });

  it("再試行の途中で直らない失敗に変われば、そこで止める", async () => {
    let served = 0;
    const server = await listen((req, res) => {
      served++;
      json(200, served === 1 ? { ...HEALTHY, version: "local" } : { ...HEALTHY, env: "staging" })(req, res);
    });
    try {
      const run = await smoke(["--env", "dev", "--expect-sha", SHA], { env: { SMOKE_BASE_URL: server.origin } });
      expect(run.code).toBe(EXIT_NG);
      expect(server.count()).toBe(2);
      expect(run.out.slice(-2)).toEqual([
        "smoke: 待っても直らない失敗なので、再試行を止めた",
        expect.stringContaining("smoke: NG [host] env が一致しない"),
      ]);
    } finally {
      await server.close();
    }
  });

  it("既定の RETRY_POLICY：ずっと失敗しても、試行は上限の回数以下で、総時間の上限を超えて待たない", async () => {
    // 1回の GET がタイムアウトいっぱいまで掛かる最悪の場合を、時計だけを進めて再現する
    const clock = fakeClock();
    const run = await smoke(["--env", "dev"], {
      env: { SMOKE_BASE_URL: "https://smoke.invalid" },
      policy: RETRY_POLICY,
      now: clock.now,
      sleep: clock.sleep,
      fetch: async () => {
        clock.advance(RETRY_POLICY.requestTimeoutMs);
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.requests).toBeGreaterThan(1);
    expect(run.requests).toBeLessThanOrEqual(RETRY_POLICY.maxAttempts);
    expect(clock.now()).toBeLessThanOrEqual(RETRY_POLICY.deadlineMs);
    expect(run.out.at(-2)).toBe(
      `smoke: 総時間の上限（${RETRY_POLICY.deadlineMs / 1000} 秒）に達するので打ち切った（試行 ${run.requests} 回）`,
    );
  });

  it("既定の RETRY_POLICY：初回デプロイの経路ができるまでの 404 が、staging の実測（約22秒）の5倍続いても待ちきる", async () => {
    // staging の初回デプロイ（2026-09-14）では、host を配った直後に 4回続けて 404 になり、5回目・約22秒後に成功した。
    // production も初回デプロイなので、その5倍の間 404 が続く場合を、時計だけを進めて再現する（1回の GET に 1 秒掛かる）
    const routeReadyAt = 5 * 22_000;
    const clock = fakeClock();
    const run = await smoke(["--env", "dev", "--expect-sha", SHA], {
      env: { SMOKE_BASE_URL: "https://smoke.invalid" },
      policy: RETRY_POLICY,
      now: clock.now,
      sleep: clock.sleep,
      fetch: async () => {
        clock.advance(1_000);
        return clock.now() <= routeReadyAt
          ? new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
          : Response.json(HEALTHY);
      },
    });
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(run.out.filter((line) => line.includes("想定外の HTTP ステータス 404"))).toHaveLength(run.requests - 1);
    expect(clock.now()).toBeGreaterThan(routeReadyAt);
  });

  it("RETRY_POLICY は「デプロイ後に1回」の範囲に収まる（最大 12 リクエスト・150 秒。定期ポーリングにしない）", () => {
    expect(RETRY_POLICY.maxAttempts).toBeLessThanOrEqual(12);
    expect(RETRY_POLICY.deadlineMs).toBeLessThanOrEqual(150_000);
    expect(RETRY_POLICY.requestTimeoutMs).toBeLessThan(RETRY_POLICY.deadlineMs);
    // 待てる幅（試行の間の待ちの合計）が、総時間の上限の中に収まる
    expect((RETRY_POLICY.maxAttempts - 1) * RETRY_POLICY.retryIntervalMs).toBeLessThan(RETRY_POLICY.deadlineMs);
  });
});

describe("宛先の URL を出さない", () => {
  // 目印。出力やエラー文言に1つでも混ざったら「宛先を出した」と判定する
  const MARKER = "musubi-smoke-marker-4e7b1d";
  const SECRET_ORIGIN = `https://${MARKER}.example.workers.dev`;

  it("fetch の例外文言（ホスト名を含む）を捨て、コードだけを出す", async () => {
    const run = await smoke(["--env", "dev"], {
      env: { SMOKE_BASE_URL: SECRET_ORIGIN },
      policy: { ...FAST, maxAttempts: 1 },
      fetch: async () => {
        const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${MARKER}.example.workers.dev`), {
          code: "ENOTFOUND",
          hostname: `${MARKER}.example.workers.dev`,
        });
        throw new TypeError("fetch failed", { cause });
      },
    });
    expect(run.code).toBe(EXIT_NG);
    expect(verdictLine(run)).toBe("smoke: NG [host] 届かない（ENOTFOUND）");
    expect(run.all).not.toContain(MARKER);
  });

  it("コードの無い例外は種別だけを出す", async () => {
    const run = await smoke(["--env", "dev"], {
      env: { SMOKE_BASE_URL: SECRET_ORIGIN },
      policy: { ...FAST, maxAttempts: 1 },
      fetch: async () => {
        throw new Error(`cannot reach ${SECRET_ORIGIN}`);
      },
    });
    expect(verdictLine(run)).toBe("smoke: NG [host] 届かない（Error）");
    expect(run.all).not.toContain(MARKER);
  });

  const DEV_ARGS = ["--env", "dev"];
  const TO_SECRET = { SMOKE_BASE_URL: SECRET_ORIGIN };

  it.each([
    ["URL として読めない", { SMOKE_BASE_URL: `${MARKER} not a url` }, DEV_ARGS, "SMOKE_BASE_URL が URL として読めない"],
    ["http(s) でない", { SMOKE_BASE_URL: `ftp://${MARKER}.example` }, DEV_ARGS, "SMOKE_BASE_URL は http(s) の URL を書く"],
    ["パスを含む", { SMOKE_BASE_URL: `${SECRET_ORIGIN}/healthz` }, DEV_ARGS, "SMOKE_BASE_URL はオリジンだけを書く"],
    ["資格情報を含む", { SMOKE_BASE_URL: `https://u:${MARKER}@example.dev` }, DEV_ARGS, "SMOKE_BASE_URL はオリジンだけを書く"],
    ["クエリを含む", {}, [...DEV_ARGS, "--base-url", `${SECRET_ORIGIN}?t=${MARKER}`], "--base-url はオリジンだけを書く"],
    ["宛先を位置引数で渡した", {}, [...DEV_ARGS, SECRET_ORIGIN], "引数が不正: 位置引数は取らない"],
    ["知らないオプションに値を付けた", {}, [...DEV_ARGS, `--base_url=${SECRET_ORIGIN}`], "引数が不正: 知らないオプションがある"],
    ["--env に宛先を渡した", TO_SECRET, ["--env", SECRET_ORIGIN], "未知の env"],
    ["--expect-sha が SHA でない", TO_SECRET, [...DEV_ARGS, "--expect-sha", MARKER], "--expect-sha は 7〜40 桁の 16 進"],
  ])("引数と SMOKE_BASE_URL の誤り（%s）は値を表示せず exit 1。1回も叩かない", async (_, env, argv, message) => {
    const run = await smoke(argv, { env });
    expect(run.code).toBe(EXIT_NG);
    expect(run.requests).toBe(0);
    expect(run.err[0]).toContain(`smoke: ${message}`);
    expect(run.all).not.toContain(MARKER);
  });

  it("宛先が無ければ SMOKE_BASE_URL を渡すよう促す", async () => {
    const run = await smoke(["--env", "dev"]);
    expect(run.code).toBe(EXIT_NG);
    expect(run.err[0]).toContain("smoke: 宛先が無い: 環境変数 SMOKE_BASE_URL");
  });

  it("--env が無ければ exit 1", async () => {
    const run = await smoke([], { env: { SMOKE_BASE_URL: SECRET_ORIGIN } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.err[0]).toContain("smoke: --env が無い");
  });

  it("--base-url は SMOKE_BASE_URL より優先する", async () => {
    const server = await listen(json(200, HEALTHY));
    try {
      const run = await smoke(["--env", "dev", "--base-url", `${server.origin}/`], { env: { SMOKE_BASE_URL: `${MARKER} not a url` } });
      expect(run.code).toBe(EXIT_OK);
      expect(server.count()).toBe(1);
      expectNoDestination(run, server.origin);
    } finally {
      await server.close();
    }
  });

  it("応答から持ち出す値は JSON 文字列として出し、改行で行頭を偽装させない", async () => {
    const server = await listen(json(200, { ...HEALTHY, env: "dev\n::error::injected" }));
    try {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin } });
      expect(run.code).toBe(EXIT_NG);
      expect(verdictLine(run)).toContain('応答 "dev\\n::error::injected"');
      expect(run.all.split("\n").some((line) => line.startsWith("::"))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("--help は使い方を出して exit 0。1回も叩かない", async () => {
    const run = await smoke(["--help"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.requests).toBe(0);
    expect(run.out[0]).toMatch(/^usage: pnpm smoke --env <dev\|staging\|production>/);
  });
});

// ── 6. X-Musubi-Probe（SMOKE_PROBE_TOKEN）───────────────────────────────────

describe("X-Musubi-Probe（SMOKE_PROBE_TOKEN）", () => {
  /** 受けたリクエストの X-Musubi-Probe を記録するローカルの HTTP サーバ */
  async function recording(status: number, body: unknown): Promise<LocalServer & { readonly probes: (string | undefined)[] }> {
    const probes: (string | undefined)[] = [];
    const server = await listen((req, res) => {
      const value = req.headers[PROBE_HEADER.toLowerCase()];
      probes.push(Array.isArray(value) ? value.join(",") : value);
      json(status, body)(req, res);
    });
    return Object.assign(server, { probes });
  }

  it("SMOKE_PROBE_TOKEN があれば X-Musubi-Probe にそのまま載せ、付けたことだけを出す（値は出さない）", async () => {
    const server = await recording(200, HEALTHY);
    try {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin, [PROBE_TOKEN_ENV]: PROBE_TOKEN } });
      expect(run.code).toBe(EXIT_OK);
      expect(server.probes).toEqual([PROBE_TOKEN]);
      expect(run.out[0]).toBe("smoke: GET /healthz（env=dev, X-Musubi-Probe 付き）");
      expect(run.all).not.toContain(PROBE_TOKEN);
      expectNoDestination(run, server.origin);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["無い", {}],
    ["空（GitHub Actions は無い Secret を空文字にする）", { [PROBE_TOKEN_ENV]: "" }],
  ])("SMOKE_PROBE_TOKEN が%s dev / staging では、ヘッダを付けずに今のまま叩く", async (_, env) => {
    const server = await recording(200, HEALTHY);
    try {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: server.origin, ...env } });
      expect(run.code).toBe(EXIT_OK);
      expect(server.probes).toEqual([undefined]);
      expect(run.out[0]).toBe("smoke: GET /healthz（env=dev）");
    } finally {
      await server.close();
    }
  });

  it.each([
    ["無い", {}],
    ["空（GitHub Actions は無い Secret を空文字にする）", { [PROBE_TOKEN_ENV]: "" }],
  ])("--env production で SMOKE_PROBE_TOKEN が%sなら、判定を始めずに exit 1。1回も叩かない", async (_, env) => {
    const server = await recording(200, { ok: true });
    try {
      const run = await smoke(["--env", "production", "--expect-sha", SHA], { env: { SMOKE_BASE_URL: server.origin, ...env } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.requests).toBe(0);
      expect(server.count()).toBe(0);
      expect(run.out).toEqual([]);
      expect(run.err[0]).toBe(
        "smoke: --env production では環境変数 SMOKE_PROBE_TOKEN が要る（この host は X-Musubi-Probe が無いと詳細を返さず、" +
          "env も version も確かめられない。CI では production 環境の Secret から渡す）。1回も叩かずに止める",
      );
    } finally {
      await server.close();
    }
  });

  it.each([
    ["改行", `${PROBE_TOKEN}\n`],
    ["空白", `${PROBE_TOKEN} x`],
    ["前後の空白", ` ${PROBE_TOKEN} `],
    ["非 ASCII", `${PROBE_TOKEN}é`],
    ["制御文字", `${PROBE_TOKEN}\u0000`],
  ])("SMOKE_PROBE_TOKEN にヘッダに載らない文字（%s）があれば、値を出さずに exit 1。1回も叩かない", async (_, token) => {
    const run = await smoke(["--env", "production"], { env: { SMOKE_BASE_URL: "https://smoke.invalid", [PROBE_TOKEN_ENV]: token } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.requests).toBe(0);
    expect(run.err[0]).toBe("smoke: SMOKE_PROBE_TOKEN にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）");
    expect(run.all).not.toContain(PROBE_TOKEN);
  });

  it("平文の http の宛先（ループバック以外）には載せない。1回も叩かない", async () => {
    const run = await smoke(["--env", "production"], { env: { SMOKE_BASE_URL: "http://smoke.invalid", [PROBE_TOKEN_ENV]: PROBE_TOKEN } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.requests).toBe(0);
    expect(run.err[0]).toContain("smoke: SMOKE_PROBE_TOKEN を平文の http の宛先に載せない");
    expect(run.all).not.toContain(PROBE_TOKEN);
    expect(run.all).not.toContain("smoke.invalid");
  });

  it("https の宛先には載せる", async () => {
    let sent: string | null = null;
    const run = await smoke(["--env", "production"], {
      env: { SMOKE_BASE_URL: "https://smoke.invalid", [PROBE_TOKEN_ENV]: PROBE_TOKEN },
      fetch: async (_, init) => {
        sent = new Headers(init?.headers).get(PROBE_HEADER);
        return Response.json({ ...HEALTHY, env: "production" });
      },
    });
    expect(run.code).toBe(EXIT_OK);
    expect(sent).toBe(PROBE_TOKEN);
  });

  it.each([
    [200, { ok: true }],
    [503, { ok: false }],
  ] as const)("載せた値が受け付けられず詳細が隠された応答（HTTP %i）が返れば、host で切れ、待っても直らないので1回で落とす", async (status, body) => {
    const server = await recording(status, body);
    try {
      const run = await smoke(["--env", "production"], { env: { SMOKE_BASE_URL: server.origin, [PROBE_TOKEN_ENV]: PROBE_TOKEN } });
      expect(run.code).toBe(EXIT_NG);
      expect(server.count()).toBe(1);
      expect(verdictLine(run)).toBe(
        `smoke: NG [host] 詳細が隠された応答（${JSON.stringify(body)} だけ）: X-Musubi-Probe が受け付けられなかった` +
          "（SMOKE_PROBE_TOKEN と host の secret MUSUBI_PROBE_TOKEN が一致しているかを確かめる）",
      );
      expect(run.all).not.toContain(PROBE_TOKEN);
      expectNoDestination(run, server.origin);
    } finally {
      await server.close();
    }
  });
});

// ── 7. workerd 上の実機 ──────────────────────────────────────────────────

const HOST_CONFIG_PATH = join(ROOT, "apps/host/wrangler.jsonc");
const GATEWAY_CONFIG_PATH = join(ROOT, "apps/gateway/wrangler.jsonc");
const DATA_API_CONFIG_PATH = join(ROOT, "packages/data-api/wrangler.jsonc");
const BOOT_TIMEOUT_MS = 120_000;
/** 実機の version。--expect-sha と照合するので 16 進にしてある */
const GIT_SHA = SHA;

describe("host → gateway → data-api（workerd 上の実機）", () => {
  let dir = "";

  beforeAll(() => {
    if (!existsSync(join(ROOT, "packages/app-do/dist/index.js"))) {
      throw new Error("packages/app-do/dist が無い。pnpm test（turbo が ^build を先に済ませる）から走らせるか、先に pnpm build する");
    }
    dir = mkdtempSync(join(tmpdir(), "smoke-workerd-"));
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public/index.html"), SHELL);
  });

  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  /**
   * host の設定（env を解決したもの。既定は env.dev）を一時ディレクトリに書き出す。main は host の Worker の入口そのもの。
   * run_worker_first を与えたときだけ差し替える。
   */
  function hostConfig(label: string, runWorkerFirst?: readonly string[], env: Env = "dev"): string {
    const host = unstable_readConfig({ config: HOST_CONFIG_PATH, env }, { hideWarnings: true });
    const path = join(dir, `host-${label}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        name: host.name,
        main: host.main,
        compatibility_date: host.compatibility_date,
        vars: host.vars,
        services: host.services,
        assets: {
          directory: "./public",
          not_found_handling: host.assets?.not_found_handling,
          run_worker_first: runWorkerFirst ?? host.assets?.run_worker_first,
        },
      }),
    );
    return path;
  }

  /** data-api の代わりに、決まった応答を返す Worker。gateway の DATA_API をこれに差し替える。 */
  function stubWorker(name: string, status: number, body: unknown): TestHarnessOptions["workers"][number] {
    const main = join(dir, `${name}.js`);
    const init = JSON.stringify({ status, headers: { "content-type": "application/json" } });
    writeFileSync(
      main,
      `export default { fetch() { return new Response(${JSON.stringify(JSON.stringify(body))}, ${init}); } };\n`,
    );
    return { config: { name, main, compatibility_date: "2026-09-11" } };
  }

  /** describe ごとに workerd を1つ起動し、その origin を返す。 */
  function useHarness(workers: () => TestHarnessOptions["workers"]): () => string {
    let server: TestHarness | undefined;
    let origin = "";
    beforeAll(async () => {
      server = createTestHarness({ workers: workers() });
      origin = (await server.listen()).url.origin;
    }, BOOT_TIMEOUT_MS);
    afterAll(async () => {
      await server?.close();
    }, BOOT_TIMEOUT_MS);
    return () => origin;
  }

  const gateway = (vars: Record<string, string> = {}, bindingOverrides: Record<string, string> = {}, env: Env = "dev") => ({
    configPath: GATEWAY_CONFIG_PATH,
    env,
    vars: { GIT_SHA, ...vars },
    bindingOverrides,
  });
  const dataApi = (vars: Record<string, string> = {}, env: Env = "dev") => ({
    configPath: DATA_API_CONFIG_PATH,
    env,
    vars: { GIT_SHA, ...vars },
  });

  describe("全部 ok", () => {
    const origin = useHarness(() => [{ configPath: hostConfig("ok"), vars: { GIT_SHA } }, gateway(), dataApi()]);

    it("実機の応答の checks のキーの並びが smoke の並びと一致する", async () => {
      const res = await fetch(new URL(HEALTHZ_PATH, origin()));
      expect(res.status).toBe(200);
      const body = (await res.json()) as HostHealthz;
      expect(Object.keys(body.checks)).toEqual([...HOST_HEALTHZ_CHECKS]);
    });

    it("pnpm smoke --env dev --expect-sha <sha> が1リクエストで exit 0 になり、D1 / R2 / DO まで ok と出す", async () => {
      const run = await smoke(["--env", "dev", "--expect-sha", GIT_SHA], { env: { SMOKE_BASE_URL: origin() } });
      expect(run.code).toBe(EXIT_OK);
      expect(run.requests).toBe(1);
      expect(run.out.slice(1, -1)).toEqual([
        "  OK  host      HTTP 200",
        "  OK  gateway",
        "  OK  data_api",
        "  OK  d1",
        "  OK  r2",
        "  OK  do",
      ]);
      expect(verdictLine(run)).toMatch(
        /^smoke: OK {2}host → gateway → data_api → d1 \/ r2 \/ do（env=dev, version="\w+", elapsed_ms=[\d.]+）$/,
      );
      expect(verdictLine(run)).toContain(`version="${GIT_SHA}"`);
      expectNoDestination(run, origin());
    });

    it("別の環境（--env staging）として叩くと host で切れ、再試行しない", async () => {
      const run = await smoke(["--env", "staging"], { env: { SMOKE_BASE_URL: origin() } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.requests).toBe(1);
      expect(verdictLine(run)).toBe(
        'smoke: NG [host] env が一致しない（期待 staging、応答 "dev"。宛先が別の環境の host を指していないか）',
      );
    });

    it("配っていない SHA（--expect-sha）は host で切れ、試行の上限まで待ってから落ちる", async () => {
      const run = await smoke(["--env", "dev", "--expect-sha", "fedcba9"], { env: { SMOKE_BASE_URL: origin() } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.requests).toBe(FAST.maxAttempts);
      expect(verdictLine(run)).toBe(
        `smoke: NG [host] version が --expect-sha と一致しない（期待 fedcba9、応答 "${GIT_SHA}"。デプロイが反映されていない）`,
      );
    });

    it("tsx でスクリプトを直接動かす（pnpm smoke と同じ入口）と、SMOKE_BASE_URL の宛先に対して exit 0", async () => {
      const { code, stdout, stderr } = await runScript(["--env", "dev"], origin());
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.trimEnd().split("\n").at(-1)).toMatch(/^smoke: OK {2}host → gateway → data_api → d1 \/ r2 \/ do/);
      expect(stdout).not.toContain(new URL(origin()).port);
    }, 60_000);

    it("tsx で直接動かしても、切れたときは exit 1", async () => {
      const { code, stdout } = await runScript(["--env", "staging"], origin());
      expect(code).toBe(1);
      expect(stdout.trimEnd().split("\n").at(-1)).toContain("smoke: NG [host] env が一致しない");
    }, 60_000);
  });

  describe("run_worker_first から /healthz が漏れた", () => {
    const origin = useHarness(() => [
      { configPath: hostConfig("no-healthz", ["/api/*"]), vars: { GIT_SHA } },
      gateway(),
      dataApi(),
    ]);

    it("SPA シェルの HTML が返り、host で切れる（再試行しない）", async () => {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: origin() } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.requests).toBe(1);
      expect(verdictLine(run)).toBe(HTML_VERDICT);
    });
  });

  describe("gateway で切れた（別の環境の gateway に結んだ）", () => {
    // host の受入試験と同じ形：gateway と data-api の ENVIRONMENT だけを staging にする
    const origin = useHarness(() => [
      { configPath: hostConfig("gateway-ng"), vars: { GIT_SHA } },
      gateway({ ENVIRONMENT: "staging" }),
      dataApi({ ENVIRONMENT: "staging" }),
    ]);

    it("最後の1行が gateway を名指し、その先を未確認と出す", async () => {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: origin() }, policy: { ...FAST, maxAttempts: 1 } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.out).toContain("  --  data_api  未確認");
      expect(verdictLine(run)).toBe('smoke: NG [gateway] "ng: env mismatch"（host までは届いた）');
    });
  });

  describe("data_api で切れた（data-api が 500 を返す）", () => {
    const origin = useHarness(() => [
      { configPath: hostConfig("data-api-ng"), vars: { GIT_SHA } },
      gateway({}, { DATA_API: "smoke-stub-data-api-500" }),
      stubWorker("smoke-stub-data-api-500", 500, { error: "boom" }),
    ]);

    it("最後の1行が data_api を名指す", async () => {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: origin() }, policy: { ...FAST, maxAttempts: 1 } });
      expect(run.code).toBe(EXIT_NG);
      expect(verdictLine(run)).toBe('smoke: NG [data_api] "ng: HTTP 500"（host → gateway までは届いた）');
    });
  });

  describe("production（X-Musubi-Probe が無いと詳細を返さない host）", () => {
    // production の設定（HEALTHZ_DETAIL=probe）のまま、secret だけテスト用の値を host と gateway に渡す（Issue #55）
    const secret = { [PROBE_TOKEN_SECRET]: PROBE_TOKEN };
    const origin = useHarness(() => [
      { configPath: hostConfig("production", undefined, "production"), vars: { GIT_SHA, ...secret } },
      gateway(secret, {}, "production"),
      dataApi({}, "production"),
    ]);

    it("前提：ヘッダ無しの応答は {\"ok\":true} だけで、env も version も読めない", async () => {
      const res = await fetch(new URL(HEALTHZ_PATH, origin()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("SMOKE_PROBE_TOKEN を載せた pnpm smoke --env production --expect-sha <sha> が1リクエストで exit 0 になり、D1 / R2 / DO まで ok と出す", async () => {
      const run = await smoke(["--env", "production", "--expect-sha", GIT_SHA], {
        env: { SMOKE_BASE_URL: origin(), [PROBE_TOKEN_ENV]: PROBE_TOKEN },
      });
      expect(run.code).toBe(EXIT_OK);
      expect(run.requests).toBe(1);
      expect(run.out[0]).toBe(`smoke: GET /healthz（env=production, expect-sha=${GIT_SHA}, X-Musubi-Probe 付き）`);
      expect(run.out.slice(1, -1)).toEqual([
        "  OK  host      HTTP 200",
        "  OK  gateway",
        "  OK  data_api",
        "  OK  d1",
        "  OK  r2",
        "  OK  do",
      ]);
      expect(verdictLine(run)).toContain(`（env=production, version="${GIT_SHA}"`);
      expect(run.all).not.toContain(PROBE_TOKEN);
      expectNoDestination(run, origin());
    });

    it("誤った値なら詳細が隠された応答として host で切れ、再試行しない", async () => {
      const run = await smoke(["--env", "production"], { env: { SMOKE_BASE_URL: origin(), [PROBE_TOKEN_ENV]: `${PROBE_TOKEN}0` } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.requests).toBe(1);
      expect(verdictLine(run)).toContain('smoke: NG [host] 詳細が隠された応答（{"ok":true} だけ）: X-Musubi-Probe が受け付けられなかった');
      expect(run.all).not.toContain(PROBE_TOKEN);
    });

    it("SMOKE_PROBE_TOKEN が無ければ、1回も叩かずに exit 1", async () => {
      const run = await smoke(["--env", "production", "--expect-sha", GIT_SHA], { env: { SMOKE_BASE_URL: origin() } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.requests).toBe(0);
      expect(run.err[0]).toContain("smoke: --env production では環境変数 SMOKE_PROBE_TOKEN が要る");
    });

    it("tsx でスクリプトを直接動かす（pnpm smoke と同じ入口）と、SMOKE_PROBE_TOKEN を環境変数から読んで exit 0。値は出さない", async () => {
      const { code, stdout, stderr } = await runScript(["--env", "production", "--expect-sha", GIT_SHA], origin(), {
        [PROBE_TOKEN_ENV]: PROBE_TOKEN,
      });
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.trimEnd().split("\n").at(-1)).toMatch(/^smoke: OK {2}host → gateway → data_api → d1 \/ r2 \/ do（env=production/);
      expect(stdout).not.toContain(PROBE_TOKEN);
    }, 60_000);

    it("tsx で直接動かしても、SMOKE_PROBE_TOKEN が無ければ exit 1", async () => {
      const { code, stdout, stderr } = await runScript(["--env", "production"], origin());
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("smoke: --env production では環境変数 SMOKE_PROBE_TOKEN が要る");
    }, 60_000);
  });

  describe("d1 と do で切れた（data-api が D1 と DO を ng と返す）", () => {
    const origin = useHarness(() => [
      { configPath: hostConfig("storage-ng"), vars: { GIT_SHA } },
      gateway({}, { DATA_API: "smoke-stub-data-api-503" }),
      stubWorker("smoke-stub-data-api-503", 503, {
        service: "data-api",
        env: "dev",
        version: GIT_SHA,
        checks: { d1: "ng: D1_ERROR", r2: "ok", do: "ng: AppInstanceDO healthz not ok" },
        elapsed_ms: 1,
      }),
    ]);

    it("gateway と host を経た checks から、兄弟の d1 と do を並べて名指す", async () => {
      const run = await smoke(["--env", "dev"], { env: { SMOKE_BASE_URL: origin() }, policy: { ...FAST, maxAttempts: 1 } });
      expect(run.code).toBe(EXIT_NG);
      expect(run.out).toContain("  OK  r2");
      expect(verdictLine(run)).toBe(
        'smoke: NG [d1, do] d1="ng: D1_ERROR", do="ng: AppInstanceDO healthz not ok"（host → gateway → data_api までは届いた）',
      );
    });
  });
});

/**
 * `pnpm smoke` と同じく tsx でファイルを動かす。宛先は SMOKE_BASE_URL で、X-Musubi-Probe の値は extraEnv で渡す（CI と同じ）。
 * 手元の環境変数の SMOKE_* は持ち込まない（試験の結果が手元の設定で変わらないように）。
 */
function runScript(
  argv: readonly string[],
  origin: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_OPTIONS|VITEST.*|SMOKE_.*)$/.test(key)));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [tsx, "infra/scripts/smoke.ts", ...argv], {
      cwd: ROOT,
      env: { ...env, ...extraEnv, SMOKE_BASE_URL: origin },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
