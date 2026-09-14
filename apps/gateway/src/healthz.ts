// healthz の判定。**Cloudflare の API に触れない。**
//
// data-api をどう呼ぶか（Service Binding）は adapter（src/cloudflare.ts）が DataApiHealthz として渡す。
// ここが決めるのは、data-api の応答をどう読み、応答に何を載せて何を載せないかだけ
// （CLAUDE.md 不変条件「Cloudflare 固有APIは adapter 層に閉じ込める」）。
//
// data_api が ng になるのは「届かない」「healthz の応答ではない」「別の環境の data-api に届いた」の3つ。
// data-api が 503（d1 などが ng）を返したときの data_api は ok で、ng は d1 / r2 / do の側に出る。
// こうしておくと、どの層で切れたかが checks だけで読める（03 §5 の貫通スモーク）。
//
// gateway は workers.dev でインターネットから届く。詳細を隠す env（production）では、X-Musubi-Probe が
// secret と一致しない限り {"ok": true|false} だけを返す（disclose）。照合そのものは adapter の ProbeVerifier が行う。
import { HEALTHZ_CHECKS } from "@musubi/data-api";
import type { CheckResult, HealthzCheck } from "@musubi/data-api";
import type { GatewayHealthzBody, GatewayHealthzCheck, HealthzDetail, HiddenHealthzBody } from "./contract";

/** data-api の GET /healthz を1回呼ぶ。 */
export type DataApiHealthz = () => Promise<Response>;

/**
 * X-Musubi-Probe の値（無ければ null）が secret MUSUBI_PROBE_TOKEN と一致するか。
 * 時間一定の比較は Workers 固有の API を使うので adapter（src/cloudflare.ts）が持つ。
 */
export type ProbeVerifier = (presented: string | null) => Promise<boolean>;

export interface HealthzMeta {
  readonly env: string;
  readonly version: string;
}

export interface HealthzResult {
  readonly status: 200 | 503;
  readonly body: GatewayHealthzBody;
}

/** data_api が ng のとき、確かめられなかった d1 / r2 / do に載せる固定文。 */
export const SKIPPED: CheckResult = "ng: skipped (data_api ng)";
const SKIPPED_CHECKS = Object.fromEntries(HEALTHZ_CHECKS.map((check) => [check, SKIPPED])) as Record<
  HealthzCheck,
  CheckResult
>;

type Upstream =
  | { readonly ok: true; readonly checks: Readonly<Record<HealthzCheck, CheckResult>> }
  | { readonly ok: false; readonly reason: string };

export async function runHealthz(
  dataApi: DataApiHealthz,
  meta: HealthzMeta,
  now: () => number = () => performance.now(),
): Promise<HealthzResult> {
  const startedAt = now();
  const upstream = await callDataApi(dataApi, meta.env);
  const checks: Record<GatewayHealthzCheck, CheckResult> = upstream.ok
    ? { data_api: "ok", ...upstream.checks }
    : { data_api: `ng: ${upstream.reason}`, ...SKIPPED_CHECKS };
  const ok = Object.values(checks).every((result) => result === "ok");
  return {
    status: ok ? 200 : 503,
    body: {
      service: "gateway",
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
 * 応答に載せる本文を決める（03 §5「セキュリティ上の注意」）。
 * 詳細（service・env・version・checks・elapsed_ms）を返すのは、HEALTHZ_DETAIL が public のときと、
 * X-Musubi-Probe が secret と一致したときだけ。それ以外は ok だけにする。HTTP ステータスは変えない。
 */
export async function disclose(
  result: HealthzResult,
  detail: HealthzDetail,
  presented: string | null,
  verify: ProbeVerifier,
): Promise<GatewayHealthzBody | HiddenHealthzBody> {
  if (detail === "public" || (await verify(presented))) return result.body;
  return { ok: result.status === 200 };
}

async function callDataApi(dataApi: DataApiHealthz, env: string): Promise<Upstream> {
  // 詳細は Workers のログにだけ出す（observability.enabled。公開されない）。
  // 応答は host を経て外へ出るので、載せるのは下の固定文と例外の種別（Error#name）だけにする。
  let res: Response;
  try {
    res = await dataApi();
  } catch (e) {
    console.error("[gateway] healthz: data_api unreachable", e);
    return { ok: false, reason: e instanceof Error ? e.name : typeof e };
  }

  // data-api の healthz は 200（全部 ok）か 503（どれかが ng）しか返さない。それ以外は healthz の応答ではない。
  if (res.status !== 200 && res.status !== 503) {
    await res.body?.cancel();
    console.error(`[gateway] healthz: data_api returned HTTP ${res.status}`);
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    console.error("[gateway] healthz: data_api body is not JSON", e);
    return { ok: false, reason: "invalid body" };
  }
  const body = readDataApiBody(raw);
  if (body === undefined) {
    console.error("[gateway] healthz: data_api body is not a data-api healthz body");
    return { ok: false, reason: "invalid body" };
  }

  // 別の環境の data-api に結んだ事故（wrangler.jsonc の services の書き違い）は、届いていても ng にする。
  if (body.env !== env) {
    console.error(`[gateway] healthz: data_api env mismatch (gateway=${env}, data-api=${body.env})`);
    return { ok: false, reason: "env mismatch" };
  }
  return { ok: true, checks: body.checks };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isCheckResult = (v: unknown): v is CheckResult =>
  v === "ok" || (typeof v === "string" && v.startsWith("ng: "));

/** data-api の HealthzBody として読めれば env と checks を返す。checks は既知のキーだけを持ち出す。 */
function readDataApiBody(
  raw: unknown,
): { readonly env: string; readonly checks: Record<HealthzCheck, CheckResult> } | undefined {
  if (!isRecord(raw) || raw.service !== "data-api" || typeof raw.env !== "string") return undefined;
  const checks = raw.checks;
  if (!isRecord(checks)) return undefined;
  const entries = HEALTHZ_CHECKS.map((check) => [check, checks[check]] as const);
  if (!entries.every(([, result]) => isCheckResult(result))) return undefined;
  return { env: raw.env, checks: Object.fromEntries(entries) as Record<HealthzCheck, CheckResult> };
}
