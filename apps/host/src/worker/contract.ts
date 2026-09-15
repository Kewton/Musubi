// host Worker の「契約」。**Worker の実行時コードを import しない。**
//
// 定数と型だけを置く（gateway / data-api と同じ形）。テストが Worker 本体を巻き込まずに参照できるようにするため。
// Worker の入口は wrangler.jsonc の main（src/worker/index.ts）で、こちらとは別にしてある。
//
// host は @musunest/gateway に依存しない（infra/scripts/dep-graph.mjs が正本で、host が持てる依存は @musunest/sdk だけ）。
// だから gateway の応答の形はここに書き写す。食い違えば、src/worker/index.test.ts の実機（host → gateway → data-api）が落ちる。

export const PACKAGE_NAME = "@musunest/host" as const;

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

/**
 * 詳細版の healthz を求めるヘッダ（03 §5「セキュリティ上の注意」。apps/gateway/src/contract.ts の PROBE_HEADER と同じ）。
 * 値が secret MUSUNEST_PROBE_TOKEN と一致したときだけ、HEALTHZ_DETAIL が "probe" の env でも詳細を返す。
 * host は gateway を呼ぶときも、自分の MUSUNEST_PROBE_TOKEN をこのヘッダに載せる（gateway も同じ規則で詳細を隠すため）。
 */
export const PROBE_HEADER = "X-Musunest-Probe" as const;

/** X-Musunest-Probe と照合する wrangler secret の名前。**wrangler.jsonc に書かない**（リポジトリにも CI ログにも出さない）。 */
export const PROBE_TOKEN_SECRET = "MUSUNEST_PROBE_TOKEN" as const;

/**
 * wrangler.jsonc の vars.HEALTHZ_DETAIL が取る値（apps/gateway/src/contract.ts の HEALTHZ_DETAILS と同じ）。
 *   public … 誰にでも詳細を返す（dev / staging）
 *   probe  … X-Musunest-Probe が secret と一致したときだけ詳細を返す（production）。secret が無ければ常に隠す
 * これ以外の値（未設定・書き違い）は probe として扱う（閉じる側に倒す）。
 */
export const HEALTHZ_DETAILS = ["public", "probe"] as const;
export type HealthzDetail = (typeof HEALTHZ_DETAILS)[number];

/** 詳細を隠した healthz の応答。HTTP ステータス（200 / 503）と同じ意味の ok だけを載せる（gateway も同じ形で隠す）。 */
export interface HiddenHealthzBody {
  readonly ok: boolean;
}

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
