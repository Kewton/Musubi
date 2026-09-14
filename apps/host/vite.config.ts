// host のビルド。TanStack Start の **SPAモード** ＋ @cloudflare/vite-plugin（03 §2「なぜ SSR ではなく SPAシェルなのか」）。
//
// 出力は3つで、配るのは上の2つだけ（.wrangler/deploy/config.json が指すのは entry Worker で、prerender Worker は含まれない）。
//   dist/client           … SPAシェル（index.html）と JS / CSS。wrangler.jsonc の assets として Static Assets が返す
//   dist/musubi_<env>_host … entry Worker（src/worker/index.ts）。/api/* と /healthz だけを見る薄い Worker
//   dist/server           … prerender Worker。**ビルド中にシェルを1枚描くためだけに使い、配らない**
//
// なぜ Worker を2つに分けるか：TanStack Start の SPAモードも、シェルはサーバー側の描画（server-entry）で作る。
// 公式の構成（cloudflare({ viteEnvironment: { name: "ssr" } })）だとその server-entry が配る Worker になり、
// アセットに無いリクエストが Worker に落ちたとき SSR が走る（Free の CPU 10ms を超え得る）。
// prerender Worker に閉じ込めると、描画のコードは配る Worker のバンドルに入らない。
//
// ⚠️ experimental.prerenderWorker は vite-plugin 1.x では experimental。v2 で prerenderWorker（トップレベル）へ移る
//   （cloudflare/workers-sdk#15505）。上げるときはここを書き換える。
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const ENVS = ["dev", "staging", "production"] as const;

// env はビルド時に決まる（vite-plugin は CLOUDFLARE_ENV で wrangler.jsonc の env.<env> を解決する）。
// 未指定のまま作ると env を持たない出力になり、`wrangler deploy --env staging` がトップレベル（musubi-dev-host）を
// 黙って配ってしまう。だから未指定は dev に固定し、別の env へ配ろうとしたら wrangler に食い違いで落とさせる。
process.env.CLOUDFLARE_ENV ??= "dev";
if (!(ENVS as readonly string[]).includes(process.env.CLOUDFLARE_ENV)) {
  throw new Error(`CLOUDFLARE_ENV は ${ENVS.join(" / ")} のどれか（受け取った値: ${process.env.CLOUDFLARE_ENV}）`);
}

export default defineConfig({
  plugins: [
    cloudflare({
      experimental: {
        prerenderWorker: {
          // binding を持たない。シェルの描画に要らず、Terraform 由来の値もここには来ない。
          config: {
            name: "musubi-host-prerender",
            main: "@tanstack/react-start/server-entry",
            compatibility_flags: ["nodejs_compat"],
            // server-entry はこれを見て、X-TSS_SHELL の付いた要求をシェル（ルートの中身を描かない）として描く。
            // Node で動く既定の prerender は process.env に立てるが、workerd には届かないので vars で渡す。
            vars: { TSS_PRERENDERING: "true" },
          },
          viteEnvironment: { name: "ssr" },
        },
      },
    }),
    tanstackStart({
      srcDirectory: "src/app",
      // シェルを /index.html に書く。wrangler.jsonc の not_found_handling: "single-page-application" が返すのはこのファイル。
      spa: { enabled: true, prerender: { outputPath: "/index" } },
    }),
    viteReact(),
  ],
});
