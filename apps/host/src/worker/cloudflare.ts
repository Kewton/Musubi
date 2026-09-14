// Cloudflare の adapter。Service Binding（Fetcher）を叩くのはこのファイルだけ。
//
// binding の型と、healthz が gateway を呼ぶ実体を置く。判定と応答の形は src/worker/healthz.ts が持つ。
// **D1 / R2 / DO の binding をここに足さない**（CLAUDE.md 不変条件。src/.oxlintrc.json が型と import で落とす）。
import { GATEWAY_HEALTHZ_PATH } from "./contract";
import type { GatewayHealthz } from "./healthz";

/** wrangler.jsonc の env.<env> が与える binding と vars。名前は src/worker/contract.ts の定数と一致させる。 */
export interface HostEnv {
  /** gateway への Service Binding。data-api へはさらにその先の DATA_API を経由してしか届かない（03 §1） */
  readonly GATEWAY: Fetcher;
  readonly ENVIRONMENT: string;
  readonly GIT_SHA: string;
}

/**
 * Service Binding へのリクエストの origin。宛先は binding が決め、ホスト名は解決に使われない。
 * gateway が見るのはパスだけである。
 */
const GATEWAY_ORIGIN = "https://gateway.internal";

export function cloudflareGateway(env: HostEnv): GatewayHealthz {
  return () => env.GATEWAY.fetch(new URL(GATEWAY_HEALTHZ_PATH, GATEWAY_ORIGIN));
}
