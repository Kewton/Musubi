// Durable Object（SQLite＋WebSocket）。cloudflare:workers を直接 import してよい唯一の場所。
//
// 企画書9章／03-workers-and-bindings.md §4：
//   - 1アプリインスタンス＝1 DO（SQLite付き）。D1 は Control Plane 専用
//   - クラス名 AppInstanceDO は固定する（改名＝migration）
//   - 初回 migration は必ず new_sqlite_classes。new_classes（KVバックエンド）で作ると
//     後から SQLite に移せない。そもそも Free で使えるのは SQLite 型 DO だけである
//   - DO は data-api にだけバインドする（gateway / host には出さない）
//
// wrangler.jsonc（このパッケージの local-dev ハーネス）と data-api 側の wrangler.jsonc は、
// どちらも下の APP_INSTANCE_DO_* を正本として同じ class_name / tag を書く。
import { DurableObject } from "cloudflare:workers";
import type { HealthzResult, StoredEntry } from "./contract";

export * from "./contract";

/** DO がバインドされる Worker（M0 では local-dev ハーネス、M0-3 以降は data-api）の env。 */
export interface AppDoEnv {
  readonly APP_DO: DurableObjectNamespace<AppInstanceDO>;
}

interface KvRow extends Record<string, string> {
  key: string;
  value: string;
  updated_at: string;
}

/**
 * 1アプリインスタンスに 1 つ割り当たる Durable Object。
 *
 * ストレージは SQLite（`ctx.storage.sql`）。この API は new_sqlite_classes で作られた
 * DO でしか使えないので、**このクラスが動くこと自体が migration の証拠になる**。
 */
export class AppInstanceDO extends DurableObject<AppDoEnv> {
  constructor(ctx: DurableObjectState, env: AppDoEnv) {
    super(ctx, env);
    // SQLite の DDL は同期 API。コンストラクタで張っておけば以降の呼び出しは前提を持てる。
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS kv (
         key        TEXT PRIMARY KEY,
         value      TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
  }

  /** 03 §4 の最小実装。SQLite に1行書いて数え直す＝読み書きの往復を1回で見せる。 */
  async healthz(): Promise<HealthzResult> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _probe (k TEXT PRIMARY KEY, v TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO _probe (k, v) VALUES ('healthz', ?)",
      new Date().toISOString(),
    );
    const rows = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT count(*) AS c FROM _probe")
      .toArray();
    return { ok: true, rows: Number(rows[0]?.c ?? 0) };
  }

  async put(key: string, value: string): Promise<StoredEntry> {
    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      updatedAt,
    );
    return { key, value, updatedAt };
  }

  async get(key: string): Promise<StoredEntry | null> {
    const rows = this.ctx.storage.sql
      .exec<KvRow>("SELECT key, value, updated_at FROM kv WHERE key = ?", key)
      .toArray();
    const row = rows[0];
    return row ? { key: row.key, value: row.value, updatedAt: row.updated_at } : null;
  }

  async list(): Promise<StoredEntry[]> {
    return this.ctx.storage.sql
      .exec<KvRow>("SELECT key, value, updated_at FROM kv ORDER BY key")
      .toArray()
      .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  async delete(key: string): Promise<boolean> {
    // RETURNING で「実際に消えた行」を数える。存在しないキーの DELETE は 0 行になる。
    const deleted = this.ctx.storage.sql
      .exec<{ key: string }>("DELETE FROM kv WHERE key = ? RETURNING key", key)
      .toArray();
    return deleted.length > 0;
  }

  /** DO ストレージのバイト数。無償枠は 1オブジェクト 1GB（06 §2）なので M1 以降で監視する。 */
  async storageSize(): Promise<number> {
    return this.ctx.storage.sql.databaseSize;
  }

  /**
   * WebSocket の受け口。Hibernation API（`ctx.acceptWebSocket`）を使う。
   * 素の `server.accept()` にすると接続中ずっと DO が課金対象で起きたままになる。
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** 受け取った本文を SQLite に落としてから echo する。WS 経路でも永続化が効くことを見せる。 */
  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    const entry = await this.put(`ws:${crypto.randomUUID()}`, text);
    ws.send(JSON.stringify({ type: "echo", text, key: entry.key, rows: this.#count() }));
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    // 1005（No Status Received）/ 1006（Abnormal Closure）はこちらから送り返せない。
    ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  #count(): number {
    const rows = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT count(*) AS c FROM kv")
      .toArray();
    return Number(rows[0]?.c ?? 0);
  }
}
