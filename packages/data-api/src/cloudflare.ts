// Cloudflare の adapter。D1 / R2 / Durable Object の API を叩くのはこのファイルだけ。
//
// binding の型と、healthz の Probe の実体を置く。判定と応答の形は src/healthz.ts が持つ。
import type { AppInstanceDO } from "@musunest/app-do";
import { ProbeFailure } from "./healthz";
import type { Probes } from "./healthz";

/** wrangler.jsonc の env.<env> が与える binding と vars。名前は src/contract.ts の定数と一致させる。 */
export interface DataApiEnv {
  /** Control Plane 専用の D1。アプリのデータは置かない（CLAUDE.md 不変条件） */
  readonly CONTROL_DB: D1Database;
  /** 生成 bundle の置き場 */
  readonly BUNDLES: R2Bucket;
  /** 利用者がアップロードしたファイルの置き場 */
  readonly UPLOADS: R2Bucket;
  /** 1アプリインスタンス＝1 DO（SQLite）。DO をバインドするのは data-api だけ（03 §4） */
  readonly APP_DO: DurableObjectNamespace<AppInstanceDO>;
  readonly ENVIRONMENT: string;
  readonly GIT_SHA: string;
}

/** R2 に書く probe のキー。bundle の名前空間と衝突しない接頭辞にしてある。 */
export const PROBE_OBJECT_KEY = "_probe/healthz";

/** healthz が叩く DO インスタンスの名前。アプリインスタンスの名前空間と衝突しない。 */
export const PROBE_DO_NAME = "_probe";

export function cloudflareProbes(env: DataApiEnv): Probes {
  return {
    async d1() {
      await env.CONTROL_DB.prepare("SELECT 1").first();
    },

    async r2() {
      // BUNDLES は書いて読み戻す（書き込み権限まで確かめる）。
      await env.BUNDLES.put(PROBE_OBJECT_KEY, new Date().toISOString());
      if ((await env.BUNDLES.head(PROBE_OBJECT_KEY)) === null) throw new ProbeFailure("BUNDLES head miss");
      // UPLOADS は利用者のデータ置き場なので書かない。head は無いキーなら null を返し、
      // バケットに届かなければ投げるので、binding の解決だけを確かめられる。
      await env.UPLOADS.head(PROBE_OBJECT_KEY);
    },

    async do() {
      const stub = env.APP_DO.get(env.APP_DO.idFromName(PROBE_DO_NAME));
      const result = await stub.healthz();
      if (!result.ok) throw new ProbeFailure("AppInstanceDO healthz not ok");
    },
  };
}
