// healthz の判定だけを、Cloudflare を使わずに確かめる。
// 実機（workerd の D1 / R2 / DO）での疎通は src/index.test.ts が見る。
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEALTHZ_CHECKS } from "./contract.js";
import { ProbeFailure, runHealthz } from "./healthz.js";
import type { Probe, Probes } from "./healthz.js";

const META = { env: "staging", version: "0123abc" } as const;
const ok: Probe = async () => {};
const fails = (error: unknown): Probe => () => Promise.reject(error);

function probes(overrides: Partial<Record<keyof Probes, Probe>> = {}): Probes {
  return { d1: ok, r2: ok, do: ok, ...overrides };
}

describe("runHealthz", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("全部 ok なら 200 で、03 §5 の形の JSON を返す", async () => {
    const ticks = [10, 14.256];
    const result = await runHealthz(probes(), META, () => ticks.shift() ?? 0);

    expect(result).toEqual({
      status: 200,
      body: {
        service: "data-api",
        env: "staging",
        version: "0123abc",
        checks: { d1: "ok", r2: "ok", do: "ok" },
        elapsed_ms: 4.26,
      },
    });
  });

  it("確かめる依存は d1 / r2 / do の3つ（gateway / host が集約するキー）", async () => {
    expect(HEALTHZ_CHECKS).toEqual(["d1", "r2", "do"]);
    const { body } = await runHealthz(probes(), META);
    expect(Object.keys(body.checks)).toEqual(["d1", "r2", "do"]);
  });

  it("1つでも失敗すれば 503 で、失敗した依存だけが ng になる", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d1 = fails(new TypeError("D1_ERROR: no such database"));
    const { status, body } = await runHealthz(probes({ d1 }), META);

    expect(status).toBe(503);
    expect(body.checks).toEqual({ d1: "ng: TypeError", r2: "ok", do: "ok" });
  });

  it("例外の文言は応答に載せない（gateway → host を経て外へ出る）。ログにだけ出す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const leaked = new Error("bucket musubi-staging-bundles: internal detail");
    const { body } = await runHealthz(probes({ r2: fails(leaked) }), META);

    expect(JSON.stringify(body)).not.toContain("musubi-staging-bundles");
    expect(body.checks.r2).toBe("ng: Error");
    expect(error).toHaveBeenCalledWith("[data-api] healthz: r2 ng", leaked);
  });

  it("adapter が判定した ProbeFailure は、その固定文を載せる", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new ProbeFailure("AppInstanceDO healthz not ok");
    const { body } = await runHealthz(probes({ do: fails(failure) }), META);
    expect(body.checks.do).toBe("ng: AppInstanceDO healthz not ok");
  });

  it("Error 以外が投げられても落ちずに ng にする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await runHealthz(probes({ d1: fails("boom") }), META);
    expect(status).toBe(503);
    expect(body.checks.d1).toBe("ng: string");
  });

  it("依存を並べて待つ（1つが遅くても他の開始を待たせない）", async () => {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = (name: string): Probe => async () => {
      started.push(name);
      await gate;
    };
    const pending = runHealthz({ d1: slow("d1"), r2: slow("r2"), do: slow("do") }, META);
    await Promise.resolve();
    expect(started).toEqual(["d1", "r2", "do"]);
    release?.();
    expect((await pending).status).toBe(200);
  });
});
