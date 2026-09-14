// PWA Host Shell の Worker。**SSR をしない。ページを返さない。**
//
// wrangler.jsonc の main。ページロード（/・深いリンク・JS / CSS）は Static Assets が Worker を起動せずに返すので、
// ここに届くのは assets.run_worker_first に書いた /api/* と /healthz だけである（03 §2・06 §4.1）。
// React / TanStack Start をここから import しない（src/.oxlintrc.json が落とす。バンドルに入らないことは src/worker/index.test.ts が見る）。
//
// 持つ binding は gateway への Service Binding（GATEWAY）だけで、D1 / R2 / DO を直接触らない（CLAUDE.md 不変条件）。
// M0 で応答するのは GET /healthz だけ（03 §5 の貫通スモーク）。gateway の healthz を中継し、自分の結果を足す。
import { cloudflareGateway } from "./cloudflare";
import type { HostEnv } from "./cloudflare";
import { HEALTHZ_PATH } from "./contract";
import { runHealthz } from "./healthz";

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // /api/* は M2 で gateway へ中継する。それまでは 404（SPAシェルの HTML を API の応答にしない）。
    if (url.pathname !== HEALTHZ_PATH) return json({ error: "not found" }, 404);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { allow: "GET" });

    const { status, body } = await runHealthz(cloudflareGateway(env), {
      env: env.ENVIRONMENT,
      version: env.GIT_SHA,
    });
    return json(body, status);
  },
} satisfies ExportedHandler<HostEnv>;
