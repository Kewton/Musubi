// data-api の「契約」。**Worker の実行時コードを import しない。**
//
// パッケージとしての公開面（package.json の exports）はこのファイルだけである。
// gateway（Service Binding で data-api を呼ぶ側）が型と定数を参照しても、
// Worker 本体や app-do（cloudflare:workers）を巻き込まないようにするため。
// Worker の入口は wrangler.jsonc の main（src/index.ts）で、こちらとは別にしてある。

export const PACKAGE_NAME = "@musubi/data-api" as const;

/** 貫通スモーク（03 §5）が叩くパス。data-api が応答するのはこれだけ。 */
export const HEALTHZ_PATH = "/healthz" as const;

/**
 * wrangler.jsonc の binding 名。infra:sync は binding 名で要素を特定するので、**改名すると同期されない**
 * （infra/scripts/sync-bindings.ts の SECTIONS が正本）。DO の APP_DO は app-do の契約が正本。
 */
export const CONTROL_DB_BINDING = "CONTROL_DB" as const;
export const BUNDLES_BINDING = "BUNDLES" as const;
export const UPLOADS_BINDING = "UPLOADS" as const;

/** healthz が確かめる依存。キー名は gateway / host がそのまま集約する（03 §5 の最終応答）。 */
export const HEALTHZ_CHECKS = ["d1", "r2", "do"] as const;
export type HealthzCheck = (typeof HEALTHZ_CHECKS)[number];

/**
 * 1依存の結果。失敗の詳細は "ng: <種別>" までしか載せない。
 * この応答は gateway → host を経て外へ出る（スモークの CI ログは公開される）。
 * 例外の文言には binding の構成が混ざり得るので、文言は Workers のログ（observability）にだけ出す。
 */
export type CheckResult = "ok" | `ng: ${string}`;

export interface HealthzBody {
  readonly service: "data-api";
  /** wrangler.jsonc の vars.ENVIRONMENT */
  readonly env: string;
  /** deploy 時の --var GIT_SHA。ローカルでは "local" */
  readonly version: string;
  readonly checks: Readonly<Record<HealthzCheck, CheckResult>>;
  /** wall clock。CPU 時間の近似で、10ms 枠に対する異常の早期検知用（03 §5）。正は Workers Analytics */
  readonly elapsed_ms: number;
}
