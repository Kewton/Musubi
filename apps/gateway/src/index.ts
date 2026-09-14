// Community Gateway。認証・AppGrant 検査の入口（中身は M2）。**D1 / R2 / DO を直接触らない。**
//
// wrangler.jsonc の main。持つ binding は data-api への Service Binding（DATA_API）だけで、
// D1 / R2 / DO には data-api を経由してしか届かない（CLAUDE.md 不変条件「Data API が唯一の権限強制点」）。
// 設定は src/index.test.ts が env ごとに、import と型は src/.oxlintrc.json が lint で確かめる。
//
// M0 で応答するのは GET /healthz だけ（03 §5 の貫通スモーク）。data-api の healthz を中継し、自分の結果を足す。
import { cloudflareDataApi } from "./cloudflare";
import type { GatewayEnv } from "./cloudflare";
import { HEALTHZ_PATH } from "./contract";
import { runHealthz } from "./healthz";

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== HEALTHZ_PATH) return json({ error: "not found" }, 404);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { allow: "GET" });

    const { status, body } = await runHealthz(cloudflareDataApi(env), {
      env: env.ENVIRONMENT,
      version: env.GIT_SHA,
    });
    return json(body, status);
  },
} satisfies ExportedHandler<GatewayEnv>;
