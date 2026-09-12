// local-dev / テスト専用のハーネス Worker。
//
// **これは配備しない。** 本番経路で DO に触れてよいのは data-api だけである
// （CLAUDE.md 不変条件「Data API が唯一の権限強制点」／03-workers-and-bindings.md §4
// 「DO は data-api にだけバインドする」）。ルートも workers_dev も持たず、
// `pnpm deploy:*` の --filter にも入っていない。
//
// 存在理由は1つ：`wrangler.jsonc` の new_sqlite_classes migration を実際に適用した
// workerd の上で AppInstanceDO を起動し、SQLite の読み書きと WebSocket 接続を
// HTTP から叩けるようにすること。src/index.test.ts がこの入口を使う。
import { AppInstanceDO } from "./index";
import type { AppDoEnv } from "./index";

export { AppInstanceDO };

const DEFAULT_INSTANCE = "m0";

function stubFor(env: AppDoEnv, url: URL): DurableObjectStub<AppInstanceDO> {
  const name = url.searchParams.get("app") ?? DEFAULT_INSTANCE;
  return env.APP_DO.get(env.APP_DO.idFromName(name));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: AppDoEnv): Promise<Response> {
    const url = new URL(request.url);
    const stub = stubFor(env, url);

    if (url.pathname === "/ws") {
      // WebSocket のアップグレードは DO 自身が受ける（Hibernation API を使うため）。
      return stub.fetch(request);
    }

    if (url.pathname === "/healthz") {
      return json(await stub.healthz());
    }

    if (url.pathname === "/kv") {
      return json(await stub.list());
    }

    if (url.pathname.startsWith("/kv/")) {
      const key = decodeURIComponent(url.pathname.slice("/kv/".length));
      switch (request.method) {
        case "GET": {
          const entry = await stub.get(key);
          return entry ? json(entry) : json({ error: "not found", key }, 404);
        }
        case "PUT":
          return json(await stub.put(key, await request.text()));
        case "DELETE":
          return json({ key, deleted: await stub.delete(key) });
        default:
          return json({ error: "method not allowed" }, 405);
      }
    }

    if (url.pathname === "/storage-size") {
      return json({ bytes: await stub.storageSize() });
    }

    return json({ error: "not found", pathname: url.pathname }, 404);
  },
} satisfies ExportedHandler<AppDoEnv>;
