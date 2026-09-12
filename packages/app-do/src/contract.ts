// app-do の「契約」。**cloudflare:workers を import しない。**
//
// wrangler.jsonc の class_name / migration tag と、DO の RPC が返す形をここに集める。
// runtime（src/index.ts）から切り離してあるのは、workerd の外——テスト・設定検査・
// 将来の data-api 側の型——からも同じ定数を参照できるようにするためである。

export const PACKAGE_NAME = "@musubi/app-do" as const;

/** wrangler.jsonc の durable_objects.bindings[].class_name と migrations の正本。 */
export const APP_INSTANCE_DO_CLASS_NAME = "AppInstanceDO" as const;

/** 初回 migration のタグ。deleted_classes を打つときの起点になる。 */
export const APP_INSTANCE_DO_INITIAL_MIGRATION_TAG = "v1" as const;

/** DO をバインドする Worker が使うバインド名。 */
export const APP_DO_BINDING_NAME = "APP_DO" as const;

/** SQLite ストレージ上の 1 行。RPC の戻り値なので構造化クローン可能な形だけを使う。 */
export interface StoredEntry {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string;
}

/** healthz の戻り値。data-api の貫通スモーク（03 §5）がそのまま JSON に載せる。 */
export interface HealthzResult {
  readonly ok: true;
  readonly rows: number;
}
