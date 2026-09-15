// host の境界 lint（src/.oxlintrc.json）を、pnpm lint が本当に落とすかを確かめる（Issue #9。apps/gateway/src/lint.test.ts と同じ形）。
//
// 設定を書いただけでは、ルール名の打ち間違い・パターンの不一致・extends や overrides での上書きで黙って空振りする。
// だから違反を書いたファイルを実際に oxlint にかけ、1つずつ落ちることを見る（05 §2「破ると機械が止める」）。
// host の設定は worker/** と app/** の overrides で no-restricted-imports を書き直しているので、
// 「全体の禁止が overrides の側でも生きている」ことを、両方のディレクトリに同じ違反を置いて確かめる。
//
// 本物の src/ に違反を置くと、テストが途中で落ちたときに lint と typecheck を壊して残る。
// そこで一時ディレクトリにリポジトリと同じ形（ルートの .oxlintrc.json と apps/host/src/.oxlintrc.json）を
// 写し、package.json の lint と同じコマンドを apps/host の位置で走らせる。設定の探索まで本物と同じになる。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url).href);
const OXLINT_BIN = join(REPO_ROOT, "node_modules/oxlint/bin/oxlint");

const NO_RESTRICTED_IMPORTS = "eslint(no-restricted-imports)";
const NO_RESTRICTED_TYPES = "typescript(no-restricted-types)";

type Dir = "worker" | "app";

/** 全体の禁止（D1 / R2 / DO・data-api 以下）。worker/** と app/** のどちらでも落ちなければならない。 */
const BOUNDARY: readonly (readonly [name: string, source: string, expected: readonly string[]])[] = [
  [
    "app-do を import する",
    `import { AppInstanceDO } from "@musunest/app-do";\nexport const x = AppInstanceDO;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "cloudflare:workers の env から binding を取る（ルートのルールを上書きで失っていない）",
    `import { env } from "cloudflare:workers";\nexport const x = env;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "data-api の契約を import する（host は data-api 以下を参照しない）",
    `import { HEALTHZ_PATH } from "@musunest/data-api";\nexport const x = HEALTHZ_PATH;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "data-api の adapter を相対パスで import する",
    `import { cloudflareProbes } from "../../../../packages/data-api/src/cloudflare";\nexport const x = cloudflareProbes;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "gateway の中身を相対パスで import する",
    `import { runHealthz } from "../../../gateway/src/healthz";\nexport const x = runHealthz;\n`,
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
    "env に D1 / R2 / DO の binding を型で書く",
    `export interface Env {\n  readonly CONTROL_DB: D1Database;\n  readonly BUNDLES: R2Bucket;\n  readonly APP_DO: DurableObjectNamespace;\n}\n`,
    [NO_RESTRICTED_TYPES, NO_RESTRICTED_TYPES, NO_RESTRICTED_TYPES],
  ],
];

/** ディレクトリ固有の禁止。 */
const SPECIFIC: readonly (readonly [dir: Dir, name: string, source: string, expected: readonly string[]])[] = [
  [
    "worker",
    "React の SSR の描画を持ち込む",
    `import { renderToReadableStream } from "react-dom/server";\nexport const x = renderToReadableStream;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "worker",
    "TanStack Start の server-entry を持ち込む（配る Worker が SSR をする形）",
    `import handler from "@tanstack/react-start/server-entry";\nexport default handler;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "worker",
    "SPA のコード（router）を相対パスで持ち込む",
    `import { getRouter } from "../app/router";\nexport const x = getRouter;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "app",
    "server function を作る（配る Worker には TanStack Start のサーバーが無い）",
    `import { createServerFn } from "@tanstack/react-start";\nexport const x = createServerFn;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
  [
    "app",
    "TanStack Start のサーバー側の API を使う",
    `import { getRequest } from "@tanstack/react-start/server";\nexport const x = getRequest;\n`,
    [NO_RESTRICTED_IMPORTS],
  ],
];

/** 対照。host が正当に書く形は通る。 */
const ALLOWED: Readonly<Record<Dir, string>> = {
  // Worker：自分の契約と Service Binding
  worker: `import { GATEWAY_HEALTHZ_PATH } from "./contract";
export interface Env {
  readonly GATEWAY: Fetcher;
}
export const call = (env: Env): Promise<Response> => env.GATEWAY.fetch(new URL(GATEWAY_HEALTHZ_PATH, "https://gateway.internal"));
`,
  // SPA：TanStack Router と、クライアントで動く TanStack Start の API。Worker の契約（パス）も参照してよい
  app: `import { createFileRoute } from "@tanstack/react-router";
import { createStart } from "@tanstack/react-start";
import { HEALTHZ_PATH } from "../worker/contract";
export const x = [createFileRoute, createStart, HEALTHZ_PATH];
`,
};

interface Fixture {
  readonly file: string;
  readonly source: string;
  readonly expected: readonly string[];
}

const DIRS: readonly Dir[] = ["worker", "app"];

/** 一時ディレクトリの apps/host からの相対パス（oxlint の filename と同じ形） */
const FIXTURES: readonly (readonly [name: string, fixture: Fixture])[] = [
  ...DIRS.flatMap((dir) =>
    BOUNDARY.map(
      ([name, source, expected], index) =>
        [`${dir}/**：${name}`, { file: `src/${dir}/__lint_boundary_${index}.ts`, source, expected }] as const,
    ),
  ),
  ...SPECIFIC.map(
    ([dir, name, source, expected], index) =>
      [`${dir}/**：${name}`, { file: `src/${dir}/__lint_specific_${index}.ts`, source, expected }] as const,
  ),
];

const allowedFileOf = (dir: Dir): string => `src/${dir}/__lint_allowed.ts`;

interface Diagnostic {
  readonly code: string;
  readonly filename: string;
}

describe("src/.oxlintrc.json（host の境界 lint）", () => {
  let root: string;
  let exitCode: number | null;
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "host-lint-"));
    const pkgDir = join(root, "apps/host");
    const write = (file: string, source: string) => {
      mkdirSync(dirname(join(pkgDir, file)), { recursive: true });
      writeFileSync(join(pkgDir, file), source);
    };
    cpSync(join(REPO_ROOT, ".oxlintrc.json"), join(root, ".oxlintrc.json"));
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    cpSync(join(REPO_ROOT, "apps/host/src/.oxlintrc.json"), join(pkgDir, "src/.oxlintrc.json"));
    for (const [, { file, source }] of FIXTURES) write(file, source);
    for (const dir of DIRS) write(allowedFileOf(dir), ALLOWED[dir]);

    // package.json の lint をそのまま使う。形が変わったらこのテストも追随させる。
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/host/package.json"), "utf8")) as {
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

  it.each(FIXTURES)("%s と落ちる", (_, { file, expected }) => {
    const codes = diagnostics.filter((d) => d.filename === file).map((d) => d.code);
    expect(codes).toEqual(expected);
  });

  it.each(DIRS)("%s/** の正当なコードは通る（全部を落とす設定になっていない）", (dir) => {
    expect(diagnostics.filter((d) => d.filename === allowedFileOf(dir))).toEqual([]);
  });
});
