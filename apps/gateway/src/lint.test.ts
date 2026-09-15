// 「gateway は D1 / R2 / DO を直接触らない」を lint（pnpm lint）が本当に落とすかを確かめる（Issue #8）。
//
// 設定を書いただけでは、ルール名の打ち間違い・パターンの不一致・extends での上書きで黙って空振りする。
// だから違反を書いたファイルを実際に oxlint にかけ、1つずつ落ちることを見る（05 §2「破ると機械が止める」）。
//
// 本物の src/ に違反を置くと、テストが途中で落ちたときに lint と typecheck を壊して残る。
// そこで一時ディレクトリにリポジトリと同じ形（ルートの .oxlintrc.json と apps/gateway/src/.oxlintrc.json）を
// 写し、package.json の lint と同じコマンドを apps/gateway の位置で走らせる。設定の探索まで本物と同じになる。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url).href);
const OXLINT_BIN = join(REPO_ROOT, "node_modules/oxlint/bin/oxlint");

const NO_RESTRICTED_IMPORTS = "eslint(no-restricted-imports)";
const NO_RESTRICTED_TYPES = "typescript(no-restricted-types)";

/** 違反の見本。ファイルごとに、落ちるべきルールを落ちるべき回数だけ並べる。 */
const VIOLATIONS: readonly (readonly [name: string, source: string, expected: readonly string[]])[] = [
  [
    "app-do を import する（05 §2 の受入で一時 PR に書く形）",
    `import { AppInstanceDO } from "@musunest/app-do";\nexport const x = AppInstanceDO;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "cloudflare:workers の env から binding を取る（ルートのルールを上書きで失っていない）",
    `import { env } from "cloudflare:workers";\nexport const x = env;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "data-api の adapter をパッケージ越しに深く import する",
    `import { cloudflareProbes } from "@musunest/data-api/src/cloudflare";\nexport const x = cloudflareProbes;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "data-api の adapter を相対パスで import する",
    `import { cloudflareProbes } from "../../../packages/data-api/src/cloudflare";\nexport const x = cloudflareProbes;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "S3 互換 API で R2 に触る",
    `import { S3Client } from "@aws-sdk/client-s3";\nimport { AwsClient } from "aws4fetch";\nexport const x = [S3Client, AwsClient];\n`,
    [NO_RESTRICTED_IMPORTS, NO_RESTRICTED_IMPORTS],
  ],
  [
    "workers-types から D1Database を別名で持ち込む",
    `import type { D1Database as Db } from "@cloudflare/workers-types";\nexport type X = Db;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "env に D1 の binding を型で書く",
    `export interface Env {\n  readonly CONTROL_DB: D1Database;\n}\nexport const q = (s: D1PreparedStatement) => s;\n`,
    [NO_RESTRICTED_TYPES, NO_RESTRICTED_TYPES],
  ],
  [
    "env に R2 の binding を型で書く",
    `export interface Env {\n  readonly BUNDLES: R2Bucket;\n}\n`,
    [NO_RESTRICTED_TYPES],
  ],
  [
    "env に DO の binding を型で書き、stub を持ち回す",
    `export interface Env {\n  readonly APP_DO: DurableObjectNamespace;\n}\nexport const s = (stub: DurableObjectStub) => stub;\n`,
    [NO_RESTRICTED_TYPES, NO_RESTRICTED_TYPES],
  ],
];

/** 対照。gateway が正当に書く形（data-api の契約と Service Binding）は通る。 */
const ALLOWED = `import { HEALTHZ_PATH } from "@musunest/data-api";
import type { HealthzBody } from "@musunest/data-api";
export interface Env {
  readonly DATA_API: Fetcher;
}
export const call = (env: Env): Promise<HealthzBody> =>
  env.DATA_API.fetch(new URL(HEALTHZ_PATH, "https://data-api.internal")).then((res) => res.json());
`;

/** 一時ディレクトリの apps/gateway からの相対パス（oxlint の filename と同じ形） */
const fileOf = (index: number): string => `src/__lint_fixture_${index}.ts`;
const ALLOWED_FILE = "src/__lint_allowed.ts";

interface Diagnostic {
  readonly code: string;
  readonly filename: string;
}

describe("src/.oxlintrc.json（gateway の境界 lint）", () => {
  let root: string;
  let exitCode: number | null;
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "gateway-lint-"));
    const pkgDir = join(root, "apps/gateway");
    cpSync(join(REPO_ROOT, ".oxlintrc.json"), join(root, ".oxlintrc.json"));
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "apps/gateway/src/.oxlintrc.json"), join(pkgDir, "src/.oxlintrc.json"));
    VIOLATIONS.forEach(([, source], index) => {
      writeFileSync(join(pkgDir, fileOf(index)), source);
    });
    writeFileSync(join(pkgDir, ALLOWED_FILE), ALLOWED);

    // package.json の lint をそのまま使う。形が変わったらこのテストも追随させる。
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/gateway/package.json"), "utf8")) as {
      scripts: { lint: string };
    };
    const [command, ...args] = pkg.scripts.lint.split(/\s+/);
    expect(command).toBe("oxlint");

    const result = spawnSync(process.execPath, [OXLINT_BIN, ...args, "--format", "json"], {
      cwd: pkgDir,
      encoding: "utf8",
    });
    exitCode = result.status;
    diagnostics = (JSON.parse(result.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
  });

  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("違反があれば exit が非ゼロ（pnpm lint が落ちる）", () => {
    expect(exitCode).not.toBe(0);
  });

  it.each(VIOLATIONS.map(([name, , expected], index) => [name, index, expected] as const))(
    "%s と落ちる",
    (_, index, expected) => {
      const codes = diagnostics.filter((d) => d.filename === fileOf(index)).map((d) => d.code);
      expect(codes).toEqual(expected);
    },
  );

  it("data-api の契約と Service Binding だけを使うコードは通る（全部を落とす設定になっていない）", () => {
    expect(diagnostics.filter((d) => d.filename === ALLOWED_FILE)).toEqual([]);
  });
});
