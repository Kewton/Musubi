// 企画書9章「顔は軽く・力は本体に」の依存の向きを、1か所で定義する正本。
// 01-repo-bootstrap.md §3.2 の図をそのまま機械可読にしたもの。
//   appspec-schema ← sdk ← data-api ← gateway ← host
//          ↑                  ↑
//      spec-engine         app-do
//          ↑
//     control-plane
export const ALLOWED = {
  "@musubi/appspec-schema": [],
  "@musubi/sdk": ["@musubi/appspec-schema"],
  "@musubi/spec-engine": ["@musubi/appspec-schema"],
  "@musubi/app-do": ["@musubi/appspec-schema"],
  "@musubi/control-plane": ["@musubi/appspec-schema"],
  "@musubi/connector": ["@musubi/appspec-schema"],
  "@musubi/data-api": ["@musubi/appspec-schema", "@musubi/sdk", "@musubi/spec-engine", "@musubi/app-do"],
  "@musubi/gateway": ["@musubi/control-plane", "@musubi/data-api"],
  "@musubi/host": ["@musubi/sdk"],
  "@musubi/e2e": [],
  "@musubi/template-tanstack-start": [],
};

// ディレクトリ上の位置。apps/* は外部到達、packages/* は Service Binding 経由のみ。
export const DIRS = {
  "@musubi/host": "apps/host",
  "@musubi/gateway": "apps/gateway",
  "@musubi/appspec-schema": "packages/appspec-schema",
  "@musubi/control-plane": "packages/control-plane",
  "@musubi/data-api": "packages/data-api",
  "@musubi/spec-engine": "packages/spec-engine",
  "@musubi/app-do": "packages/app-do",
  "@musubi/connector": "packages/connector",
  "@musubi/sdk": "packages/sdk",
  "@musubi/e2e": "e2e",
  "@musubi/template-tanstack-start": "templates/tanstack-start",
};
