// Cloudflare の adapter。Service Binding（Fetcher）と Workers 固有の API を叩くのはこのファイルだけ。
//
// binding の型と、healthz が gateway を呼ぶ実体、X-Musubi-Probe を時間一定で照合する実体を置く。
// 判定と応答の形は src/worker/healthz.ts が持つ（apps/gateway/src/cloudflare.ts と同じ形）。
// **D1 / R2 / DO の binding をここに足さない**（CLAUDE.md 不変条件。src/.oxlintrc.json が型と import で落とす）。
import { GATEWAY_HEALTHZ_PATH, PROBE_HEADER } from "./contract";
import type { GatewayHealthz, ProbeVerifier } from "./healthz";

/** wrangler.jsonc の env.<env> が与える binding と vars、wrangler secret。名前は src/worker/contract.ts の定数と一致させる。 */
export interface HostEnv {
  /** gateway への Service Binding。data-api へはさらにその先の DATA_API を経由してしか届かない（03 §1） */
  readonly GATEWAY: Fetcher;
  readonly ENVIRONMENT: string;
  readonly GIT_SHA: string;
  /** 詳細を誰に返すか（src/worker/contract.ts の HealthzDetail）。未設定・書き違いは隠す側に倒す（src/worker/healthz.ts） */
  readonly HEALTHZ_DETAIL?: string;
  /** wrangler secret（src/worker/contract.ts の PROBE_TOKEN_SECRET）。wrangler.jsonc に書かない。置いていない env では無い */
  readonly MUSUBI_PROBE_TOKEN?: string;
}

/**
 * Service Binding へのリクエストの origin。宛先は binding が決め、ホスト名は解決に使われない。
 * gateway が見るのはパスだけである。
 */
const GATEWAY_ORIGIN = "https://gateway.internal";

/**
 * gateway の GET /healthz を呼ぶ。host は gateway の詳細を判定に使うので、secret があれば X-Musubi-Probe に載せる
 * （gateway も production では詳細を隠す）。secret が無ければ載せず、gateway が隠せば healthz.ts が ng にする。
 * 値は Service Binding の中だけを通り、応答にもログにも出さない（ヘッダに載らない値なら workerd は値を含まない TypeError を投げる）。
 */
export function cloudflareGateway(env: HostEnv): GatewayHealthz {
  const secret = env.MUSUBI_PROBE_TOKEN;
  const headers: Record<string, string> = secret === undefined || secret === "" ? {} : { [PROBE_HEADER]: secret };
  return () => env.GATEWAY.fetch(new URL(GATEWAY_HEALTHZ_PATH, GATEWAY_ORIGIN), { headers });
}

/**
 * X-Musubi-Probe の値を secret MUSUBI_PROBE_TOKEN と時間一定で比べる（apps/gateway/src/cloudflare.ts と同じ）。
 * 両方を SHA-256 にしてから crypto.subtle.timingSafeEqual（Workers 固有）で比べるので、長さの違いも時間に出ない。
 * secret が無い・空なら常に false（閉じる側に倒す）。値は応答にもログにも出さない。
 */
export function cloudflareProbe(env: HostEnv): ProbeVerifier {
  return async (presented) => {
    const secret = env.MUSUBI_PROBE_TOKEN;
    if (secret === undefined || secret === "" || presented === null) return false;
    const [actual, expected] = await Promise.all([sha256(presented), sha256(secret)]);
    return crypto.subtle.timingSafeEqual(actual, expected);
  };
}

const encoder = new TextEncoder();

function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}
