// Cloudflare の adapter。Service Binding（Fetcher）を叩くのはこのファイルだけ。
//
// binding の型と、healthz が data-api を呼ぶ実体を置く。判定と応答の形は src/healthz.ts が持つ。
// **D1 / R2 / DO の binding をここに足さない**（CLAUDE.md 不変条件。src/.oxlintrc.json が型と import で落とす）。
import { HEALTHZ_PATH as DATA_API_HEALTHZ_PATH } from "@musubi/data-api";
import type { DataApiHealthz } from "./healthz";

/** wrangler.jsonc の env.<env> が与える binding と vars。名前は src/contract.ts の定数と一致させる。 */
export interface GatewayEnv {
  /** data-api への Service Binding。data-api は外部ルートを持たないので、届く経路はこれだけ（03 §1） */
  readonly DATA_API: Fetcher;
  readonly ENVIRONMENT: string;
  readonly GIT_SHA: string;
}

/**
 * Service Binding へのリクエストの origin。宛先は binding が決め、ホスト名は解決に使われない。
 * data-api が見るのはパスだけである。
 */
const DATA_API_ORIGIN = "https://data-api.internal";

export function cloudflareDataApi(env: GatewayEnv): DataApiHealthz {
  return () => env.DATA_API.fetch(new URL(DATA_API_HEALTHZ_PATH, DATA_API_ORIGIN));
}
