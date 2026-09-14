// host Worker の「契約」。**Worker の実行時コードを import しない。**
//
// 定数と型だけを置く（gateway / data-api と同じ形）。テストが Worker 本体を巻き込まずに参照できるようにするため。
// Worker の入口は wrangler.jsonc の main（src/worker/index.ts）で、こちらとは別にしてある。
//
// host は @musubi/gateway に依存しない（infra/scripts/dep-graph.mjs が正本で、host が持てる依存は @musubi/sdk だけ）。
// だから gateway の応答の形はここに書き写す。食い違えば、src/worker/index.test.ts の実機（host → gateway → data-api）が落ちる。

export const PACKAGE_NAME = "@musubi/host" as const;

/** 貫通スモーク（03 §5）が叩くパス。 */
export const HEALTHZ_PATH = "/healthz" as const;

/**
 * wrangler.jsonc の assets.run_worker_first。**Worker が起動するのはこのパスだけ**で、
 * それ以外（ページロード・JS / CSS）は Static Assets が Worker を通さずに返す（03 §2・06 §4.1）。
 * /api/* は M2 で gateway へ中継する。M0 の Worker は 404 を返すが、SPAシェルに落ちないよう先に取っておく。
 */
export const WORKER_ROUTES = ["/api/*", HEALTHZ_PATH] as const;

/**
 * wrangler.jsonc の services[].binding。**host が持つ binding はこれだけ**（D1 / R2 / DO は持たない）。
 * Service Binding は Terraform の管理外なので infra:sync の対象にならない。
 */
export const GATEWAY_BINDING = "GATEWAY" as const;

/** gateway の healthz のパス（apps/gateway/src/contract.ts の HEALTHZ_PATH）。 */
export const GATEWAY_HEALTHZ_PATH = "/healthz" as const;

/** gateway の healthz が返す checks のキー（apps/gateway/src/contract.ts の GATEWAY_HEALTHZ_CHECKS と同じ並び）。 */
export const GATEWAY_CHECKS = ["data_api", "d1", "r2", "do"] as const;
export type GatewayCheck = (typeof GATEWAY_CHECKS)[number];

/** host の healthz が返すキー。gateway（届き、正しい応答が返ったか）に、gateway が集約した結果をそのまま続ける（03 §5）。 */
export const HOST_HEALTHZ_CHECKS = ["gateway", ...GATEWAY_CHECKS] as const;
export type HostHealthzCheck = (typeof HOST_HEALTHZ_CHECKS)[number];

/** 1依存の結果。失敗の詳細は "ng: <種別>" までしか載せない（packages/data-api/src/contract.ts の CheckResult と同じ）。 */
export type CheckResult = "ok" | `ng: ${string}`;

export interface HostHealthzBody {
  readonly service: "host";
  /** wrangler.jsonc の vars.ENVIRONMENT */
  readonly env: string;
  /** deploy 時の --var GIT_SHA。ローカルでは "local" */
  readonly version: string;
  readonly checks: Readonly<Record<HostHealthzCheck, CheckResult>>;
  /** wall clock。gateway の応答待ちを含む。10ms 枠に対する異常の早期検知用（03 §5）。正は Workers Analytics */
  readonly elapsed_ms: number;
}
