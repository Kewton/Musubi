// 企画書9章「顔は軽く・力は本体に」の依存の向きを、1か所で定義する正本。
// 01-repo-bootstrap.md §3.2 の図をそのまま機械可読にしたもの。
//   appspec-schema ← sdk ← data-api ← gateway ← host
//          ↑                  ↑
//      spec-engine         app-do
//          ↑
//     control-plane
export const ALLOWED = {
  "@musunest/appspec-schema": [],
  "@musunest/sdk": ["@musunest/appspec-schema"],
  "@musunest/spec-engine": ["@musunest/appspec-schema"],
  "@musunest/app-do": ["@musunest/appspec-schema"],
  "@musunest/control-plane": ["@musunest/appspec-schema"],
  "@musunest/connector": ["@musunest/appspec-schema"],
  "@musunest/data-api": ["@musunest/appspec-schema", "@musunest/sdk", "@musunest/spec-engine", "@musunest/app-do"],
  "@musunest/gateway": ["@musunest/control-plane", "@musunest/data-api"],
  "@musunest/host": ["@musunest/sdk"],
  "@musunest/e2e": [],
  "@musunest/template-tanstack-start": [],
};

// ディレクトリ上の位置。apps/* は外部到達、packages/* は Service Binding 経由のみ。
export const DIRS = {
  "@musunest/host": "apps/host",
  "@musunest/gateway": "apps/gateway",
  "@musunest/appspec-schema": "packages/appspec-schema",
  "@musunest/control-plane": "packages/control-plane",
  "@musunest/data-api": "packages/data-api",
  "@musunest/spec-engine": "packages/spec-engine",
  "@musunest/app-do": "packages/app-do",
  "@musunest/connector": "packages/connector",
  "@musunest/sdk": "packages/sdk",
  "@musunest/e2e": "e2e",
  "@musunest/template-tanstack-start": "templates/tanstack-start",
};
