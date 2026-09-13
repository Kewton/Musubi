// healthz の判定。**Cloudflare の API に触れない。**
//
// D1 / R2 / DO をどう叩くかは adapter（src/cloudflare.ts）が Probe として渡す。
// ここが決めるのは「全部 ok なら 200、1つでも ng なら 503」と、応答に何を載せて何を載せないかだけ
// （CLAUDE.md 不変条件「Cloudflare 固有APIは adapter 層に閉じ込める」）。
import { HEALTHZ_CHECKS } from "./contract";
import type { CheckResult, HealthzBody, HealthzCheck } from "./contract";

/** 依存を1つ確かめる。解決すれば ok、投げれば ng。 */
export type Probe = () => Promise<void>;
export type Probes = Readonly<Record<HealthzCheck, Probe>>;

/**
 * adapter が自分で判定した失敗。文言は adapter が書いた固定文なので、応答に載せてよい。
 * それ以外の例外は文言を捨て、種別（Error#name）だけを載せる。
 */
export class ProbeFailure extends Error {
  override name = "ProbeFailure";
}

export interface HealthzMeta {
  readonly env: string;
  readonly version: string;
}

export interface HealthzResult {
  readonly status: 200 | 503;
  readonly body: HealthzBody;
}

export async function runHealthz(
  probes: Probes,
  meta: HealthzMeta,
  now: () => number = () => performance.now(),
): Promise<HealthzResult> {
  const startedAt = now();
  // 依存どうしは独立なので並べて待つ。直列にすると wall clock が各依存の合計になる。
  const results = await Promise.all(
    HEALTHZ_CHECKS.map(async (check) => [check, await settle(check, probes[check])] as const),
  );
  const checks = Object.fromEntries(results) as Record<HealthzCheck, CheckResult>;
  const ok = results.every(([, result]) => result === "ok");
  return {
    status: ok ? 200 : 503,
    body: {
      service: "data-api",
      env: meta.env,
      version: meta.version,
      checks,
      elapsed_ms: Math.round((now() - startedAt) * 100) / 100,
    },
  };
}

async function settle(check: HealthzCheck, probe: Probe): Promise<CheckResult> {
  try {
    await probe();
    return "ok";
  } catch (e) {
    // 詳細は Workers のログにだけ出す（observability.enabled。公開されない）。
    console.error(`[data-api] healthz: ${check} ng`, e);
    if (e instanceof ProbeFailure) return `ng: ${e.message}`;
    return `ng: ${e instanceof Error ? e.name : typeof e}`;
  }
}
