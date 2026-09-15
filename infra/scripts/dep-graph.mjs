// 企画書9章「顔は軽く・力は本体に」の依存の向きを、1か所で定義する正本。
// M0 は 01-repo-bootstrap.md §3.2 の図から作った。M1.1 の前に 3 本足した（2026-09-16 所有者が決定。
// workspace/mvp/m1/00-open-questions.md Q14）：
//   data-api → control-plane   … D1 の登録表の定義と読み書きを control-plane に置き、data-api が使う
//   control-plane → spec-engine … publish の中身（静的チェック → 正規化 → 登録する行）を control-plane に置く
//   e2e → sdk                   … staging の e2e を host と同じ型付きクライアントで呼ぶ
// 人が読む図は CLAUDE.md「依存の向き」にある。ここを変えたら、同じ PR で図も直す。
export const ALLOWED = {
  "@musunest/appspec-schema": [],
  "@musunest/sdk": ["@musunest/appspec-schema"],
  "@musunest/spec-engine": ["@musunest/appspec-schema"],
  "@musunest/app-do": ["@musunest/appspec-schema"],
  "@musunest/control-plane": ["@musunest/appspec-schema", "@musunest/spec-engine"],
  "@musunest/connector": ["@musunest/appspec-schema"],
  "@musunest/data-api": [
    "@musunest/appspec-schema",
    "@musunest/sdk",
    "@musunest/spec-engine",
    "@musunest/app-do",
    "@musunest/control-plane",
  ],
  "@musunest/gateway": ["@musunest/control-plane", "@musunest/data-api"],
  "@musunest/host": ["@musunest/sdk"],
  "@musunest/e2e": ["@musunest/sdk"],
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
