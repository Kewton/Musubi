// deploy-worker と、それを呼ぶ deploy-staging.yml の試験（Issue #15）。**実環境には一切届かない**（動かす wrangler は偽物か、--dry-run の実物だけ）。
//
//   1. 契約：配る Worker の集合が infra:sync の同期先と一致し、host は配る env でビルドされる（turbo・ルートの deploy:*）
//   2. wrangler の呼び方：target ごとの引数と cwd。deploy は --sha が必須
//   3. 伏せる：workers.dev のホスト名と Account ID が、要約にも失敗の全文にも出ない（ANSI で割られていても）
//   4. CLI：偽の wrangler を動かし、出力をファイルに受けてから要約だけを出す。失敗は伏せた全文を出して exit 1。
//      実物の wrangler も --dry-run で1回動かし、要約の行の形が wrangler の出力と食い違っていないかを見る
//      （gateway を配る形。@musubi/data-api の dist を読むので、`pnpm test` は turbo run test の後にここを走らせる）
//   5. deploy-staging.yml：乖離チェック → build → migration → deploy（data-api → gateway → host）→ smoke の順で、
//      資格情報はそれを使うステップにだけ渡し、起動は main への push と手動実行だけ
//
// fixture の値は全部作り物で、他と衝突しない目印にしてある。出力に目印が1つでも混ざったら「伏せ損ねた」と判定する。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXIT_NG,
  EXIT_OK,
  failureLines,
  MIGRATION_CONFIG,
  MIGRATION_DATABASE,
  neutralize,
  redact,
  REDACTED_ACCOUNT,
  REDACTED_HOST,
  runCli,
  summarize,
  TARGETS,
  WORKER_DIRS,
  wranglerCall,
  type CliIo,
} from "./deploy-worker.ts";
import { ENVS, findTargets } from "./sync-bindings.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** 目印。アカウントの workers.dev サブドメインと Account ID の代わり */
const SUBDOMAIN = "fixture-sub-7c2e91";
const ACCOUNT_ID = "fixture-account-id-5b3d80a4e1";
const ACCOUNT_ID_HEX = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const MARKERS = [SUBDOMAIN, ACCOUNT_ID, ACCOUNT_ID_HEX];

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
});

// ── 2. wrangler の呼び方 ──────────────────────────────────────────────────────

describe("wranglerCall：target ごとの wrangler の呼び方", () => {
  it("migrate はリポジトリ直下から data-api の設定の CONTROL_DB に --remote で当てる", () => {
    expect(wranglerCall("migrate", "staging", undefined)).toEqual({
      kind: "migrate",
      cwd: ".",
      args: ["d1", "migrations", "apply", "CONTROL_DB", "--env", "staging", "--config", "packages/data-api/wrangler.jsonc", "--remote"],
    });
  });

  it.each([
    ["data-api", "packages/data-api"],
    ["gateway", "apps/gateway"],
    ["host", "apps/host"],
  ] as const)("%s は %s で wrangler deploy --env <env> --var GIT_SHA:<sha>", (target, cwd) => {
    expect(wranglerCall(target, "production", SHA)).toEqual({
      kind: "deploy",
      cwd,
      args: ["deploy", "--env", "production", "--var", `GIT_SHA:${SHA}`],
    });
  });

  it("deploy は --sha が無ければ失敗する。migrate は --sha を取らない", () => {
    expect(() => wranglerCall("host", "staging", undefined)).toThrow("--target host には --sha が要る");
    expect(() => wranglerCall("migrate", "staging", SHA)).toThrow("--target migrate は --sha を取らない");
  });
});

// ── 3. 伏せる ────────────────────────────────────────────────────────────────

describe("伏せる：workers.dev のホスト名と Account ID", () => {
  it.each([
    ["URL", `https://musubi-staging-host.${SUBDOMAIN}.workers.dev`, `https://${REDACTED_HOST}`],
    ["スキーム無し・大文字", `MUSUBI-STAGING-HOST.${SUBDOMAIN.toUpperCase()}.WORKERS.DEV:443`, `${REDACTED_HOST}:443`],
    ["プレビュー URL", `https://<VERSION_PREFIX>-musubi-staging-host.${SUBDOMAIN}.workers.dev/x`, `https://<VERSION_PREFIX>${REDACTED_HOST}/x`],
    ["サブドメインだけ", `https://${SUBDOMAIN}.workers.dev`, `https://${REDACTED_HOST}`],
    ["色で割られたホスト名", `a.${ESC}[1m${SUBDOMAIN}${ESC}[22m.workers.dev`, REDACTED_HOST],
    ["OSC 8 のリンク", `${ESC}]8;;https://a.${SUBDOMAIN}.workers.dev${BEL}link${ESC}]8;;${BEL}`, "link"],
    ["Account ID の形", `/accounts/${ACCOUNT_ID_HEX}/workers`, `/accounts/${REDACTED_ACCOUNT}/workers`],
    ["CLOUDFLARE_ACCOUNT_ID の値", `/accounts/${ACCOUNT_ID}/workers`, `/accounts/${REDACTED_ACCOUNT}/workers`],
  ])("%s", (_, line, expected) => {
    const redacted = redact(line, ACCOUNT_ID);
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
    // 受けた引数・cwd・環境変数を記録し、指定された出力を標準出力と標準エラーに分けて書き、指定の exit code で終わる
    writeFileSync(
      fake,
      [
        'import { writeFileSync } from "node:fs";',
        "const { FAKE_RECORD, FAKE_STDOUT = '', FAKE_STDERR = '', FAKE_EXIT = '0' } = process.env;",
        "writeFileSync(FAKE_RECORD, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), forceColor: process.env.FORCE_COLOR, stdinIsTTY: process.stdin.isTTY ?? false }));",
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
    record: { args: string[]; cwd: string; forceColor?: string; stdinIsTTY: boolean } | undefined;
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

// ── 5. deploy-staging.yml ───────────────────────────────────────────────────

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

describe("deploy-staging.yml", () => {
  const yaml = readFileSync(join(ROOT, ".github/workflows/deploy-staging.yml"), "utf8");

  /** jobs.deploy.steps の各ステップ（コメント行を除く）。1ステップ＝同じ深さの `- ` から次の `- ` の直前まで。 */
  const steps: Step[] = (() => {
    const lines = code(yaml).split("\n");
    const at = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
    const found: string[][] = [];
    for (const line of lines.slice(at + 1)) {
      if (/^ {6}- /.test(line)) found.push([line]);
      else if (/^ {7,}\S/.test(line) || line.trim() === "") found.at(-1)?.push(line);
      else break;
    }
    return found.map((step) => ({ body: step.join("\n") }));
  })();

  const indexOf = (pattern: RegExp): number => {
    const found = steps.flatMap((step, i) => (pattern.test(step.body) ? [i] : []));
    expect(found, pattern.source).toHaveLength(1);
    return found[0] ?? -1;
  };

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
