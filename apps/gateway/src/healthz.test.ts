// healthz の判定だけを、Cloudflare を使わずに確かめる。
// 実機（workerd の Service Binding 越しの data-api）での疎通は src/index.test.ts が見る。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthzBody } from "@musubi/data-api";
import { GATEWAY_HEALTHZ_CHECKS } from "./contract.js";
import { runHealthz, SKIPPED } from "./healthz.js";
import type { DataApiHealthz } from "./healthz.js";

const META = { env: "staging", version: "0123abc" } as const;

const DATA_API_OK: HealthzBody = {
  service: "data-api",
  env: "staging",
  version: "0123abc",
  checks: { d1: "ok", r2: "ok", do: "ok" },
  elapsed_ms: 3.5,
};

const responds = (body: unknown, status = 200): DataApiHealthz => async () => Response.json(body, { status });
const fails = (error: unknown): DataApiHealthz => () => Promise.reject(error);
const skippedAll = { d1: SKIPPED, r2: SKIPPED, do: SKIPPED };

describe("runHealthz", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("data-api が全部 ok なら 200 で、data_api に d1 / r2 / do を続けた形の JSON を返す", async () => {
    const ticks = [10, 14.256];
    const result = await runHealthz(responds(DATA_API_OK), META, () => ticks.shift() ?? 0);

    expect(result).toEqual({
      status: 200,
      body: {
        service: "gateway",
        env: "staging",
        version: "0123abc",
        checks: { data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
        elapsed_ms: 4.26,
      },
    });
  });

  it("checks のキーは data_api / d1 / r2 / do の順（host が gateway を足して集約する・03 §5）", async () => {
    expect(GATEWAY_HEALTHZ_CHECKS).toEqual(["data_api", "d1", "r2", "do"]);
    const { body } = await runHealthz(responds(DATA_API_OK), META);
    expect(Object.keys(body.checks)).toEqual(["data_api", "d1", "r2", "do"]);
  });

  it("data-api が 503（d1 が ng）なら、data_api は ok のまま d1 だけが ng の 503 になる（どの層で切れたかが読める）", async () => {
    const body = { ...DATA_API_OK, checks: { d1: "ng: TypeError", r2: "ok", do: "ok" } };
    const result = await runHealthz(responds(body, 503), META);

    expect(result.status).toBe(503);
    expect(result.body.checks).toEqual({ data_api: "ok", d1: "ng: TypeError", r2: "ok", do: "ok" });
  });

  it("届かなければ data_api が ng で、d1 / r2 / do は確かめなかったと示す。例外の文言は応答に載せずログにだけ出す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const leaked = new TypeError("service musubi-staging-data-api: internal detail");
    const result = await runHealthz(fails(leaked), META);

    expect(result.status).toBe(503);
    expect(result.body.checks).toEqual({ data_api: "ng: TypeError", ...skippedAll });
    expect(JSON.stringify(result.body)).not.toContain("internal detail");
    expect(error).toHaveBeenCalledWith("[gateway] healthz: data_api unreachable", leaked);
  });

  it("Error 以外が投げられても落ちずに ng にする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await runHealthz(fails("boom"), META);
    expect(status).toBe(503);
    expect(body.checks.data_api).toBe("ng: string");
  });

  it.each([404, 405, 500])("data-api が healthz 以外の HTTP %i を返したら data_api を ng にする（本文は読まない）", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dataApi: DataApiHealthz = async () => Response.json({ error: "internal detail" }, { status });
    const { body } = await runHealthz(dataApi, META);

    expect(body.checks).toEqual({ data_api: `ng: HTTP ${status}`, ...skippedAll });
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });

  it.each([
    ["JSON ではない", async () => new Response("<html>internal detail</html>", { status: 200 })],
    ["service が data-api ではない", responds({ ...DATA_API_OK, service: "gateway" })],
    ["checks が無い", responds({ ...DATA_API_OK, checks: undefined })],
    ["checks のキーが足りない", responds({ ...DATA_API_OK, checks: { d1: "ok", r2: "ok" } })],
    ["check の値が ok / ng: の形ではない", responds({ ...DATA_API_OK, checks: { d1: "ok", r2: "fine", do: "ok" } })],
    ["配列", responds([DATA_API_OK])],
  ] satisfies [string, DataApiHealthz][])("data-api の応答が %s なら data_api を invalid body で ng にする", async (_, dataApi) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await runHealthz(dataApi, META);

    expect(status).toBe(503);
    expect(body.checks).toEqual({ data_api: "ng: invalid body", ...skippedAll });
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });

  it("別の env の data-api に届いたら、data-api が全部 ok でも env mismatch で ng にする", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await runHealthz(responds({ ...DATA_API_OK, env: "production" }), META);

    expect(status).toBe(503);
    expect(body.checks).toEqual({ data_api: "ng: env mismatch", ...skippedAll });
    expect(body.env).toBe("staging");
    expect(error).toHaveBeenCalledWith("[gateway] healthz: data_api env mismatch (gateway=staging, data-api=production)");
  });

  it("data-api の応答のうち、既知の checks 以外（未知のキー・version など）は持ち出さない", async () => {
    const body = { ...DATA_API_OK, version: "data-api-sha", checks: { ...DATA_API_OK.checks, kv: "ng: leaked" } };
    const result = await runHealthz(responds(body), META);

    expect(result.status).toBe(200);
    expect(result.body.checks).toEqual({ data_api: "ok", d1: "ok", r2: "ok", do: "ok" });
    expect(result.body.version).toBe("0123abc");
  });
});
