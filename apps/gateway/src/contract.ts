// gateway の「契約」。**Worker の実行時コードを import しない。**
//
// パッケージとしての公開面（package.json の exports）はこのファイルだけである（data-api と同じ形）。
// gateway を呼ぶ側が型と定数を参照しても、Worker 本体を巻き込まないようにするため。
// Worker の入口は wrangler.jsonc の main（src/index.ts）で、こちらとは別にしてある。
import { HEALTHZ_CHECKS } from "@musunest/data-api";
import type { CheckResult } from "@musunest/data-api";

export type { CheckResult };

export const PACKAGE_NAME = "@musunest/gateway" as const;

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

/**
 * 詳細版の healthz を求めるヘッダ（03 §5「セキュリティ上の注意」）。値が secret MUSUNEST_PROBE_TOKEN と一致したときだけ、
 * HEALTHZ_DETAIL が "probe" の env でも詳細を返す。host は gateway を呼ぶとき、自分の MUSUNEST_PROBE_TOKEN をこれに載せる。
 */
export const PROBE_HEADER = "X-Musunest-Probe" as const;

/** X-Musunest-Probe と照合する wrangler secret の名前。**wrangler.jsonc に書かない**（リポジトリにも CI ログにも出さない）。 */
export const PROBE_TOKEN_SECRET = "MUSUNEST_PROBE_TOKEN" as const;

/**
 * wrangler.jsonc の vars.HEALTHZ_DETAIL が取る値。
 *   public … 誰にでも詳細を返す（dev / staging）
 *   probe  … X-Musunest-Probe が secret と一致したときだけ詳細を返す（production）。secret が無ければ常に隠す
 * これ以外の値（未設定・書き違い）は probe として扱う（閉じる側に倒す）。
 */
export const HEALTHZ_DETAILS = ["public", "probe"] as const;
export type HealthzDetail = (typeof HEALTHZ_DETAILS)[number];

/** 詳細を隠した healthz の応答。HTTP ステータス（200 / 503）と同じ意味の ok だけを載せる。 */
export interface HiddenHealthzBody {
  readonly ok: boolean;
}

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
