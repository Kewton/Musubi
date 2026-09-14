// deploy-worker と、それを呼ぶ deploy-staging.yml（Issue #15）・deploy-production.yml（Issue #16）の試験。
// **実環境には一切届かない**（動かす wrangler は偽物か、--dry-run の実物だけ）。
//
//   1. 契約：配る Worker の集合が infra:sync の同期先と一致し、host は配る env でビルドされる（turbo・ルートの deploy:*）。
//      secret（MUSUBI_PROBE_TOKEN）を載せる Worker と env が、host / gateway の wrangler.jsonc の HEALTHZ_DETAIL と一致する
//   2. wrangler の呼び方：target ごとの引数と cwd。deploy は --sha が必須。載せる secret の名前と、値の検査
//   3. 伏せる：workers.dev のホスト名・Account ID・secret の値が、要約にも失敗の全文にも出ない（ANSI で割られていても）
//   4. CLI：偽の wrangler を動かし、出力をファイルに受けてから要約だけを出す。失敗は伏せた全文を出して exit 1。
//      secret は一時ファイル（0600）で --secrets-file に渡し、wrangler が終わったら消す。
//      実物の wrangler も --dry-run で動かし、要約の行の形が wrangler の出力と食い違っていないかを見る
//      （gateway を配る形。@musubi/data-api の dist を読むので、`pnpm test` は turbo run test の後にここを走らせる）
//   5. ワークフロー：乖離チェック → build → migration → deploy（data-api → gateway → host）→ smoke の順で、
//      資格情報はそれを使うステップにだけ渡す。staging は main への push と手動実行、production は v タグと手動実行だけで起動する
//   6. production の資格情報（production 環境の Secret）に届くのは deploy-production.yml だけ。staging のワークフローからは届かない
//
// fixture の値は全部作り物で、他と衝突しない目印にしてある。出力に目印が1つでも混ざったら「伏せ損ねた」と判定する。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROBE_TOKEN_SECRET as HOST_PROBE_TOKEN_SECRET } from "../../apps/host/src/worker/contract.ts";
import {
  EXIT_NG,
  EXIT_OK,
  failureLines,
  MIGRATION_CONFIG,
  MIGRATION_DATABASE,
  neutralize,
  PROBE_TARGETS,
  PROBE_TOKEN_MIN_LENGTH,
  PROBE_TOKEN_SECRET,
  readSecrets,
  redact,
  REDACTED_ACCOUNT,
  REDACTED_HOST,
  REDACTED_SECRET,
  runCli,
  secretsFor,
  summarize,
  TARGETS,
  WORKER_DIRS,
  wranglerCall,
  type CliIo,
  type Target,
} from "./deploy-worker.ts";
import { probeToken } from "./smoke.ts";
import { ENVS, findTargets } from "./sync-bindings.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** 目印。アカウントの workers.dev サブドメインと Account ID の代わり */
const SUBDOMAIN = "fixture-sub-7c2e91";
const ACCOUNT_ID = "fixture-account-id-5b3d80a4e1";
const ACCOUNT_ID_HEX = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
/** 目印。production の gateway と host に載せる MUSUBI_PROBE_TOKEN の代わり（ヘッダに載る文字だけで、下限の長さを満たす） */
const PROBE_TOKEN = "fixture-probe-token-3a9d5e1c7b2f4086";
const MARKERS = [SUBDOMAIN, ACCOUNT_ID, ACCOUNT_ID_HEX, PROBE_TOKEN];

/** 伏せ損ねた目印も、workers.dev のホスト名の形も無い。 */
function expectRedacted(text: string): void {
  for (const marker of MARKERS) expect(text).not.toContain(marker);
  expect(text).not.toMatch(/[a-z0-9_-]+\.workers\.dev/i);
}

/** 行頭（空白の後を含む）が `::` の行が無い。 */
function expectNoWorkflowCommand(lines: readonly string[]): void {
  expect(lines.filter((line) => line.trimStart().startsWith("::"))).toEqual([]);
}

/** wrangler 4.131.1 の `wrangler deploy`（host・staging）の出力の形。配備先の URL と、色付きの警告を含む。 */
const DEPLOY_OUTPUT = [
  "",
  " ⛅️ wrangler 4.131.1",
  "────────────────────",
  "Using redirected Wrangler configuration.",
  ' - Configuration being used: "dist/musubi_dev_host/wrangler.json"',
  "🌀 Building list of assets...",
  "✨ Read 5 files from the assets directory /home/runner/work/Musubi/Musubi/apps/host/dist/client",
  "🌀 Starting asset upload...",
  "+ /index.html",
  "Uploaded 1 of 1 asset",
  "✨ Success! Uploaded 1 file (4 already uploaded) (1.52 sec)",
  "",
  "Total Upload: 7.10 KiB / gzip: 2.86 KiB",
  "Worker Startup Time: 3 ms",
  "Your Worker has access to the following bindings:",
  "Binding                                          Resource                  ",
  "env.GATEWAY (musubi-staging-gateway)             Worker                    ",
  'env.ENVIRONMENT ("staging")                      Environment Variable      ',
  'env.GIT_SHA ("(hidden)")                         Environment Variable      ',
  "",
  `${ESC}[33m▲ ${ESC}[43;33m[${ESC}[43;30mWARNING${ESC}[43;33m]${ESC}[0m ${ESC}[1mYou are enabling the 'workers.dev' subdomain for this Worker, but Preview URLs are still disabled.${ESC}[0m`,
  "  Preview URLs will automatically generate a unique, shareable link for each new version which will be accessible at:",
  `    https://<VERSION_PREFIX>-musubi-staging-host.${SUBDOMAIN}.workers.dev`,
  "",
  `See https://dash.cloudflare.com/${ACCOUNT_ID_HEX}/workers/services/view/musubi-staging-host`,
  "Uploaded musubi-staging-host (4.21 sec)",
  "Deployed musubi-staging-host triggers (0.83 sec)",
  // 色の切り替えがホスト名の途中に入り、OSC 8 のリンクが URL を運ぶ形
  `  ${ESC}]8;;https://musubi-staging-host.${SUBDOMAIN}.workers.dev${BEL}https://musubi-staging-host.${ESC}[1m${SUBDOMAIN}${ESC}[22m.workers.dev${ESC}]8;;${BEL}`,
  "Current Version ID: 0f6c9f7e-1a2b-4c3d-8e9f-0123456789ab",
  "",
].join("\n");

/** `wrangler d1 migrations apply --remote` の出力の形。 */
const MIGRATE_OUTPUT = [
  "",
  " ⛅️ wrangler 4.131.1",
  "────────────────────",
  "Resource location: remote ",
  "",
  "Migrations to be applied:",
  "┌──────────────────────┐",
  "│ name                 │",
  "├──────────────────────┤",
  "│ 0002_fixture.sql     │",
  "└──────────────────────┘",
  "? About to apply 1 migration(s)",
  "Your database may not be available to serve requests during the migration, continue?",
  "🤖 Using fallback value in non-interactive context: yes",
  "🌀 Executing on remote database CONTROL_DB (792a1ec4-1ce4-44a0-9876-fe73d9e113fe):",
  "🌀 To execute on your local development database, remove the --remote flag from your wrangler command.",
  "┌──────────────────────┬────────┐",
  "│ name                 │ status │",
  "├──────────────────────┼────────┤",
  "│ 0002_fixture.sql     │ ✅     │",
  "└──────────────────────┴────────┘",
].join("\n");

/** 失敗した `wrangler deploy` の出力の形。API のパスに Account ID、案内に workers.dev の URL、行頭に `::`。 */
const FAILED_OUTPUT = [
  "",
  " ⛅️ wrangler 4.131.1",
  `${ESC}[31m✘ ${ESC}[41;31m[${ESC}[41;97mERROR${ESC}[41;31m]${ESC}[0m ${ESC}[1mA request to the Cloudflare API (/accounts/${ACCOUNT_ID}/workers/scripts/musubi-staging-host) failed.${ESC}[0m`,
  "  Authentication error [code: 10000]",
  `  You need to register a workers.dev subdomain: https://${SUBDOMAIN}.workers.dev`,
  "::error::injected by a response",
  "  ::add-mask::also injected",
  "",
].join("\r\n");

// ── 1. 契約 ────────────────────────────────────────────────────────────────

describe("契約：配る Worker と、host をどの env でビルドするか", () => {
  it("配る Worker の集合が infra:sync の同期先（apps/* と packages/data-api）と一致する", () => {
    const synced = findTargets(ROOT).map((path) => dirname(path));
    expect(Object.values(WORKER_DIRS).toSorted()).toEqual(synced.toSorted());
  });

  it("D1 マイグレーションの当て先の設定は、全 env に CONTROL_DB を持つ", () => {
    const config = parse(readFileSync(join(ROOT, MIGRATION_CONFIG), "utf8")) as {
      env: Record<string, { d1_databases?: { binding: string; migrations_dir?: string }[] }>;
    };
    for (const env of ENVS) {
      const d1 = config.env[env]?.d1_databases?.find((db) => db.binding === MIGRATION_DATABASE);
      expect(d1?.migrations_dir, env).toBe("../control-plane/migrations");
    }
  });

  it("host の turbo の設定は、build に CLOUDFLARE_ENV を渡し、配備用の設定（.wrangler/deploy）もキャッシュの出力に含める", () => {
    const turbo = parse(readFileSync(join(ROOT, "apps/host/turbo.json"), "utf8")) as {
      extends: string[];
      tasks: { build: { env: string[]; outputs: string[] } };
    };
    expect(turbo.extends).toEqual(["//"]);
    expect(turbo.tasks.build.env).toContain("CLOUDFLARE_ENV");
    // package の outputs はルートの outputs を置き換える。ルートの分も並べておく
    const root = JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")) as { tasks: { build: { outputs: string[] } } };
    expect(turbo.tasks.build.outputs).toEqual(expect.arrayContaining([...root.tasks.build.outputs, ".wrangler/deploy/**"]));
  });

  it.each(["staging", "production"])("ルートの deploy:%s は、配る env と同じ CLOUDFLARE_ENV でビルドする", (env) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts[`deploy:${env}`]).toMatch(new RegExp(`^CLOUDFLARE_ENV=${env} turbo run deploy .* -- --env ${env}$`));
  });

  it("載せる secret の名前は host と gateway の contract の PROBE_TOKEN_SECRET と同じ", () => {
    expect(PROBE_TOKEN_SECRET).toBe(HOST_PROBE_TOKEN_SECRET);
    // gateway の contract は @musubi/data-api を import するので、ここでは文字列で照合する
    expect(readFileSync(join(ROOT, "apps/gateway/src/contract.ts"), "utf8")).toContain(
      `export const PROBE_TOKEN_SECRET = "${PROBE_TOKEN_SECRET}" as const;`,
    );
  });

  it("secret を載せる Worker と env が、wrangler.jsonc で /healthz の詳細を隠す（vars.HEALTHZ_DETAIL が public でない）ものと一致する", () => {
    const hiding = (Object.keys(WORKER_DIRS) as (keyof typeof WORKER_DIRS)[]).flatMap((target) => {
      const config = parse(readFileSync(join(ROOT, WORKER_DIRS[target], "wrangler.jsonc"), "utf8")) as {
        env: Record<string, { vars?: Record<string, string> }>;
      };
      // HEALTHZ_DETAIL を持たない Worker（data-api）は外部ルートを持たず、詳細を隠さない（03 §5）
      if (!ENVS.some((env) => config.env[env]?.vars?.["HEALTHZ_DETAIL"] !== undefined)) return [];
      return ENVS.filter((env) => config.env[env]?.vars?.["HEALTHZ_DETAIL"] !== "public").map((env) => `${target}@${env}`);
    });
    const loaded = TARGETS.flatMap((target) => ENVS.filter((env) => secretsFor(target, env).length > 0).map((env) => `${target}@${env}`));
    expect(loaded.toSorted()).toEqual(hiding.toSorted());
    expect([...PROBE_TARGETS].toSorted()).toEqual(["gateway", "host"]);
  });
});

// ── 2. wrangler の呼び方 ──────────────────────────────────────────────────────

describe("wranglerCall：target ごとの wrangler の呼び方", () => {
  it("migrate はリポジトリ直下から data-api の設定の CONTROL_DB に --remote で当てる。secret は載せない", () => {
    expect(wranglerCall("migrate", "production", undefined)).toEqual({
      kind: "migrate",
      cwd: ".",
      args: ["d1", "migrations", "apply", "CONTROL_DB", "--env", "production", "--config", "packages/data-api/wrangler.jsonc", "--remote"],
      secrets: [],
    });
  });

  it.each([
    ["data-api", "packages/data-api", []],
    ["gateway", "apps/gateway", ["MUSUBI_PROBE_TOKEN"]],
    ["host", "apps/host", ["MUSUBI_PROBE_TOKEN"]],
  ] as const)("%s は %s で wrangler deploy --env production --var GIT_SHA:<sha>。production で載せる secret は %j", (target, cwd, secrets) => {
    expect(wranglerCall(target, "production", SHA)).toEqual({
      kind: "deploy",
      cwd,
      args: ["deploy", "--env", "production", "--var", `GIT_SHA:${SHA}`],
      secrets,
    });
  });

  it.each(["dev", "staging"] as const)("%s では、どの Worker にも secret を載せない（詳細を隠さない env）", (env) => {
    for (const target of TARGETS) {
      expect(secretsFor(target, env), target).toEqual([]);
    }
  });

  it("deploy は --sha が無ければ失敗する。migrate は --sha を取らない", () => {
    expect(() => wranglerCall("host", "staging", undefined)).toThrow("--target host には --sha が要る");
    expect(() => wranglerCall("migrate", "staging", SHA)).toThrow("--target migrate は --sha を取らない");
  });
});

describe("readSecrets：載せる secret の値を環境変数から読む", () => {
  it("値を名前ごとに返す。名前が無ければ何も読まない", () => {
    expect(readSecrets([PROBE_TOKEN_SECRET], { [PROBE_TOKEN_SECRET]: PROBE_TOKEN })).toEqual({ [PROBE_TOKEN_SECRET]: PROBE_TOKEN });
    expect(readSecrets([], { [PROBE_TOKEN_SECRET]: PROBE_TOKEN })).toEqual({});
  });

  it.each([
    ["無い", undefined, "環境変数 MUSUBI_PROBE_TOKEN が要る"],
    ["空（GitHub Actions は無い Secret を空文字にする）", "", "環境変数 MUSUBI_PROBE_TOKEN が要る"],
    ["空白を含む", `${PROBE_TOKEN} x`, "ヘッダに載せられない文字"],
    ["末尾に改行", `${PROBE_TOKEN}\n`, "ヘッダに載せられない文字"],
    ["非 ASCII", `${PROBE_TOKEN}合言葉`, "ヘッダに載せられない文字"],
    ["短すぎる", PROBE_TOKEN.slice(0, PROBE_TOKEN_MIN_LENGTH - 1), `${PROBE_TOKEN_MIN_LENGTH} 文字以上にする`],
  ])("%s なら落とす。値はエラーに出さない", (_, value, message) => {
    let error: unknown;
    try {
      readSecrets([PROBE_TOKEN_SECRET], { [PROBE_TOKEN_SECRET]: value });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const text = (error as Error).message;
    expect(text).toContain(message);
    expect(text).not.toContain(PROBE_TOKEN.slice(0, 12));
  });

  it("deploy-worker が受け付ける値は、smoke が SMOKE_PROBE_TOKEN として受け付ける（同じ値を X-Musubi-Probe に載せる）", () => {
    const value = readSecrets([PROBE_TOKEN_SECRET], { [PROBE_TOKEN_SECRET]: PROBE_TOKEN })[PROBE_TOKEN_SECRET];
    expect(probeToken(value, "production")).toBe(PROBE_TOKEN);
  });
});

// ── 3. 伏せる ────────────────────────────────────────────────────────────────

describe("伏せる：workers.dev のホスト名・Account ID・secret の値", () => {
  /** 32 桁の 16 進の secret（Account ID の形と同じ） */
  const HEX_SECRET = "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5";

  it.each([
    ["URL", `https://musubi-staging-host.${SUBDOMAIN}.workers.dev`, `https://${REDACTED_HOST}`],
    ["スキーム無し・大文字", `MUSUBI-STAGING-HOST.${SUBDOMAIN.toUpperCase()}.WORKERS.DEV:443`, `${REDACTED_HOST}:443`],
    ["プレビュー URL", `https://<VERSION_PREFIX>-musubi-staging-host.${SUBDOMAIN}.workers.dev/x`, `https://<VERSION_PREFIX>${REDACTED_HOST}/x`],
    ["サブドメインだけ", `https://${SUBDOMAIN}.workers.dev`, `https://${REDACTED_HOST}`],
    ["色で割られたホスト名", `a.${ESC}[1m${SUBDOMAIN}${ESC}[22m.workers.dev`, REDACTED_HOST],
    ["OSC 8 のリンク", `${ESC}]8;;https://a.${SUBDOMAIN}.workers.dev${BEL}link${ESC}]8;;${BEL}`, "link"],
    ["Account ID の形", `/accounts/${ACCOUNT_ID_HEX}/workers`, `/accounts/${REDACTED_ACCOUNT}/workers`],
    ["CLOUDFLARE_ACCOUNT_ID の値", `/accounts/${ACCOUNT_ID}/workers`, `/accounts/${REDACTED_ACCOUNT}/workers`],
    ["載せた secret の値", `MUSUBI_PROBE_TOKEN=${PROBE_TOKEN}`, `MUSUBI_PROBE_TOKEN=${REDACTED_SECRET}`],
    ["Account ID の形をした secret の値も secret として伏せる", `x ${HEX_SECRET} y`, `x ${REDACTED_SECRET} y`],
  ])("%s", (_, line, expected) => {
    const redacted = redact(line, ACCOUNT_ID, [PROBE_TOKEN, HEX_SECRET]);
    expect(redacted).toBe(expected);
    expectRedacted(redacted);
  });

  it("workers.dev のホスト名でないもの（'workers.dev' という語・Worker 名・UUID・commit の SHA）は伏せない", () => {
    const line = `the 'workers.dev' route of musubi-staging-host, version 0f6c9f7e-1a2b-4c3d-8e9f-0123456789ab, GIT_SHA:${SHA}`;
    expect(redact(line, ACCOUNT_ID)).toBe(line);
  });

  it("行頭（空白の後を含む）の :: を崩す", () => {
    expect(neutralize("::error::x")).toBe(": :error::x");
    expect(neutralize("  ::add-mask::x")).toBe("  : :add-mask::x");
    expect(neutralize("a ::b")).toBe("a ::b");
  });
});

describe("要約：成功したときは許した行だけを出す", () => {
  it("deploy は配備の要点（アセット・サイズ・binding・配備先・Version ID）を出し、配備先の URL は伏せる", () => {
    const lines = summarize("deploy", DEPLOY_OUTPUT, ACCOUNT_ID);
    expect(lines).toEqual([
      "✨ Success! Uploaded 1 file (4 already uploaded) (1.52 sec)",
      "Total Upload: 7.10 KiB / gzip: 2.86 KiB",
      "Worker Startup Time: 3 ms",
      "Your Worker has access to the following bindings:",
      "Binding                                          Resource                  ",
      "env.GATEWAY (musubi-staging-gateway)             Worker                    ",
      'env.ENVIRONMENT ("staging")                      Environment Variable      ',
      'env.GIT_SHA ("(hidden)")                         Environment Variable      ',
      "▲ [WARNING] You are enabling the 'workers.dev' subdomain for this Worker, but Preview URLs are still disabled.",
      "Uploaded musubi-staging-host (4.21 sec)",
      "Deployed musubi-staging-host triggers (0.83 sec)",
      `  https://${REDACTED_HOST}`,
      "Current Version ID: 0f6c9f7e-1a2b-4c3d-8e9f-0123456789ab",
    ]);
    expectRedacted(lines.join("\n"));
  });

  it("migrate は当てたマイグレーションの表と、当てた先を出す", () => {
    const lines = summarize("migrate", MIGRATE_OUTPUT, ACCOUNT_ID);
    expect(lines).toContain("Migrations to be applied:");
    expect(lines).toContain("│ 0002_fixture.sql     │ ✅     │");
    expect(lines).toContain("🌀 Executing on remote database CONTROL_DB (792a1ec4-1ce4-44a0-9876-fe73d9e113fe):");
    expect(lines).toContain("🤖 Using fallback value in non-interactive context: yes");
    expect(lines).not.toContain("? About to apply 1 migration(s)");
  });

  it("当てるものが無ければ、そう出す", () => {
    expect(summarize("migrate", "Resource location: remote \n\n✅ No migrations to apply!\n")).toEqual([
      "Resource location: remote ",
      "✅ No migrations to apply!",
    ]);
  });
});

describe("失敗：全文を伏せてから出す", () => {
  it("エラーの文言は残し、Account ID・workers.dev のホスト名・ワークフローコマンドは残さない", () => {
    const lines = failureLines(FAILED_OUTPUT, ACCOUNT_ID);
    expect(lines).toContain(
      `✘ [ERROR] A request to the Cloudflare API (/accounts/${REDACTED_ACCOUNT}/workers/scripts/musubi-staging-host) failed.`,
    );
    expect(lines).toContain("  Authentication error [code: 10000]");
    expect(lines).toContain(`  You need to register a workers.dev subdomain: https://${REDACTED_HOST}`);
    expectRedacted(lines.join("\n"));
    expectNoWorkflowCommand(lines);
    expect(lines.join("\n")).not.toContain(ESC);
  });
});

// ── 4. CLI（偽の wrangler）──────────────────────────────────────────────────

describe("CLI：wrangler の出力をファイルに受けてから出す", () => {
  let dir: string;
  let fake: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "deploy-worker-test-"));
    fake = join(dir, "fake-wrangler.mjs");
    // 受けた引数・cwd・環境変数を記録し、指定された出力を標準出力と標準エラーに分けて書き、指定の exit code で終わる。
    // --secrets-file があれば、起動された時点のファイルの中身・パーミッション・置き場のパーミッションも記録する
    writeFileSync(
      fake,
      [
        'import { readFileSync, statSync, writeFileSync } from "node:fs";',
        'import { dirname } from "node:path";',
        "const { FAKE_RECORD, FAKE_STDOUT = '', FAKE_STDERR = '', FAKE_EXIT = '0' } = process.env;",
        "const at = process.argv.indexOf('--secrets-file');",
        "const file = at === -1 ? undefined : process.argv[at + 1];",
        "const secretsFile = file === undefined ? undefined : { path: file, content: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777, dirMode: statSync(dirname(file)).mode & 0o777 };",
        "writeFileSync(FAKE_RECORD, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), forceColor: process.env.FORCE_COLOR, stdinIsTTY: process.stdin.isTTY ?? false, probeTokenEnv: process.env.MUSUBI_PROBE_TOKEN, secretsFile }));",
        "process.stdout.write(Buffer.from(FAKE_STDOUT, 'base64'));",
        "process.stderr.write(Buffer.from(FAKE_STDERR, 'base64'));",
        "process.exitCode = Number(FAKE_EXIT);",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  interface Run {
    code: number;
    out: string[];
    err: string[];
    all: string;
    /** 偽の wrangler が記録したもの。起動されなければ undefined */
    record:
      | {
          args: string[];
          cwd: string;
          forceColor?: string;
          stdinIsTTY: boolean;
          /** 子プロセスに届いた環境変数 MUSUBI_PROBE_TOKEN */
          probeTokenEnv?: string;
          secretsFile?: { path: string; content: string; mode: number; dirMode: number };
        }
      | undefined;
  }

  let seq = 0;
  async function deployWorker(
    argv: readonly string[],
    fakeOutput: { stdout?: string; stderr?: string; exit?: number } = {},
    io: Partial<CliIo> = {},
  ): Promise<Run> {
    const record = join(dir, `record-${++seq}.json`);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      root: ROOT,
      wrangler: [process.execPath, fake],
      ...io,
      env: {
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        RUNNER_TEMP: dir,
        FAKE_RECORD: record,
        FAKE_STDOUT: Buffer.from(fakeOutput.stdout ?? "").toString("base64"),
        FAKE_STDERR: Buffer.from(fakeOutput.stderr ?? "").toString("base64"),
        FAKE_EXIT: String(fakeOutput.exit ?? 0),
        ...io.env,
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    const recorded = existsSync(record) ? (JSON.parse(readFileSync(record, "utf8")) as Run["record"]) : undefined;
    return { code, out, err, all: [...out, ...err].join("\n"), record: recorded };
  }

  it("成功：wrangler を target の cwd で動かし、全文はファイルに、ログには伏せた要約だけを出して exit 0", async () => {
    const run = await deployWorker(["--env", "staging", "--target", "host", "--sha", SHA], {
      stdout: DEPLOY_OUTPUT,
      stderr: `${ESC}[33m▲ [WARNING]${ESC}[0m Worker at https://musubi-staging-host.${SUBDOMAIN}.workers.dev\n`,
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.record).toEqual({
      args: ["deploy", "--env", "staging", "--var", `GIT_SHA:${SHA}`],
      cwd: join(ROOT, "apps/host"),
      forceColor: "0",
      stdinIsTTY: false,
    });

    // ファイルには wrangler の出力がそのまま残る（CI のアーティファクトにしない）
    const log = readFileSync(join(dir, "deploy-worker-staging-host.log"), "utf8");
    expect(log).toContain(`musubi-staging-host.${SUBDOMAIN}.workers.dev`);

    expect(run.out[0]).toBe(`deploy-worker: host（env=staging）: wrangler deploy --env staging --var GIT_SHA:${SHA}（apps/host）`);
    expect(run.out).toContain("  Current Version ID: 0f6c9f7e-1a2b-4c3d-8e9f-0123456789ab");
    expect(run.out).toContain(`  ▲ [WARNING] Worker at https://${REDACTED_HOST}`);
    expect(run.out).not.toContain("  + /index.html");
    expect(run.out.at(-1)).toBe("deploy-worker: OK  host（env=staging）");
    expectRedacted(run.all);
    expectNoWorkflowCommand(run.out);
  });

  it("成功（migrate）：リポジトリ直下で d1 migrations apply を --remote で動かす", async () => {
    const run = await deployWorker(["--env", "staging", "--target", "migrate"], { stdout: MIGRATE_OUTPUT });
    expect(run.code).toBe(EXIT_OK);
    expect(run.record?.args).toEqual(["d1", "migrations", "apply", "CONTROL_DB", "--env", "staging", "--config", MIGRATION_CONFIG, "--remote"]);
    expect(run.record?.cwd).toBe(ROOT);
    expect(run.out).toContain("  │ 0002_fixture.sql     │ ✅     │");
    expect(run.out.at(-1)).toBe("deploy-worker: OK  migrate（env=staging）");
  });

  it("失敗：wrangler が exit 0 以外なら、伏せた全文を出して exit 1", async () => {
    const run = await deployWorker(["--env", "staging", "--target", "gateway", "--sha", SHA], { stderr: FAILED_OUTPUT, exit: 7 });
    expect(run.code).toBe(EXIT_NG);
    expect(run.out).toContain(
      `deploy-worker: wrangler が exit 7 で終わった。出力（${join(dir, "deploy-worker-staging-gateway.log")}）の全文を、workers.dev のホスト名と Account ID を伏せて出す`,
    );
    expect(run.out).toContain("    Authentication error [code: 10000]");
    expect(run.out.at(-1)).toBe("deploy-worker: NG  gateway（env=staging）");
    expectRedacted(run.all);
    expectNoWorkflowCommand(run.out);
  });

  it(
    "実物の wrangler（--dry-run。Cloudflare に届かない）の出力でも、要約が upload の大きさと binding の表を拾う",
    async () => {
      // 引数の末尾に --dry-run を足して、リポジトリの wrangler をそのまま動かす。
      // HOME を一時ディレクトリにし、Cloudflare の資格情報（環境変数・wrangler login）が届かないようにする。
      const bin = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
      const dryRun = join(dir, "dry-run-wrangler.mjs");
      writeFileSync(
        dryRun,
        [
          'import { spawnSync } from "node:child_process";',
          "const result = spawnSync(process.execPath, [process.env.REAL_WRANGLER, ...process.argv.slice(2), '--dry-run'], { stdio: 'inherit' });",
          "process.exitCode = result.status ?? 1;",
        ].join("\n"),
      );
      const run = await deployWorker(["--env", "staging", "--target", "gateway", "--sha", SHA], {}, {
        wrangler: [process.execPath, dryRun],
        env: { PATH: process.env["PATH"], HOME: dir, WRANGLER_SEND_METRICS: "false", REAL_WRANGLER: bin },
      });
      expect(run.code, run.all).toBe(EXIT_OK);
      expect(run.out).toContainEqual(expect.stringMatching(/^ {2}Total Upload: /));
      expect(run.out).toContainEqual(expect.stringMatching(/^ {2}env\.DATA_API \(musubi-staging-data-api\)\s+Worker/));
      // --var で渡した GIT_SHA は設定の "local" を上書きし、wrangler は値を伏せて表示する
      expect(run.out).toContainEqual(expect.stringMatching(/^ {2}env\.GIT_SHA \("\(hidden\)"\)\s+Environment Variable/));
    },
    60_000,
  );

  /** RUNNER_TEMP に残っている secret の一時ディレクトリ */
  const leftoverSecretDirs = (): string[] => readdirSync(dir).filter((name) => name.startsWith("deploy-worker-secrets-"));

  it("production の gateway：MUSUBI_PROBE_TOKEN を一時ファイル（0600）に書いて --secrets-file で渡し、終わったらすぐ消す。値は出さない", async () => {
    const run = await deployWorker(
      ["--env", "production", "--target", "gateway", "--sha", SHA],
      // wrangler が値を出してしまった場合でも伏せる
      { stdout: `Total Upload: 1 KiB\nenv.MUSUBI_PROBE_TOKEN ("${PROBE_TOKEN}")  Environment Variable\n` },
      { env: { [PROBE_TOKEN_SECRET]: PROBE_TOKEN } },
    );
    expect(run.code, run.all).toBe(EXIT_OK);

    const secretsFile = run.record?.secretsFile;
    expect(run.record?.args).toEqual(["deploy", "--env", "production", "--var", `GIT_SHA:${SHA}`, "--secrets-file", secretsFile?.path]);
    expect(run.record?.cwd).toBe(join(ROOT, "apps/gateway"));
    expect(JSON.parse(secretsFile?.content ?? "null")).toEqual({ [PROBE_TOKEN_SECRET]: PROBE_TOKEN });
    expect(secretsFile?.mode).toBe(0o600);
    expect(secretsFile?.dirMode).toBe(0o700);
    expect(dirname(dirname(secretsFile?.path ?? ""))).toBe(dir);
    // 環境変数では渡さない（ファイルで渡す）
    expect(run.record?.probeTokenEnv).toBeUndefined();

    // wrangler が終わったら、ファイルも置き場も残らない
    expect(existsSync(secretsFile?.path ?? "")).toBe(false);
    expect(leftoverSecretDirs()).toEqual([]);

    expect(run.out[0]).toBe(
      `deploy-worker: gateway（env=production）: wrangler deploy --env production --var GIT_SHA:${SHA} --secrets-file <一時ファイル: MUSUBI_PROBE_TOKEN>（apps/gateway）`,
    );
    expect(run.out).toContain(`  env.MUSUBI_PROBE_TOKEN ("${REDACTED_SECRET}")  Environment Variable`);
    expectRedacted(run.all);
  });

  it("production の host：wrangler が失敗しても一時ファイルは消し、伏せた全文を出して exit 1", async () => {
    const run = await deployWorker(
      ["--env", "production", "--target", "host", "--sha", SHA],
      { stderr: `${FAILED_OUTPUT}\r\n  secret: ${PROBE_TOKEN}\r\n`, exit: 1 },
      { env: { [PROBE_TOKEN_SECRET]: PROBE_TOKEN } },
    );
    expect(run.code).toBe(EXIT_NG);
    expect(run.record?.secretsFile?.path).toBeDefined();
    expect(existsSync(run.record?.secretsFile?.path ?? "")).toBe(false);
    expect(leftoverSecretDirs()).toEqual([]);
    expect(run.out).toContain(`    secret: ${REDACTED_SECRET}`);
    expect(run.out.at(-1)).toBe("deploy-worker: NG  host（env=production）");
    expectRedacted(run.all);
  });

  it.each(["gateway", "host"] as const)("production の %s は、MUSUBI_PROBE_TOKEN が無ければ wrangler を起動せずに exit 1", async (target) => {
    for (const env of [{}, { [PROBE_TOKEN_SECRET]: "" }]) {
      const run = await deployWorker(["--env", "production", "--target", target, "--sha", SHA], {}, { env });
      expect(run.code).toBe(EXIT_NG);
      expect(run.record).toBeUndefined();
      expect(run.err[0]).toContain("deploy-worker: 環境変数 MUSUBI_PROBE_TOKEN が要る");
    }
    expect(leftoverSecretDirs()).toEqual([]);
  });

  it("production の host は、MUSUBI_PROBE_TOKEN が短すぎれば wrangler を起動せずに exit 1。値は出さない", async () => {
    const short = PROBE_TOKEN.slice(0, PROBE_TOKEN_MIN_LENGTH - 1);
    const run = await deployWorker(["--env", "production", "--target", "host", "--sha", SHA], {}, { env: { [PROBE_TOKEN_SECRET]: short } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.record).toBeUndefined();
    expect(run.err[0]).toContain("deploy-worker: MUSUBI_PROBE_TOKEN が短すぎる");
    expect(run.all).not.toContain(short);
  });

  it.each([
    ["production の data-api", ["--env", "production", "--target", "data-api", "--sha", SHA]],
    ["production の migrate", ["--env", "production", "--target", "migrate"]],
    ["staging の host", ["--env", "staging", "--target", "host", "--sha", SHA]],
    ["staging の gateway", ["--env", "staging", "--target", "gateway", "--sha", SHA]],
  ])("%s は MUSUBI_PROBE_TOKEN があっても載せず、子プロセスにも渡さない", async (_, argv) => {
    const run = await deployWorker(argv, { stdout: "Total Upload: 1 KiB\n" }, { env: { [PROBE_TOKEN_SECRET]: PROBE_TOKEN } });
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(run.record?.args).not.toContain("--secrets-file");
    expect(run.record?.secretsFile).toBeUndefined();
    expect(run.record?.probeTokenEnv).toBeUndefined();
    expect(run.out[0]).not.toContain("--secrets-file");
    expect(leftoverSecretDirs()).toEqual([]);
  });

  it(
    "実物の wrangler（--dry-run）も production の gateway の --secrets-file を受け付け、secret を (hidden) と表示する",
    async () => {
      const bin = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
      const dryRun = join(dir, "dry-run-wrangler-production.mjs");
      writeFileSync(
        dryRun,
        [
          'import { spawnSync } from "node:child_process";',
          "const result = spawnSync(process.execPath, [process.env.REAL_WRANGLER, ...process.argv.slice(2), '--dry-run'], { stdio: 'inherit' });",
          "process.exitCode = result.status ?? 1;",
        ].join("\n"),
      );
      const run = await deployWorker(["--env", "production", "--target", "gateway", "--sha", SHA], {}, {
        wrangler: [process.execPath, dryRun],
        env: { PATH: process.env["PATH"], HOME: dir, WRANGLER_SEND_METRICS: "false", REAL_WRANGLER: bin, [PROBE_TOKEN_SECRET]: PROBE_TOKEN },
      });
      expect(run.code, run.all).toBe(EXIT_OK);
      expect(run.out).toContainEqual(expect.stringMatching(/^ {2}env\.DATA_API \(musubi-production-data-api\)\s+Worker/));
      expect(run.out).toContainEqual(expect.stringMatching(/^ {2}env\.MUSUBI_PROBE_TOKEN \("\(hidden\)"\)\s+Environment Variable/));
      expectRedacted(run.all);
      expect(leftoverSecretDirs()).toEqual([]);
    },
    60_000,
  );

  it("--log-dir は RUNNER_TEMP より優先する", async () => {
    const logDir = join(dir, "logs");
    const run = await deployWorker(["--env", "dev", "--target", "data-api", "--sha", SHA, "--log-dir", logDir], { stdout: "Total Upload: 1 KiB\n" });
    expect(run.code).toBe(EXIT_OK);
    expect(readFileSync(join(logDir, "deploy-worker-dev-data-api.log"), "utf8")).toBe("Total Upload: 1 KiB\n");
  });

  it("wrangler を起動できなければ exit 1", async () => {
    const run = await deployWorker(["--env", "staging", "--target", "host", "--sha", SHA], {}, { wrangler: [join(dir, "no-such-wrangler")] });
    expect(run.code).toBe(EXIT_NG);
    expect(run.err).toEqual(["deploy-worker: wrangler を起動できない（ENOENT）"]);
  });

  it.each([
    ["--env が無い", ["--target", "host", "--sha", SHA], "--env が無い"],
    ["未知の env（値を出さない）", ["--env", SUBDOMAIN, "--target", "host", "--sha", SHA], "未知の env"],
    ["--target が無い", ["--env", "staging", "--sha", SHA], "--target が無い"],
    ["未知の target（値を出さない）", ["--env", "staging", "--target", SUBDOMAIN, "--sha", SHA], "未知の target"],
    ["deploy に --sha が無い", ["--env", "staging", "--target", "data-api"], "--target data-api には --sha が要る"],
    ["--sha が SHA でない（値を出さない）", ["--env", "staging", "--target", "host", "--sha", SUBDOMAIN], "--sha は 7〜40 桁の 16 進"],
    ["migrate に --sha", ["--env", "staging", "--target", "migrate", "--sha", SHA], "--target migrate は --sha を取らない"],
    ["位置引数（値を出さない）", ["--env", "staging", "--target", "host", SUBDOMAIN], "引数が不正: 位置引数は取らない"],
  ])("引数の誤り（%s）は wrangler を起動せずに exit 1", async (_, argv, message) => {
    const run = await deployWorker(argv);
    expect(run.code).toBe(EXIT_NG);
    expect(run.record).toBeUndefined();
    expect(run.err[0]).toContain(`deploy-worker: ${message}`);
    expectRedacted(run.all);
  });

  it("--help は使い方を出して exit 0。wrangler を起動しない", async () => {
    const run = await deployWorker(["--help"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.record).toBeUndefined();
    expect(run.out[0]).toMatch(/^usage: pnpm exec tsx infra\/scripts\/deploy-worker\.ts --env <dev\|staging\|production> --target <migrate\|data-api\|gateway\|host>/);
  });
});

// ── 5. ワークフロー（deploy-staging.yml・deploy-production.yml）─────────────────────

/** YAML のコメント行を除いた本文 */
const code = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

interface Step {
  readonly body: string;
}

/** ステップの env に Secret の値を渡しているか（前提の確認の `!= ''` のような式での比較は、値を渡さないので数えない）。 */
const passes = (step: Step, secret: string): boolean => new RegExp(String.raw`\$\{\{\s*secrets\.${secret}\s*\}\}`).test(step.body);

/** ステップの env で、環境変数 name に Secret secret の値を渡しているか。 */
const passesAs = (step: Step, name: string, secret: string): boolean =>
  new RegExp(String.raw`^\s+${name}: \$\{\{\s*secrets\.${secret}\s*\}\}$`, "m").test(step.body);

/** ステップの `run: |` の本文（字下げを外したもの）。 */
const runScript = (step: Step): string => {
  const lines = step.body.split("\n");
  const at = lines.findIndex((line) => /^\s+run: \|$/.test(line));
  const body = lines.slice(at + 1).filter((line) => line.trim() !== "");
  const indent = Math.min(...body.map((line) => line.length - line.trimStart().length));
  return body.map((line) => line.slice(indent)).join("\n");
};

interface Workflow {
  /** ファイルの全文 */
  readonly yaml: string;
  /** jobs.deploy.steps の各ステップ（コメント行を除く） */
  readonly steps: readonly Step[];
  /** pattern に当たるステップがちょうど1つあり、その位置を返す */
  readonly indexOf: (pattern: RegExp) => number;
}

function readWorkflow(file: string): Workflow {
  const yaml = readFileSync(join(ROOT, ".github/workflows", file), "utf8");
  // 1ステップ＝同じ深さの `- ` から次の `- ` の直前まで
  const lines = code(yaml).split("\n");
  const at = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  const found: string[][] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^ {6}- /.test(line)) found.push([line]);
    else if (/^ {7,}\S/.test(line) || line.trim() === "") found.at(-1)?.push(line);
    else break;
  }
  const steps = found.map((step) => ({ body: step.join("\n") }));
  const indexOf = (pattern: RegExp): number => {
    const hits = steps.flatMap((step, i) => (pattern.test(step.body) ? [i] : []));
    expect(hits, pattern.source).toHaveLength(1);
    return hits[0] ?? -1;
  };
  return { yaml, steps, indexOf };
}

/** 前提の確認のスクリプトを、GitHub Actions の既定のシェル（bash -eo pipefail）で動かす。 */
function runPreflight(step: Step, env: Record<string, string>): { code: number; output: string } {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", runScript(step)], {
    env: { PATH: process.env["PATH"], ...env },
    encoding: "utf8",
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

describe("deploy-staging.yml", () => {
  const { yaml, steps, indexOf } = readWorkflow("deploy-staging.yml");

  it("起動は main への push と手動実行だけ。schedule と pull_request では起動しない", () => {
    expect(code(yaml)).toMatch(/^on:\n {2}push: \{ branches: \[main\] \}\n {2}workflow_dispatch:\n/m);
    expect(code(yaml)).not.toMatch(/schedule|pull_request/);
  });

  it("手動実行でも main 以外からは配らない（最初のステップで落とす）", () => {
    expect(steps[0]?.body).toContain('if [ "$REF" != refs/heads/main ]; then');
    expect(steps[0]?.body).toContain("REF: ${{ github.ref }}");
  });

  it("concurrency は取り消さない。permissions は読み取りだけ", () => {
    expect(code(yaml)).toContain("concurrency: { group: deploy-staging, cancel-in-progress: false }");
    expect(code(yaml)).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(code(yaml)).not.toMatch(/: write\b/);
  });

  it("staging 環境を宣言し（SMOKE_BASE_URL は staging 環境の Secret）、url は書かない", () => {
    expect(code(yaml)).toMatch(/^ {4}environment: staging$/m);
    expect(code(yaml)).not.toMatch(/^\s+url:/m);
  });

  it("乖離チェック → build → migration → deploy（data-api → gateway → host）→ smoke → 所要時間 の順に1回ずつ呼ぶ", () => {
    const order = [
      indexOf(/refs\/heads\/main/),
      indexOf(/pnpm install --frozen-lockfile/),
      indexOf(/terraform -chdir=infra\/terraform\/envs\/staging init/),
      indexOf(/pnpm infra:sync --env staging --check/),
      indexOf(/pnpm build/),
      indexOf(/deploy-worker\.ts --env staging --target migrate$/m),
      indexOf(/deploy-worker\.ts --env staging --target data-api --sha "\$GIT_SHA"$/m),
      indexOf(/deploy-worker\.ts --env staging --target gateway --sha "\$GIT_SHA"$/m),
      indexOf(/deploy-worker\.ts --env staging --target host --sha "\$GIT_SHA"$/m),
      indexOf(/pnpm smoke --env staging --expect-sha "\$GIT_SHA"$/m),
      indexOf(/repository\.pushed_at/),
    ];
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(steps.filter((step) => /deploy-worker\.ts/.test(step.body))).toHaveLength(TARGETS.length);
  });

  it("wrangler を直接呼ばない（出力をそのまま流さない）。smoke に --base-url を渡さない", () => {
    for (const step of steps) {
      expect(step.body).not.toMatch(/(?:^|\s)wrangler\s/m);
      expect(step.body).not.toContain("--base-url");
    }
  });

  it("host は CLOUDFLARE_ENV=staging でビルドする", () => {
    expect(steps[indexOf(/pnpm build/)]?.body).toMatch(/env:\n\s+CLOUDFLARE_ENV: staging\n/);
  });

  it("GIT_SHA は commit の SHA を環境変数で渡す", () => {
    for (const step of steps.filter((s) => /"\$GIT_SHA"/.test(s.body))) {
      expect(step.body).toContain("GIT_SHA: ${{ github.sha }}");
    }
  });

  it("Cloudflare のトークンと Account ID は、wrangler を動かすステップ（deploy-worker）にだけ渡す", () => {
    for (const step of steps) {
      const usesWrangler = /deploy-worker\.ts/.test(step.body);
      expect(passes(step, "CLOUDFLARE_API_TOKEN"), step.body).toBe(usesWrangler);
      expect(passes(step, "CLOUDFLARE_ACCOUNT_ID"), step.body).toBe(usesWrangler);
    }
  });

  it("tfstate の backend（R2）の3つは乖離チェックにだけ渡し、init の出力は stderr ごと捨てる", () => {
    for (const step of steps) {
      const drift = /pnpm infra:sync/.test(step.body);
      for (const secret of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_S3_ENDPOINT"]) {
        expect(passes(step, secret), `${secret}\n${step.body}`).toBe(drift);
      }
    }
    expect(steps[indexOf(/pnpm infra:sync/)]?.body).toMatch(/terraform -chdir=infra\/terraform\/envs\/staging init .*> \/dev\/null 2>&1/);
  });

  it("SMOKE_BASE_URL は smoke のステップにだけ渡す", () => {
    for (const step of steps) {
      expect(passes(step, "SMOKE_BASE_URL"), step.body).toBe(/pnpm smoke/.test(step.body));
    }
  });

  it("Secret はステップの env にだけ置き（ジョブ・ワークフローの env に置かない）、vars を使わない", () => {
    const beforeSteps = code(yaml).split(/^ {4}steps:$/m)[0] ?? "";
    expect(beforeSteps).not.toContain("secrets.");
    expect(code(yaml)).not.toMatch(/\bvars\./);
  });

  it("前提の確認は、渡している Secret を全部、値ではなく空かどうかだけで見る", () => {
    const passed = new Set([...code(yaml).matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
    const preflight = steps[0]?.body ?? "";
    for (const secret of passed) {
      expect(preflight).toContain(`HAS_${secret}: \${{ secrets.${secret} != '' }}`);
    }
    expect(passes({ body: preflight }, "[A-Z0-9_]+")).toBe(false);
  });
});

/** deploy-worker を production に対して動かすステップの target。 */
const deployWorkerTarget = (step: Step): Target | undefined =>
  TARGETS.find((target) => new RegExp(String.raw`deploy-worker\.ts --env production --target ${target}(?:\s|$)`).test(step.body));

describe("deploy-production.yml", () => {
  const { yaml, steps, indexOf } = readWorkflow("deploy-production.yml");

  it("起動は v タグの push と手動実行だけ。ブランチ・schedule・pull_request では起動しない", () => {
    expect(code(yaml)).toMatch(/^on:\n {2}push: \{ tags: \['v\*'\] \}\n {2}workflow_dispatch:\n\n/m);
    expect(code(yaml)).not.toMatch(/schedule|pull_request|branches/);
  });

  it("手動実行でも v タグ以外からは配らない（最初のステップで落とす）", () => {
    const preflight = steps[0];
    expect(preflight?.body).toContain("REF: ${{ github.ref }}");
    const allSet = Object.fromEntries(
      [...(preflight?.body ?? "").matchAll(/^\s+(HAS_[A-Z0-9_]+):/gm)].map((m) => [m[1] ?? "", "true"]),
    );
    expect(Object.keys(allSet).length).toBeGreaterThan(0);

    expect(runPreflight(preflight ?? { body: "" }, { ...allSet, REF: "refs/tags/v0.1.0" }).code).toBe(0);
    for (const ref of ["refs/heads/main", "refs/heads/feat/16-x", "refs/tags/0.1.0", "refs/pull/1/merge"]) {
      const run = runPreflight(preflight ?? { body: "" }, { ...allSet, REF: ref });
      expect(run.code, ref).toBe(1);
      expect(run.output).toContain("::error::production へ配るのは v タグだけ");
    }
  });

  it("前提の確認は Secret が1つでも空なら、名前を挙げて落とす（値は受け取らない）", () => {
    const preflight = steps[0] ?? { body: "" };
    const names = [...preflight.body.matchAll(/^\s+HAS_([A-Z0-9_]+):/gm)].map((m) => m[1] ?? "");
    expect(names.toSorted()).toEqual(
      ["CLOUDFLARE_ACCOUNT_ID_PROD", "CLOUDFLARE_API_TOKEN_PROD", "MUSUBI_PROBE_TOKEN", "R2_ACCESS_KEY_ID", "R2_S3_ENDPOINT", "R2_SECRET_ACCESS_KEY", "SMOKE_BASE_URL"],
    );
    for (const missing of names) {
      const env = Object.fromEntries(names.map((name) => [`HAS_${name}`, name === missing ? "false" : "true"]));
      const run = runPreflight(preflight, { ...env, REF: "refs/tags/v0.1.0" });
      expect(run.code, missing).toBe(1);
      expect(run.output).toContain(`::error::${missing} が空`);
    }
  });

  it("concurrency は取り消さない。permissions は読み取りだけ", () => {
    expect(code(yaml)).toContain("concurrency: { group: deploy-production, cancel-in-progress: false }");
    expect(code(yaml)).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(code(yaml)).not.toMatch(/: write\b/);
  });

  it("production 環境を宣言し（承認待ちと本番の Secret はここから）、url は書かない", () => {
    expect(code(yaml)).toMatch(/^ {4}environment: production$/m);
    expect(code(yaml).match(/environment:/g)).toHaveLength(1);
    expect(code(yaml)).not.toMatch(/^\s+url:/m);
  });

  it("乖離チェック → build → migration → deploy（data-api → gateway → host）→ smoke の順に1回ずつ呼ぶ", () => {
    const order = [
      indexOf(/refs\/tags\/v\*/),
      indexOf(/pnpm install --frozen-lockfile/),
      indexOf(/terraform -chdir=infra\/terraform\/envs\/production init/),
      indexOf(/pnpm infra:sync --env production --check/),
      indexOf(/pnpm build/),
      indexOf(/deploy-worker\.ts --env production --target migrate$/m),
      indexOf(/deploy-worker\.ts --env production --target data-api --sha "\$GIT_SHA"$/m),
      indexOf(/deploy-worker\.ts --env production --target gateway --sha "\$GIT_SHA"$/m),
      indexOf(/deploy-worker\.ts --env production --target host --sha "\$GIT_SHA"$/m),
      indexOf(/pnpm smoke --env production --expect-sha "\$GIT_SHA"$/m),
    ];
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(steps.filter((step) => /deploy-worker\.ts/.test(step.body))).toHaveLength(TARGETS.length);
    expect(code(yaml)).not.toMatch(/--env (?:dev|staging)\b|envs\/(?:dev|staging)\b/);
  });

  it("wrangler を直接呼ばない。smoke に --base-url を渡さない。secret の値をコマンド行やファイルに書かない（deploy-worker に任せる）", () => {
    for (const step of steps) {
      expect(step.body).not.toMatch(/(?:^|\s)wrangler\s/m);
      expect(step.body).not.toContain("--base-url");
      expect(step.body).not.toContain("--secrets-file");
      expect(step.body).not.toMatch(/\$\{?(?:MUSUBI_PROBE_TOKEN|SMOKE_PROBE_TOKEN)\b/);
    }
  });

  it("terraform plan / apply を production に対して行わない。TF_CLOUDFLARE_API_TOKEN_PROD を使わない", () => {
    expect(code(yaml)).not.toMatch(/terraform\b.*\b(?:plan|apply|destroy|import)\b/);
    expect(code(yaml)).not.toContain("TF_CLOUDFLARE_API_TOKEN");
  });

  it("host は CLOUDFLARE_ENV=production でビルドする", () => {
    expect(steps[indexOf(/pnpm build/)]?.body).toMatch(/env:\n\s+CLOUDFLARE_ENV: production\n/);
  });

  it("GIT_SHA は commit の SHA を環境変数で渡す", () => {
    for (const step of steps.filter((s) => /"\$GIT_SHA"/.test(s.body))) {
      expect(step.body).toContain("GIT_SHA: ${{ github.sha }}");
    }
  });

  it("Cloudflare のトークンと Account ID は production 環境の *_PROD（アカウント②）を、wrangler を動かすステップ（deploy-worker）にだけ渡す", () => {
    for (const step of steps) {
      const usesWrangler = /deploy-worker\.ts/.test(step.body);
      expect(passesAs(step, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_PROD"), step.body).toBe(usesWrangler);
      expect(passesAs(step, "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID_PROD"), step.body).toBe(usesWrangler);
      // アカウント①（staging）のトークンと Account ID は、どのステップにも渡さない
      expect(passes(step, "CLOUDFLARE_API_TOKEN"), step.body).toBe(false);
      expect(passes(step, "CLOUDFLARE_ACCOUNT_ID"), step.body).toBe(false);
    }
  });

  it("tfstate の backend（R2）の3つは乖離チェックにだけ渡し、init の出力は stderr ごと捨てる。乖離チェックに Cloudflare のトークンを渡さない", () => {
    for (const step of steps) {
      const drift = /pnpm infra:sync/.test(step.body);
      for (const secret of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_S3_ENDPOINT"]) {
        expect(passes(step, secret), `${secret}\n${step.body}`).toBe(drift);
      }
    }
    const drift = steps[indexOf(/pnpm infra:sync/)]?.body ?? "";
    expect(drift).toMatch(/terraform -chdir=infra\/terraform\/envs\/production init .*> \/dev\/null 2>&1/);
    expect(drift).not.toContain("CLOUDFLARE_");
  });

  it("MUSUBI_PROBE_TOKEN は、secret を載せる deploy（gateway・host）と smoke（SMOKE_PROBE_TOKEN として）にだけ渡す", () => {
    const withToken: string[] = [];
    for (const step of steps) {
      const target = deployWorkerTarget(step);
      const deploysSecret = target !== undefined && secretsFor(target, "production").includes(PROBE_TOKEN_SECRET);
      const smoke = /pnpm smoke/.test(step.body);
      expect(passes(step, "MUSUBI_PROBE_TOKEN"), step.body).toBe(deploysSecret || smoke);
      expect(passesAs(step, "MUSUBI_PROBE_TOKEN", "MUSUBI_PROBE_TOKEN"), step.body).toBe(deploysSecret);
      expect(passesAs(step, "SMOKE_PROBE_TOKEN", "MUSUBI_PROBE_TOKEN"), step.body).toBe(smoke);
      if (deploysSecret) withToken.push(target);
    }
    expect(withToken).toEqual(["gateway", "host"]);
  });

  it("SMOKE_BASE_URL は smoke のステップにだけ渡す", () => {
    for (const step of steps) {
      expect(passes(step, "SMOKE_BASE_URL"), step.body).toBe(/pnpm smoke/.test(step.body));
    }
  });

  it("Secret はステップの env にだけ置き（ジョブ・ワークフローの env に置かない）、vars を使わない", () => {
    const beforeSteps = code(yaml).split(/^ {4}steps:$/m)[0] ?? "";
    expect(beforeSteps).not.toContain("secrets");
    expect(code(yaml)).not.toMatch(/\bvars\./);
    expect(code(yaml)).not.toMatch(/secrets\[|toJSON\(\s*secrets/);
  });

  it("前提の確認は、渡している Secret を全部、値ではなく空かどうかだけで見る", () => {
    const passed = new Set([...code(yaml).matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
    const preflight = steps[0]?.body ?? "";
    for (const secret of passed) {
      expect(preflight).toContain(`HAS_${secret}: \${{ secrets.${secret} != '' }}`);
    }
    expect(passes({ body: preflight }, "[A-Z0-9_]+")).toBe(false);
  });
});

// ── 6. staging から production の資格情報に手が届かない ─────────────────────────────

describe("production の資格情報に届くのは deploy-production.yml だけ", () => {
  /** production 環境にだけ置く Secret（CLAUDE.md「資格情報の置き場所」）。SMOKE_BASE_URL は staging 環境にも同じ名前で置くので含めない */
  const PRODUCTION_SECRETS = ["CLOUDFLARE_API_TOKEN_PROD", "CLOUDFLARE_ACCOUNT_ID_PROD", "MUSUBI_PROBE_TOKEN", "TF_CLOUDFLARE_API_TOKEN_PROD"];
  const files = readdirSync(join(ROOT, ".github/workflows")).filter((file) => /\.ya?ml$/.test(file));

  it("ワークフローの一覧に deploy-staging.yml と deploy-production.yml がある", () => {
    expect(files).toEqual(expect.arrayContaining(["deploy-staging.yml", "deploy-production.yml"]));
  });

  it("deploy-staging.yml は production 環境の Secret の名前を1つも書かず（式での比較も含む）、SMOKE_PROBE_TOKEN も渡さない", () => {
    const staging = code(readFileSync(join(ROOT, ".github/workflows/deploy-staging.yml"), "utf8"));
    for (const secret of [...PRODUCTION_SECRETS, "SMOKE_PROBE_TOKEN"]) {
      expect(staging).not.toContain(secret);
    }
    expect(staging).not.toMatch(/secrets\[|toJSON\(\s*secrets/);
  });

  it.each(files.filter((file) => file !== "deploy-production.yml"))(
    "%s は production 環境を宣言せず、production 環境の Secret の名前を書かない",
    (file) => {
      const body = code(readFileSync(join(ROOT, ".github/workflows", file), "utf8"));
      // `environment: production`・`environment: { name: production }`・`environment:` の次の行の `name: production`
      expect(body).not.toMatch(/environment:\s*(?:\{\s*name:\s*)?['"]?production\b/);
      expect(body).not.toMatch(/environment:\s*\n\s+name:\s*['"]?production\b/);
      expect(body).not.toMatch(/environment:\s*\$\{\{/);
      for (const secret of PRODUCTION_SECRETS) {
        expect(body, secret).not.toContain(secret);
      }
    },
  );
});
