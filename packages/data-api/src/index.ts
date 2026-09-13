// ★唯一の権限強制点（Worker）。外部ルートを持たない。
//
// wrangler.jsonc の main。到達経路は gateway からの Service Binding だけで、
// workers_dev / preview_urls / routes はすべて切ってある（src/index.test.ts が設定を確かめる）。
//
// M0 で応答するのは GET /healthz だけ（03 §5 の貫通スモーク）。認証も権限もまだ入れない。
import { AppInstanceDO } from "@musubi/app-do";
import { cloudflareProbes } from "./cloudflare";
import type { DataApiEnv } from "./cloudflare";
import { HEALTHZ_PATH } from "./contract";
import { runHealthz } from "./healthz";

// DO のクラスは binding を持つ Worker の main から export しなければ解決されない。
// 実装の正本は app-do で、data-api は運ぶだけ。
export { AppInstanceDO };

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== HEALTHZ_PATH) return json({ error: "not found" }, 404);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { allow: "GET" });

    const { status, body } = await runHealthz(cloudflareProbes(env), {
      env: env.ENVIRONMENT,
      version: env.GIT_SHA,
    });
    return json(body, status);
  },
} satisfies ExportedHandler<DataApiEnv>;
