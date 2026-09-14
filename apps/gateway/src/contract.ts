// gateway の「契約」。**Worker の実行時コードを import しない。**
//
// パッケージとしての公開面（package.json の exports）はこのファイルだけである（data-api と同じ形）。
// gateway を呼ぶ側が型と定数を参照しても、Worker 本体を巻き込まないようにするため。
// Worker の入口は wrangler.jsonc の main（src/index.ts）で、こちらとは別にしてある。
import { HEALTHZ_CHECKS } from "@musubi/data-api";
import type { CheckResult } from "@musubi/data-api";

export type { CheckResult };

export const PACKAGE_NAME = "@musubi/gateway" as const;

/** 貫通スモーク（03 §5）が叩くパス。M0 の gateway が応答するのはこれだけ。 */
export const HEALTHZ_PATH = "/healthz" as const;

/**
 * wrangler.jsonc の services[].binding。**gateway が持つ binding はこれだけ**（D1 / R2 / DO は持たない）。
 * Service Binding は Terraform の管理外なので infra:sync の対象にならない。
 */
export const DATA_API_BINDING = "DATA_API" as const;

/**
 * gateway の healthz が返すキー。data_api（data-api に届き、正しい応答が返ったか）に、
 * data-api が確かめた d1 / r2 / do をそのまま続ける。host はここに gateway を足して集約する（03 §5）。
 */
export const GATEWAY_HEALTHZ_CHECKS = ["data_api", ...HEALTHZ_CHECKS] as const;
export type GatewayHealthzCheck = (typeof GATEWAY_HEALTHZ_CHECKS)[number];

export interface GatewayHealthzBody {
  readonly service: "gateway";
  /** wrangler.jsonc の vars.ENVIRONMENT */
  readonly env: string;
  /** deploy 時の --var GIT_SHA。ローカルでは "local" */
  readonly version: string;
  readonly checks: Readonly<Record<GatewayHealthzCheck, CheckResult>>;
  /** wall clock。data-api の応答待ちを含む。10ms 枠に対する異常の早期検知用（03 §5）。正は Workers Analytics */
  readonly elapsed_ms: number;
}
