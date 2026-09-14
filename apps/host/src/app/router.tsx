// TanStack Start がクライアントとシェルの描画の両方で呼ぶ router の工場（srcDirectory は vite.config.ts の src/app）。
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}
