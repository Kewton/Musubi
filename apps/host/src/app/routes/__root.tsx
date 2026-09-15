// SPAシェル。ビルド時に prerender Worker がこの shellComponent **だけ**を描き、dist/client/index.html に書く（vite.config.ts）。
// ルートの中身（component）はシェルに入らず、ブラウザで描かれる。SSR をしないので、ここで Worker の env やサーバーの値を読まない。
import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "MUSUNEST" },
    ],
  }),
  shellComponent: RootDocument,
  component: Outlet,
});

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
