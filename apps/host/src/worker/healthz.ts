// healthz の判定。**Cloudflare の API に触れない。**
//
// gateway をどう呼ぶか（Service Binding）は adapter（src/worker/cloudflare.ts）が GatewayHealthz として渡す。
// ここが決めるのは、gateway の応答をどう読み、応答に何を載せて何を載せないかだけ
// （CLAUDE.md 不変条件「Cloudflare 固有APIは adapter 層に閉じ込める」）。形は apps/gateway/src/healthz.ts に揃えてある。
//
// gateway が ng になるのは「届かない」「healthz の応答ではない」「別の環境の gateway に届いた」の3つ。
// gateway が 503（data_api などが ng）を返したときの gateway は ok で、ng はその先のキーに出る。
// こうしておくと、host → gateway → data-api → {D1, R2, DO} のどこで切れたかが checks だけで読める（03 §5）。
//
// host はインターネットから届く。詳細を隠す env（production）では、X-Musunest-Probe が secret と一致しない限り
// {"ok": true|false} だけを返す（disclose）。照合そのものは adapter の ProbeVerifier が行う。
// gateway も同じ規則で隠すので、adapter は gateway を呼ぶときに secret を X-Musunest-Probe に載せる。
// それでも gateway が隠した応答を返したら（host と gateway の secret が揃っていない）、gateway を "ng: details hidden" にする。
import { GATEWAY_CHECKS } from "./contract";
import type {
  CheckResult,
  GatewayCheck,
  HealthzDetail,
  HiddenHealthzBody,
  HostHealthzBody,
  HostHealthzCheck,
} from "./contract";

/** gateway の GET /healthz を1回呼ぶ。 */
export type GatewayHealthz = () => Promise<Response>;

/**
 * X-Musunest-Probe の値（無ければ null）が secret MUSUNEST_PROBE_TOKEN と一致するか。
 * 時間一定の比較は Workers 固有の API を使うので adapter（src/worker/cloudflare.ts）が持つ。
 */
export type ProbeVerifier = (presented: string | null) => Promise<boolean>;

export interface HealthzMeta {
  readonly env: string;
  readonly version: string;
}

export interface HealthzResult {
  readonly status: 200 | 503;
  readonly body: HostHealthzBody;
}

/** gateway が ng のとき、確かめられなかった data_api / d1 / r2 / do に載せる固定文。 */
export const SKIPPED: CheckResult = "ng: skipped (gateway ng)";
const SKIPPED_CHECKS = Object.fromEntries(GATEWAY_CHECKS.map((check) => [check, SKIPPED])) as Record<
  GatewayCheck,
  CheckResult
>;

type Upstream =
  | { readonly ok: true; readonly checks: Readonly<Record<GatewayCheck, CheckResult>> }
  | { readonly ok: false; readonly reason: string };

export async function runHealthz(
  gateway: GatewayHealthz,
  meta: HealthzMeta,
  now: () => number = () => performance.now(),
): Promise<HealthzResult> {
  const startedAt = now();
  const upstream = await callGateway(gateway, meta.env);
  const checks: Record<HostHealthzCheck, CheckResult> = upstream.ok
    ? { gateway: "ok", ...upstream.checks }
    : { gateway: `ng: ${upstream.reason}`, ...SKIPPED_CHECKS };
  const ok = Object.values(checks).every((result) => result === "ok");
  return {
    status: ok ? 200 : 503,
    body: {
      service: "host",
      env: meta.env,
      version: meta.version,
      checks,
      elapsed_ms: Math.round((now() - startedAt) * 100) / 100,
    },
  };
}

/** vars.HEALTHZ_DETAIL を読む。"public" 以外（未設定・書き違い）は "probe" に倒す（閉じる側）。 */
export function readHealthzDetail(raw: string | undefined): HealthzDetail {
  return raw === "public" ? "public" : "probe";
}

/**
 * 応答に載せる本文を決める（03 §5「セキュリティ上の注意」。apps/gateway/src/healthz.ts と同じ）。
 * 詳細（service・env・version・checks・elapsed_ms）を返すのは、HEALTHZ_DETAIL が public のときと、
 * X-Musunest-Probe が secret と一致したときだけ。それ以外は ok だけにする。HTTP ステータスは変えない。
 */
export async function disclose(
  result: HealthzResult,
  detail: HealthzDetail,
  presented: string | null,
  verify: ProbeVerifier,
): Promise<HostHealthzBody | HiddenHealthzBody> {
  if (detail === "public" || (await verify(presented))) return result.body;
  return { ok: result.status === 200 };
}

async function callGateway(gateway: GatewayHealthz, env: string): Promise<Upstream> {
  // 詳細は Workers のログにだけ出す（observability.enabled。公開されない）。
  // host の応答はインターネットへ出るので、載せるのは下の固定文と例外の種別（Error#name）だけにする。
  let res: Response;
  try {
    res = await gateway();
  } catch (e) {
    console.error("[host] healthz: gateway unreachable", e);
    return { ok: false, reason: e instanceof Error ? e.name : typeof e };
  }

  // gateway の healthz は 200（全部 ok）か 503（どれかが ng）しか返さない。それ以外は healthz の応答ではない。
  if (res.status !== 200 && res.status !== 503) {
    await res.body?.cancel();
    console.error(`[host] healthz: gateway returned HTTP ${res.status}`);
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    console.error("[host] healthz: gateway body is not JSON", e);
    return { ok: false, reason: "invalid body" };
  }
  // gateway が詳細を隠した。host が載せた X-Musunest-Probe を gateway が受け付けていない（secret が無い・値が食い違う）。
  if (isHiddenBody(raw)) {
    console.error("[host] healthz: gateway hid the details (X-Musunest-Probe not accepted: MUSUNEST_PROBE_TOKEN of host and gateway must be set and equal)");
    return { ok: false, reason: "details hidden" };
  }
  const body = readGatewayBody(raw);
  if (body === undefined) {
    console.error("[host] healthz: gateway body is not a gateway healthz body");
    return { ok: false, reason: "invalid body" };
  }

  // 別の環境の gateway に結んだ事故（wrangler.jsonc の services の書き違い）は、届いていても ng にする。
  if (body.env !== env) {
    console.error(`[host] healthz: gateway env mismatch (host=${env}, gateway=${body.env})`);
    return { ok: false, reason: "env mismatch" };
  }
  return { ok: true, checks: body.checks };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isCheckResult = (v: unknown): v is CheckResult =>
  v === "ok" || (typeof v === "string" && v.startsWith("ng: "));

/** 詳細を隠した応答（{"ok": true|false} だけ）か。 */
const isHiddenBody = (v: unknown): v is HiddenHealthzBody =>
  isRecord(v) && typeof v.ok === "boolean" && Object.keys(v).length === 1;

/** gateway の healthz の応答として読めれば env と checks を返す。checks は既知のキーだけを持ち出す。 */
function readGatewayBody(
  raw: unknown,
): { readonly env: string; readonly checks: Record<GatewayCheck, CheckResult> } | undefined {
  if (!isRecord(raw) || raw.service !== "gateway" || typeof raw.env !== "string") return undefined;
  const checks = raw.checks;
  if (!isRecord(checks)) return undefined;
  const entries = GATEWAY_CHECKS.map((check) => [check, checks[check]] as const);
  if (!entries.every(([, result]) => isCheckResult(result))) return undefined;
  return { env: raw.env, checks: Object.fromEntries(entries) as Record<GatewayCheck, CheckResult> };
}
