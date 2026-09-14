// Cloudflare の adapter。Service Binding（Fetcher）と Workers 固有の API を叩くのはこのファイルだけ。
//
// binding の型と、healthz が data-api を呼ぶ実体、X-Musubi-Probe を時間一定で照合する実体を置く。
// 判定と応答の形は src/healthz.ts が持つ。
// **D1 / R2 / DO の binding をここに足さない**（CLAUDE.md 不変条件。src/.oxlintrc.json が型と import で落とす）。
import { HEALTHZ_PATH as DATA_API_HEALTHZ_PATH } from "@musubi/data-api";
import type { DataApiHealthz, ProbeVerifier } from "./healthz";

/** wrangler.jsonc の env.<env> が与える binding と vars、wrangler secret。名前は src/contract.ts の定数と一致させる。 */
export interface GatewayEnv {
  /** data-api への Service Binding。data-api は外部ルートを持たないので、届く経路はこれだけ（03 §1） */
  readonly DATA_API: Fetcher;
  readonly ENVIRONMENT: string;
  readonly GIT_SHA: string;
  /** 詳細を誰に返すか（src/contract.ts の HealthzDetail）。未設定・書き違いは隠す側に倒す（src/healthz.ts） */
  readonly HEALTHZ_DETAIL?: string;
  /** wrangler secret（src/contract.ts の PROBE_TOKEN_SECRET）。wrangler.jsonc に書かない。置いていない env では無い */
  readonly MUSUBI_PROBE_TOKEN?: string;
}

/**
 * Service Binding へのリクエストの origin。宛先は binding が決め、ホスト名は解決に使われない。
 * data-api が見るのはパスだけである。
 */
const DATA_API_ORIGIN = "https://data-api.internal";

export function cloudflareDataApi(env: GatewayEnv): DataApiHealthz {
  return () => env.DATA_API.fetch(new URL(DATA_API_HEALTHZ_PATH, DATA_API_ORIGIN));
}

/**
 * X-Musubi-Probe の値を secret MUSUBI_PROBE_TOKEN と時間一定で比べる。
 * 両方を SHA-256 にしてから crypto.subtle.timingSafeEqual（Workers 固有）で比べるので、長さの違いも時間に出ない。
 * secret が無い・空なら常に false（閉じる側に倒す）。値は応答にもログにも出さない。
 */
export function cloudflareProbe(env: GatewayEnv): ProbeVerifier {
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
