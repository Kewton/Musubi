// healthz の判定だけを、Cloudflare を使わずに確かめる（apps/gateway/src/healthz.test.ts と同じ形）。
// 実機（workerd の Service Binding 越しの gateway → data-api）での疎通は src/worker/index.test.ts が見る。
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_HEALTHZ_CHECKS } from "./contract.js";
import { runHealthz, SKIPPED } from "./healthz.js";
import type { GatewayHealthz } from "./healthz.js";

const META = { env: "staging", version: "0123abc" } as const;

const GATEWAY_OK = {
  service: "gateway",
  env: "staging",
  version: "0123abc",
  checks: { data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
  elapsed_ms: 7.5,
} as const;

const responds = (body: unknown, status = 200): GatewayHealthz => async () => Response.json(body, { status });
const fails = (error: unknown): GatewayHealthz => () => Promise.reject(error);
const skippedAll = { data_api: SKIPPED, d1: SKIPPED, r2: SKIPPED, do: SKIPPED };

describe("runHealthz", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gateway が全部 ok なら 200 で、gateway に data_api / d1 / r2 / do を続けた形の JSON を返す", async () => {
    const ticks = [10, 18.256];
    const result = await runHealthz(responds(GATEWAY_OK), META, () => ticks.shift() ?? 0);

    expect(result).toEqual({
      status: 200,
      body: {
        service: "host",
        env: "staging",
        version: "0123abc",
        checks: { gateway: "ok", data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
        elapsed_ms: 8.26,
      },
    });
  });

  it("checks のキーは gateway / data_api / d1 / r2 / do の順（03 §5 の最終応答）", async () => {
    expect(HOST_HEALTHZ_CHECKS).toEqual(["gateway", "data_api", "d1", "r2", "do"]);
    const { body } = await runHealthz(responds(GATEWAY_OK), META);
    expect(Object.keys(body.checks)).toEqual(["gateway", "data_api", "d1", "r2", "do"]);
  });

  it("gateway が 503（d1 が ng）なら、gateway は ok のまま d1 だけが ng の 503 になる（どの層で切れたかが読める）", async () => {
    const body = { ...GATEWAY_OK, checks: { ...GATEWAY_OK.checks, d1: "ng: TypeError" } };
    const result = await runHealthz(responds(body, 503), META);

    expect(result.status).toBe(503);
    expect(result.body.checks).toEqual({ gateway: "ok", data_api: "ok", d1: "ng: TypeError", r2: "ok", do: "ok" });
  });

  it("届かなければ gateway が ng で、その先は確かめなかったと示す。例外の文言は応答に載せずログにだけ出す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const leaked = new TypeError("service musubi-staging-gateway: internal detail");
    const result = await runHealthz(fails(leaked), META);

    expect(result.status).toBe(503);
    expect(result.body.checks).toEqual({ gateway: "ng: TypeError", ...skippedAll });
    expect(JSON.stringify(result.body)).not.toContain("internal detail");
    expect(error).toHaveBeenCalledWith("[host] healthz: gateway unreachable", leaked);
  });

  it("Error 以外が投げられても落ちずに ng にする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await runHealthz(fails("boom"), META);
    expect(status).toBe(503);
    expect(body.checks.gateway).toBe("ng: string");
  });

  it.each([404, 405, 500])("gateway が healthz 以外の HTTP %i を返したら gateway を ng にする（本文は読まない）", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gateway: GatewayHealthz = async () => Response.json({ error: "internal detail" }, { status });
    const { body } = await runHealthz(gateway, META);

    expect(body.checks).toEqual({ gateway: `ng: HTTP ${status}`, ...skippedAll });
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });

  it.each([
    ["JSON ではない", async () => new Response("<html>internal detail</html>", { status: 200 })],
    ["service が gateway ではない", responds({ ...GATEWAY_OK, service: "data-api" })],
    ["checks が無い", responds({ ...GATEWAY_OK, checks: undefined })],
    ["checks のキーが足りない（data-api の応答をそのまま返した）", responds({ ...GATEWAY_OK, checks: { d1: "ok", r2: "ok", do: "ok" } })],
    ["check の値が ok / ng: の形ではない", responds({ ...GATEWAY_OK, checks: { ...GATEWAY_OK.checks, r2: "fine" } })],
    ["配列", responds([GATEWAY_OK])],
  ] satisfies [string, GatewayHealthz][])("gateway の応答が %s なら gateway を invalid body で ng にする", async (_, gateway) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await runHealthz(gateway, META);

    expect(status).toBe(503);
    expect(body.checks).toEqual({ gateway: "ng: invalid body", ...skippedAll });
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });

  it("別の env の gateway に届いたら、gateway が全部 ok でも env mismatch で ng にする", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await runHealthz(responds({ ...GATEWAY_OK, env: "production" }), META);

    expect(status).toBe(503);
    expect(body.checks).toEqual({ gateway: "ng: env mismatch", ...skippedAll });
    expect(body.env).toBe("staging");
    expect(error).toHaveBeenCalledWith("[host] healthz: gateway env mismatch (host=staging, gateway=production)");
  });

  it("gateway の応答のうち、既知の checks 以外（未知のキー・version など）は持ち出さない", async () => {
    const body = { ...GATEWAY_OK, version: "gateway-sha", checks: { ...GATEWAY_OK.checks, kv: "ng: leaked" } };
    const result = await runHealthz(responds(body), META);

    expect(result.status).toBe(200);
    expect(result.body.checks).toEqual({ gateway: "ok", data_api: "ok", d1: "ok", r2: "ok", do: "ok" });
    expect(result.body.version).toBe("0123abc");
  });
});
