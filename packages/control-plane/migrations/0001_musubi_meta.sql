-- Migration number: 0001 	 2026-09-13T23:16:53.834Z
--
-- _musubi_meta … Control Plane の D1 にマイグレーション機構が通っていることを確かめるための表（03 §7）。
-- M0 ではどのコードもこの表を読み書きしない。
--
-- 前方互換規律（docs/runbook/d1-migration.md §4）に沿った形で書く：
--   - 表を足すだけ。この migration より前のコード（data-api の healthz は SELECT 1 しか打たない）がそのまま動く
--   - updated_at は DEFAULT 付き。書く側は key と value だけで足りる。
--     後から列を足すときは NULL 可か定数の DEFAULT 付きにする（ADD COLUMN では式の DEFAULT が使えない。runbook §4.2）
--
-- 適用は data-api の設定で行う（CONTROL_DB を binding しているのが data-api だけのため）。
--   pnpm exec wrangler d1 migrations apply CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc [--local|--remote]

CREATE TABLE IF NOT EXISTS _musubi_meta (
  key        TEXT NOT NULL PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
