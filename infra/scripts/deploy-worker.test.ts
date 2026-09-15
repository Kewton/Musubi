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
//   6. production の資格情報（production 環境の Secret）に届くのは deploy-production.yml と rollback.yml だけ。staging のワークフローからは届かない
//   7. 巻き戻し（--rollback-to・Issue #17）：版の JSON の読み方、切り替え先と順の決め方、偽の wrangler で読む → 切り替える → 確かめる、
//      実物の wrangler が呼び方を受け付けること（資格情報を渡さず、認証の手前で止まる）、rollback.yml の形
//   8. dev の貫通スモーク（--smoke・Issue #67）：偽の fetch で、サブドメインを読んで host のオリジンを組み立て、smoke の判定に渡す。
//      宛先・サブドメイン・トークンを出さない。dev 以外・production のアカウントは API を呼ばずに止める
//   9. reproduce-dev.sh（試験A・Issue #67）：偽の terraform と pnpm を PATH の先頭に置いて流す。段の並び、段ごとの資格情報の渡し方
//      （production の資格情報はどの段にも届かない）、出力に値が出ないこと、落ちたらそこで止まること、所要時間を出すこと
//
// fixture の値は全部作り物で、他と衝突しない目印にしてある。出力に目印が1つでも混ざったら「伏せ損ねた」と判定する。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  hostOrigin,
  matchesSha,
  MIGRATION_CONFIG,
  MIGRATION_DATABASE,
  neutralize,
  parseCurrentVersion,
  parseSubdomain,
  parseVersionDetail,
  parseVersionList,
  planRollback,
  PROBE_TARGETS,
  PROBE_TOKEN_MIN_LENGTH,
  PROBE_TOKEN_SECRET,
  readApiCredentials,
  readCall,
  readSecrets,
  redact,
  REDACTED_ACCOUNT,
  REDACTED_EMAIL,
  REDACTED_HOST,
  REDACTED_SECRET,
  ROLLBACK_MESSAGE,
  rollbackCall,
  runCli,
  secretsFor,
  SMOKE_ENVS,
  summarize,
  SWITCH_ORDER,
  TARGETS,
  VERSIONS_LISTED,
  WORKER_DIRS,
  workerName,
  wranglerCall,
  type CliIo,
  type Target,
  type VersionDetail,
  type WorkerTarget,
  type WorkerVersions,
} from "./deploy-worker.ts";
import { healthzUrl, PROBE_HEADER, PROBE_REQUIRED_ENVS, probeToken, PROBE_TOKEN_ENV, type RetryPolicy } from "./smoke.ts";
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
/** 目印。版とデプロイの記録（wrangler versions / deployments の --json）に載る author_email の代わり */
const AUTHOR_EMAIL = "fixture-author-6e2b@example.com";
const MARKERS = [SUBDOMAIN, ACCOUNT_ID, ACCOUNT_ID_HEX, PROBE_TOKEN, AUTHOR_EMAIL];

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

  // dev へ配る（reproduce-dev.sh の ④。試験A）。host は vite build の出力を配るので、ここでは build の要らない2つを見る
  it.each([
    ["data-api", /^ {2}env\.BUNDLES \(musubi-dev-bundles\)\s+R2 Bucket/],
    ["gateway", /^ {2}env\.DATA_API \(musubi-dev-data-api\)\s+Worker/],
  ] as const)(
    "実物の wrangler（--dry-run）で dev の %s も同じ形で配れ、要約が dev の binding を拾う。secret は載せない",
    async (target, binding) => {
      const bin = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
      const dryRun = join(dir, "dry-run-wrangler-dev.mjs");
      writeFileSync(
        dryRun,
        [
          'import { spawnSync } from "node:child_process";',
          "const result = spawnSync(process.execPath, [process.env.REAL_WRANGLER, ...process.argv.slice(2), '--dry-run'], { stdio: 'inherit' });",
          "process.exitCode = result.status ?? 1;",
        ].join("\n"),
      );
      const run = await deployWorker(["--env", "dev", "--target", target, "--sha", SHA], {}, {
        wrangler: [process.execPath, dryRun],
        env: { PATH: process.env["PATH"], HOME: dir, WRANGLER_SEND_METRICS: "false", REAL_WRANGLER: bin, [PROBE_TOKEN_SECRET]: PROBE_TOKEN },
      });
      expect(run.code, run.all).toBe(EXIT_OK);
      expect(run.out[0]).toBe(`deploy-worker: ${target}（env=dev）: wrangler deploy --env dev --var GIT_SHA:${SHA}（${WORKER_DIRS[target]}）`);
      expect(run.out).toContainEqual(expect.stringMatching(binding));
      expect(run.out).toContainEqual(expect.stringMatching(/^ {2}env\.GIT_SHA \("\(hidden\)"\)\s+Environment Variable/));
      expectRedacted(run.all);
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

describe("production の資格情報に届くのは deploy-production.yml と rollback.yml だけ", () => {
  /** production 環境にだけ置く Secret（CLAUDE.md「資格情報の置き場所」）。SMOKE_BASE_URL は staging 環境にも同じ名前で置くので含めない */
  const PRODUCTION_SECRETS = ["CLOUDFLARE_API_TOKEN_PROD", "CLOUDFLARE_ACCOUNT_ID_PROD", "MUSUBI_PROBE_TOKEN", "TF_CLOUDFLARE_API_TOKEN_PROD"];
  /** production 環境を宣言してよいワークフロー。どちらも v* タグからしか動けず、必須レビュワーの承認が要る（04 §5・§6.1） */
  const PRODUCTION_WORKFLOWS = ["deploy-production.yml", "rollback.yml"];
  const files = readdirSync(join(ROOT, ".github/workflows")).filter((file) => /\.ya?ml$/.test(file));

  it("ワークフローの一覧に deploy-staging.yml・deploy-production.yml・rollback.yml がある", () => {
    expect(files).toEqual(expect.arrayContaining(["deploy-staging.yml", ...PRODUCTION_WORKFLOWS]));
  });

  it("deploy-staging.yml は production 環境の Secret の名前を1つも書かず（式での比較も含む）、SMOKE_PROBE_TOKEN も渡さない", () => {
    const staging = code(readFileSync(join(ROOT, ".github/workflows/deploy-staging.yml"), "utf8"));
    for (const secret of [...PRODUCTION_SECRETS, "SMOKE_PROBE_TOKEN"]) {
      expect(staging).not.toContain(secret);
    }
    expect(staging).not.toMatch(/secrets\[|toJSON\(\s*secrets/);
  });

  it.each(files.filter((file) => !PRODUCTION_WORKFLOWS.includes(file)))(
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

// ── 7. 巻き戻し（--rollback-to・rollback.yml）──────────────────────────────────────

/** 作り物の commit。OLD → NEW → NEWER の順に production へ出た */
const SHA_OLD = "a1".repeat(20);
const SHA_NEW = "b2".repeat(20);
const SHA_NEWER = "c3".repeat(20);

interface Release {
  readonly sha: string | undefined;
  readonly at: string;
}

/** 1つ前のリリース（OLD）と今のリリース（NEW） */
const RELEASES: readonly Release[] = [
  { sha: SHA_OLD, at: "2026-09-14T14:25:00.000000Z" },
  { sha: SHA_NEW, at: "2026-09-15T01:00:00.000000Z" },
];

/** Worker の番号（SWITCH_ORDER.forward の位置）と、何番目に配った版か から、版の ID を作る */
const versionId = (worker: number, n: number): string => `0000000${worker}-0000-4000-8000-${String(n).padStart(12, "0")}`;

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} が無い`);
  return item;
}

/** 各 Worker に releases を1つずつ配った版の履歴。今の版は currentIndex（無ければ最後に配った版） */
function workerVersions(currentIndex: Partial<Record<WorkerTarget, number>>, releases: readonly Release[] = RELEASES): WorkerVersions[] {
  return SWITCH_ORDER.forward.map((target, w) => {
    const versions: VersionDetail[] = releases.map((r, i) => ({ id: versionId(w, i), createdOn: r.at, gitSha: r.sha }));
    return { target, name: `musubi-production-${target}`, current: nth(versions, currentIndex[target] ?? releases.length - 1), versions };
  });
}

const HAIR = String.fromCharCode(0x200a);

/** wrangler 4.131.1 の `wrangler rollback <id> --yes`（非対話）の出力の形。ソース（src/versions/rollback）から組み立てた。実物は実環境に届くので試験では動かさない */
const rollbackOutput = (previous: string, id: string, message: string): string =>
  [
    "",
    " ⛅️ wrangler 4.131.1",
    "────────────────────",
    "├ Your current deployment has 1 version(s):",
    "│",
    `│ (100%) ${previous}`,
    "│       Created:  2026-09-15T01:00:00.000000Z",
    "│           Tag:  -",
    "│       Message:  -",
    "│",
    "? Please provide an optional message for this rollback (120 characters max)",
    `🤖 Using default value in non-interactive context: ${message}`,
    "│",
    `├${HAIR} WARNING ${HAIR}You are about to rollback to Worker Version ${id}.`,
    `│${HAIR}This will immediately replace the current deployment and become the active deployment across all your deployed triggers.`,
    `│${HAIR}Rolling back to a previous deployment will not rollback any of the bound resources (Durable Object, D1, R2, KV, etc).`,
    "│",
    `│ (100%) ${id}`,
    "│       Created:  2026-09-14T14:25:00.000000Z",
    "│           Tag:  -",
    "│       Message:  -",
    "│",
    "? Are you sure you want to deploy this Worker Version to 100% of traffic?",
    "🤖 Using fallback value in non-interactive context: yes",
    "Performing rollback...",
    "│",
    `╰${HAIR} SUCCESS ${HAIR}Worker Version ${id} has been deployed to 100% of traffic.`,
    "",
    `Current Version ID: ${id}`,
    "",
  ].join("\n");

describe("巻き戻し：版の JSON を読む", () => {
  const id = versionId(0, 0);
  const view = (bindings: unknown[]): string =>
    JSON.stringify({
      id,
      number: 3,
      metadata: { created_on: "2026-09-14T14:25:00.000000Z", source: "wrangler", author_email: AUTHOR_EMAIL },
      annotations: { "workers/triggered_by": "upload" },
      resources: { script: {}, script_runtime: {}, bindings },
    });

  it("deployments status：100% を向けている版の ID", () => {
    const status = { id: "d", author_email: AUTHOR_EMAIL, versions: [{ version_id: id, percentage: 100 }], created_on: "2026-09-14T14:25:00Z" };
    expect(parseCurrentVersion(JSON.stringify(status))).toBe(id);
  });

  it.each([
    ["段階的デプロイの途中（2つの版に分けている）", { versions: [{ version_id: id, percentage: 50 }, { version_id: versionId(0, 1), percentage: 50 }] }, "段階的デプロイの途中"],
    ["versions が無い", { author_email: AUTHOR_EMAIL }, "versions が無い"],
    ["版の ID の形でない", { versions: [{ version_id: "--help", percentage: 100 }] }, "version_id"],
  ])("deployments status：%s なら落とす", (_, status, message) => {
    expect(() => parseCurrentVersion(JSON.stringify(status))).toThrow(message);
  });

  it("JSON でなければ、中身（author_email を含みうる）を出さずに落とす", () => {
    let error: unknown;
    try {
      parseCurrentVersion(`{ "author_email": "${AUTHOR_EMAIL}", `);
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("JSON として読めない");
    expect((error as Error).message).not.toContain(AUTHOR_EMAIL);
  });

  it("versions list：新しい版から並べる。形が違えば落とす", () => {
    const list = [0, 1, 2].map((n) => ({ id: versionId(0, n), metadata: { created_on: `2026-09-1${n + 3}T00:00:00Z`, author_email: AUTHOR_EMAIL } }));
    expect(parseVersionList(JSON.stringify(list)).map((v) => v.id)).toEqual([versionId(0, 2), versionId(0, 1), versionId(0, 0)]);
    expect(() => parseVersionList(JSON.stringify([{ id: "x", metadata: {} }]))).toThrow("形が想定と違う");
    expect(() => parseVersionList("{}")).toThrow("配列でない");
  });

  it("versions view：binding GIT_SHA（plain_text）の値を読む", () => {
    const detail = parseVersionDetail(
      view([
        { name: "ENVIRONMENT", type: "plain_text", text: "production" },
        { name: "GIT_SHA", type: "plain_text", text: SHA_OLD.toUpperCase() },
        { name: "MUSUBI_PROBE_TOKEN", type: "secret_text" },
      ]),
    );
    expect(detail).toEqual({ id, createdOn: "2026-09-14T14:25:00.000000Z", gitSha: SHA_OLD });
  });

  it.each([
    ["GIT_SHA が無い", []],
    ["--var を付けずに配った（\"local\"）", [{ name: "GIT_SHA", type: "plain_text", text: "local" }]],
    ["plain_text でない", [{ name: "GIT_SHA", type: "secret_text" }]],
  ])("versions view：%s なら GIT_SHA は無いものとして扱う", (_, bindings) => {
    expect(parseVersionDetail(view(bindings)).gitSha).toBeUndefined();
  });

  it("GIT_SHA は先頭 7 桁以上で照合する（大文字でもよい）", () => {
    expect(matchesSha(SHA_OLD, SHA_OLD.slice(0, 7).toUpperCase())).toBe(true);
    expect(matchesSha(SHA_OLD, SHA_NEW)).toBe(false);
    expect(matchesSha(undefined, SHA_OLD)).toBe(false);
  });
});

/** 切り替える順に「Worker:版」 */
const ids = (plan: ReturnType<typeof planRollback>): string[] => plan.switches.map((s) => `${s.target}:${s.to.id}`);

describe("巻き戻し：切り替え先と順を決める（planRollback）", () => {
  it("切り替える順：新しい版へは配る順（deploy-production.yml の deploy の並び）、古い版へはその逆", () => {
    const { steps } = readWorkflow("deploy-production.yml");
    const deployed = steps.map((step) => deployWorkerTarget(step)).filter((t): t is WorkerTarget => t !== undefined && t !== "migrate");
    expect(SWITCH_ORDER.forward).toEqual(deployed);
    expect(SWITCH_ORDER.back).toEqual(deployed.toReversed());
  });

  it("1つ前へ戻す：3つとも OLD の版へ、host → gateway → data-api の順", () => {
    const plan = planRollback(workerVersions({}), SHA_OLD);
    expect(plan.direction).toBe("back");
    expect(ids(plan)).toEqual([`host:${versionId(2, 0)}`, `gateway:${versionId(1, 0)}`, `data-api:${versionId(0, 0)}`]);
    expect(plan.unchanged).toEqual([]);
  });

  it("新しい版へ戻す（復帰）：3つとも NEW の版へ、data-api → gateway → host の順", () => {
    const plan = planRollback(workerVersions({ "data-api": 0, gateway: 0, host: 0 }), SHA_NEW);
    expect(plan.direction).toBe("forward");
    expect(ids(plan)).toEqual([`data-api:${versionId(0, 1)}`, `gateway:${versionId(1, 1)}`, `host:${versionId(2, 1)}`]);
  });

  it("既に切り替え先の版なら、何も切り替えない", () => {
    const plan = planRollback(workerVersions({}), SHA_NEW.slice(0, 7));
    expect(plan).toEqual({ direction: undefined, switches: [], unchanged: ["data-api", "gateway", "host"] });
  });

  it("配っている途中で落ちた（host だけ OLD のまま）：OLD へ戻すなら host は飛ばし、gateway → data-api", () => {
    const plan = planRollback(workerVersions({ host: 0 }), SHA_OLD);
    expect(plan.direction).toBe("back");
    expect(plan.switches.map((s) => s.target)).toEqual(["gateway", "data-api"]);
    expect(plan.unchanged).toEqual(["host"]);
  });

  it("同じ commit の版が複数あれば、いちばん新しい版へ切り替える", () => {
    const releases = [...RELEASES, { sha: SHA_OLD, at: "2026-09-15T02:00:00Z" }, { sha: SHA_NEW, at: "2026-09-15T03:00:00Z" }];
    const plan = planRollback(workerVersions({}, releases), SHA_OLD);
    expect(plan.direction).toBe("back");
    expect(plan.switches.map((s) => s.to.id)).toEqual([versionId(2, 2), versionId(1, 2), versionId(0, 2)]);
  });

  it("二次手段で OLD を配り直した後に NEW へ進める：版は NEW のほうが古いが、commit が最初に配られた順で「新しい版へ」と決める", () => {
    const releases = [...RELEASES, { sha: SHA_OLD, at: "2026-09-15T02:00:00Z" }];
    const plan = planRollback(workerVersions({}, releases), SHA_NEW);
    expect(plan.direction).toBe("forward");
    expect(ids(plan)).toEqual([`data-api:${versionId(0, 1)}`, `gateway:${versionId(1, 1)}`, `host:${versionId(2, 1)}`]);
  });

  it("GIT_SHA の無い今の版（手で配った版）からは、版の作成時刻で比べる", () => {
    const releases = [...RELEASES, { sha: undefined, at: "2026-09-15T02:00:00Z" }];
    expect(planRollback(workerVersions({}, releases), SHA_NEW).direction).toBe("back");
  });

  it("切り替え先の版が1つでも見つからなければ、何も切り替えずに落とす（二次手段へ）", () => {
    const releases = [...RELEASES, { sha: SHA_NEWER, at: "2026-09-15T02:00:00Z" }];
    const workers = workerVersions({}, RELEASES).map((w) => (w.target === "host" ? workerVersions({}, releases)[2] ?? w : w));
    expect(() => planRollback(workers, SHA_NEWER)).toThrow(/見つからない：data-api, gateway（直近 10 版まで探した）。何も切り替えない。二次手段/);
    expect(VERSIONS_LISTED).toBe(10);
  });

  it("古い版へ戻す Worker と新しい版へ進める Worker が混ざっていれば、何も切り替えずに落とす", () => {
    const releases = [...RELEASES, { sha: SHA_NEWER, at: "2026-09-15T02:00:00Z" }];
    // data-api は NEWER、gateway は NEW、host は OLD。NEW へ切り替えるなら data-api は戻し、host は進める
    const workers = workerVersions({ "data-api": 2, gateway: 1, host: 0 }, releases);
    expect(() => planRollback(workers, SHA_NEW)).toThrow("古い版へ戻す Worker（data-api）と新しい版へ進める Worker（host）が混ざっている");
  });
});

describe("巻き戻し：wrangler の呼び方", () => {
  it.each(ENVS)("Worker の名前は wrangler.jsonc の env.%s.name（musubi-<env>-<Worker>）", (env) => {
    for (const target of SWITCH_ORDER.forward) {
      expect(workerName(ROOT, target, env)).toBe(`musubi-${env}-${target}`);
    }
  });

  it("版を読む呼び方は --name と --json。設定の無い一時ディレクトリで動かし、secret は載せない", () => {
    const name = "musubi-production-host";
    const id = versionId(2, 0);
    expect(readCall.status(name)).toEqual({ kind: "read", cwd: null, args: ["deployments", "status", "--name", name, "--json"], secrets: [] });
    expect(readCall.list(name)).toEqual({ kind: "read", cwd: null, args: ["versions", "list", "--name", name, "--json"], secrets: [] });
    expect(readCall.view(name, id)).toEqual({ kind: "read", cwd: null, args: ["versions", "view", id, "--name", name, "--json"], secrets: [] });
  });

  it("切り替える呼び方は wrangler rollback <版> --name --message --yes。message は 120 文字以内", () => {
    const call = rollbackCall("musubi-production-host", versionId(2, 0), SHA_OLD);
    expect(call).toEqual({
      kind: "rollback",
      cwd: null,
      args: ["rollback", versionId(2, 0), "--name", "musubi-production-host", "--message", `${ROLLBACK_MESSAGE} ${SHA_OLD}`, "--yes"],
      secrets: [],
    });
    expect(`${ROLLBACK_MESSAGE} ${SHA_OLD}`.length).toBeLessThanOrEqual(120);
    expect(() => rollbackCall("musubi-production-host", "--help", SHA_OLD)).toThrow("版の ID の形でない");
  });

  it("要約：rollback は切り替え前後の版・既定値で進めたこと・切り替えた結果を出す", () => {
    const previous = versionId(2, 1);
    const id = versionId(2, 0);
    const lines = summarize("rollback", rollbackOutput(previous, id, `${ROLLBACK_MESSAGE} ${SHA_OLD}`), ACCOUNT_ID);
    expect(lines).toEqual([
      "├ Your current deployment has 1 version(s):",
      `│ (100%) ${previous}`,
      "│       Created:  2026-09-15T01:00:00.000000Z",
      `🤖 Using default value in non-interactive context: ${ROLLBACK_MESSAGE} ${SHA_OLD}`,
      `├${HAIR} WARNING ${HAIR}You are about to rollback to Worker Version ${id}.`,
      `│ (100%) ${id}`,
      "│       Created:  2026-09-14T14:25:00.000000Z",
      "🤖 Using fallback value in non-interactive context: yes",
      "Performing rollback...",
      `╰${HAIR} SUCCESS ${HAIR}Worker Version ${id} has been deployed to 100% of traffic.`,
      `Current Version ID: ${id}`,
    ]);
  });

  it("要約：secret が変わった版へ戻すときは、変わった secret の名前（値ではない）も出す", () => {
    const text = [
      `? The following secrets have changed since version ${versionId(2, 0)} was deployed. Please confirm you wish to continue with the rollback`,
      "  * MUSUBI_PROBE_TOKEN",
      "🤖 Using fallback value in non-interactive context: yes",
    ].join("\n");
    expect(summarize("rollback", text)).toEqual(text.split("\n"));
  });

  it("伏せる：メールアドレスの形（author_email）", () => {
    expect(redact(`Author: ${AUTHOR_EMAIL}`)).toBe(`Author: ${REDACTED_EMAIL}`);
  });
});

/** 偽の wrangler が記録した1回の呼び出し */
interface Call {
  args: string[];
  cwd: string;
  probeTokenEnv?: string;
  forceColor?: string;
}

/** rollback の呼び出しの --name（切り替えた順） */
const switched = (calls: readonly Call[]): string[] => calls.filter((c) => c.args[0] === "rollback").map((c) => c.args[3] ?? "");

describe("CLI：--rollback-to（偽の wrangler）", () => {
  let dir: string;
  let fake: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "deploy-worker-rollback-test-"));
    fake = join(dir, "fake-wrangler-rollback.mjs");
    // FAKE_STATE の版の履歴を持つ Cloudflare の代わり。受けた呼び出しを FAKE_CALLS に1行ずつ記録する。
    // rollback は今の版を書き換える（failRollback は exit 1、ignoreRollback は exit 0 なのに書き換えない）
    writeFileSync(
      fake,
      [
        'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
        "const { FAKE_STATE, FAKE_CALLS } = process.env;",
        "const state = JSON.parse(readFileSync(FAKE_STATE, 'utf8'));",
        "const args = process.argv.slice(2);",
        "appendFileSync(FAKE_CALLS, JSON.stringify({ args, cwd: process.cwd(), probeTokenEnv: process.env.MUSUBI_PROBE_TOKEN, forceColor: process.env.FORCE_COLOR }) + '\\n');",
        "const name = args[args.indexOf('--name') + 1];",
        "const worker = state.workers[name];",
        "if (worker === undefined) { process.stderr.write(`✘ [ERROR] A request to the Cloudflare API (/accounts/${state.accountId}/workers/scripts/${name}) failed.\\n`); process.exit(1); }",
        "const meta = (v) => ({ id: v.id, number: 1, metadata: { created_on: v.created_on, source: 'wrangler', author_id: 'fixture', author_email: state.author, has_preview: false }, annotations: { 'workers/triggered_by': 'upload' } });",
        "const json = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\\n');",
        "if (args[0] === 'deployments' && args[1] === 'status') {",
        "  if (state.brokenStatus === name) { process.stdout.write(`{ \"author_email\": \"${state.author}\", `); process.exit(0); }",
        "  json({ id: 'deployment', source: 'wrangler', strategy: 'percentage', author_email: state.author, annotations: {}, versions: [{ version_id: worker.current, percentage: 100 }], created_on: '2026-09-15T00:00:00Z' });",
        "} else if (args[0] === 'versions' && args[1] === 'list') {",
        "  json(worker.versions.map(meta));",
        "} else if (args[0] === 'versions' && args[1] === 'view') {",
        "  const v = worker.versions.find((x) => x.id === args[2]);",
        "  const bindings = [{ name: 'ENVIRONMENT', type: 'plain_text', text: 'production' }, ...(v.sha ? [{ name: 'GIT_SHA', type: 'plain_text', text: v.sha }] : []), { name: 'MUSUBI_PROBE_TOKEN', type: 'secret_text' }];",
        "  json({ ...meta(v), resources: { script: { handlers: ['fetch'] }, script_runtime: { compatibility_date: '2026-09-01' }, bindings } });",
        "} else if (args[0] === 'rollback') {",
        "  if (state.failRollback === name) { process.stderr.write(state.failOutput); process.exit(1); }",
        "  const previous = worker.current;",
        "  if (state.ignoreRollback !== name) { worker.current = args[1]; writeFileSync(FAKE_STATE, JSON.stringify(state)); }",
        "  process.stdout.write(state.rollbackOutput.replaceAll('{previous}', previous).replaceAll('{id}', args[1]).replaceAll('{message}', args[args.indexOf('--message') + 1]));",
        "} else { process.stderr.write('unknown command\\n'); process.exit(2); }",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  interface FakeState {
    accountId: string;
    author: string;
    rollbackOutput: string;
    failOutput: string;
    workers: Record<string, { current: string; versions: { id: string; created_on: string; sha: string | undefined }[] }>;
    failRollback?: string;
    ignoreRollback?: string;
    brokenStatus?: string;
  }

  function fakeState(currentIndex: Partial<Record<WorkerTarget, number>>, extra: Partial<FakeState> = {}): FakeState {
    return {
      accountId: ACCOUNT_ID_HEX,
      author: AUTHOR_EMAIL,
      rollbackOutput: rollbackOutput("{previous}", "{id}", "{message}"),
      failOutput: [
        `✘ [ERROR] A request to the Cloudflare API (/accounts/${ACCOUNT_ID}/workers/scripts/musubi-production-gateway/deployments) failed.`,
        `  Version was uploaded by ${AUTHOR_EMAIL} at https://musubi-production-gateway.${SUBDOMAIN}.workers.dev [code: 10000]`,
        "::error::injected by a response",
        "",
      ].join("\n"),
      workers: Object.fromEntries(
        SWITCH_ORDER.forward.map((target, w) => [
          `musubi-production-${target}`,
          {
            current: versionId(w, currentIndex[target] ?? RELEASES.length - 1),
            versions: RELEASES.map((r, i) => ({ id: versionId(w, i), created_on: r.at, sha: r.sha })),
          },
        ]),
      ),
      ...extra,
    };
  }

  let seq = 0;
  async function rollback(argv: readonly string[], state: FakeState) {
    const statePath = join(dir, `state-${++seq}.json`);
    const callsPath = join(dir, `calls-${seq}.jsonl`);
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(callsPath, "");
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runCli(argv, {
      root: ROOT,
      wrangler: [process.execPath, fake],
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, RUNNER_TEMP: dir, FAKE_STATE: statePath, FAKE_CALLS: callsPath, [PROBE_TOKEN_SECRET]: PROBE_TOKEN },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    const calls = readFileSync(callsPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Call);
    const after = JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
    const currents = Object.fromEntries(SWITCH_ORDER.forward.map((t) => [t, after.workers[`musubi-production-${t}`]?.current]));
    return { code: exit, out, err, all: [...out, ...err].join("\n"), calls, currents };
  }

  const allAt = (n: number) => Object.fromEntries(SWITCH_ORDER.forward.map((t, w) => [t, versionId(w, n)]));
  const leftoverEmptyDirs = (): string[] => readdirSync(dir).filter((name) => name.startsWith("deploy-worker-rollback-"));

  it("1つ前へ戻す：版を読み、host → gateway → data-api の順に切り替え、1つずつ確かめて exit 0", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_OLD], fakeState({}));
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(switched(run.calls)).toEqual(["musubi-production-host", "musubi-production-gateway", "musubi-production-data-api"]);
    expect(run.currents).toEqual(allAt(0));
    for (const [w, target] of SWITCH_ORDER.forward.entries()) {
      const call = run.calls.find((c) => c.args[0] === "rollback" && c.args[3] === `musubi-production-${target}`);
      expect(call?.args).toEqual(rollbackCall(`musubi-production-${target}`, versionId(w, 0), SHA_OLD).args);
    }
    // 切り替えのたびに、今のデプロイを読み直す
    const afterFirstSwitch = run.calls.slice(run.calls.findIndex((c) => c.args[0] === "rollback") + 1)[0];
    expect(afterFirstSwitch?.args).toEqual(readCall.status("musubi-production-host").args);

    expect(run.out).toContain("deploy-worker: 古い版へ戻す。順は host → gateway → data-api");
    expect(run.out).toContain(`  Current Version ID: ${versionId(2, 0)}`);
    expect(run.out).toContain(`deploy-worker: host: 今のデプロイが ${versionId(2, 0)} を 100% で向いていることを確かめた`);
    expect(run.out.at(-1)).toMatch(new RegExp(`^deploy-worker: OK {2}rollback（env=production）: 3つの Worker が GIT_SHA ${SHA_OLD} の版で動いている（切り替え \\d+ 秒）$`));
    expectRedacted(run.all);
    expectNoWorkflowCommand(run.out);
  });

  it("wrangler はリポジトリの外の空の一時ディレクトリで動かし（.env を読ませない）、終わったら消す。secret の環境変数も色も渡さない", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_OLD], fakeState({}));
    expect(run.code, run.all).toBe(EXIT_OK);
    const cwds = new Set(run.calls.map((c) => c.cwd));
    expect(cwds.size).toBe(1);
    const [cwd] = [...cwds];
    // macOS の tmpdir はシンボリックリンク越し。子プロセスの cwd は実体のパスで見える
    expect(dirname(cwd ?? "")).toBe(realpathSync(dir));
    expect(cwd?.startsWith(ROOT)).toBe(false);
    expect(leftoverEmptyDirs()).toEqual([]);
    for (const call of run.calls) {
      expect(call.probeTokenEnv).toBeUndefined();
      expect(call.forceColor).toBe("0");
      expect(call.args).not.toContain("--secrets-file");
    }
  });

  it("新しい版へ戻す（復帰）：data-api → gateway → host の順", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_NEW], fakeState({ "data-api": 0, gateway: 0, host: 0 }));
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(switched(run.calls)).toEqual(["musubi-production-data-api", "musubi-production-gateway", "musubi-production-host"]);
    expect(run.currents).toEqual(allAt(1));
    expect(run.out).toContain("deploy-worker: 新しい版へ進める。順は data-api → gateway → host");
  });

  it("既に切り替え先の版なら、版の一覧も読まず、何も切り替えずに exit 0", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_NEW.slice(0, 12)], fakeState({}));
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(run.calls.map((c) => `${c.args[0]} ${c.args[1]}`)).toEqual(Array.from({ length: 3 }, () => ["deployments status", "versions view"]).flat());
    expect(run.out.at(-1)).toContain("切り替えるものは無い");
  });

  it("配っている途中で落ちた（host だけ OLD）：OLD へ戻すなら host を飛ばす", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_OLD], fakeState({ host: 0 }));
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(switched(run.calls)).toEqual(["musubi-production-gateway", "musubi-production-data-api"]);
    expect(run.out).toContain("deploy-worker: 古い版へ戻す。順は gateway → data-api（host は既に切り替え先の版なので飛ばす）");
  });

  it("切り替え先の版が見つからなければ、何も切り替えずに exit 1（二次手段へ）", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_NEWER], fakeState({}));
    expect(run.code).toBe(EXIT_NG);
    expect(switched(run.calls)).toEqual([]);
    expect(run.err[0]).toContain("版が見つからない：data-api, gateway, host");
    expect(run.err[0]).toContain("二次手段");
    expect(run.out.at(-1)).toBe("deploy-worker: NG  rollback（env=production）");
    expectRedacted(run.all);
  });

  it("途中で rollback が落ちたら止め、どこまで切り替えたかを出して exit 1。同じ --rollback-to でもう一度動かすと続きから切り替える", async () => {
    const failed = await rollback(["--env", "production", "--rollback-to", SHA_OLD], fakeState({}, { failRollback: "musubi-production-gateway" }));
    expect(failed.code).toBe(EXIT_NG);
    expect(switched(failed.calls)).toEqual(["musubi-production-host", "musubi-production-gateway"]);
    expect(failed.currents).toEqual({ "data-api": versionId(0, 1), gateway: versionId(1, 1), host: versionId(2, 0) });
    expect(failed.out).toContainEqual(expect.stringContaining("deploy-worker: 切り替え済み：host。未切り替え：gateway, data-api。"));
    expect(failed.out).toContainEqual(expect.stringContaining(`/accounts/${REDACTED_ACCOUNT}/workers/scripts/musubi-production-gateway/deployments`));
    expect(failed.err[0]).toBe("deploy-worker: gateway の rollback に失敗した（上の出力）");
    expectRedacted(failed.all);
    expectNoWorkflowCommand(failed.out);

    // 続き：host は既に OLD なので飛ばし、gateway → data-api
    const resumed = await rollback(["--env", "production", "--rollback-to", SHA_OLD], fakeState({ host: 0 }));
    expect(resumed.code, resumed.all).toBe(EXIT_OK);
    expect(switched(resumed.calls)).toEqual(["musubi-production-gateway", "musubi-production-data-api"]);
  });

  it("rollback が exit 0 でも今のデプロイが切り替わっていなければ、止めて exit 1", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_OLD], fakeState({}, { ignoreRollback: "musubi-production-host" }));
    expect(run.code).toBe(EXIT_NG);
    expect(switched(run.calls)).toEqual(["musubi-production-host"]);
    expect(run.err[0]).toContain("host: rollback の後も、今のデプロイが切り替え先の版を向いていない");
    expect(run.out).toContainEqual(expect.stringContaining("切り替え済み：なし。未切り替え：host, gateway, data-api。"));
  });

  it("版の JSON が読めなければ、中身を出さずに、何も切り替えずに exit 1", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_OLD], fakeState({}, { brokenStatus: "musubi-production-data-api" }));
    expect(run.code).toBe(EXIT_NG);
    expect(switched(run.calls)).toEqual([]);
    expect(run.err[0]).toContain("wrangler deployments status --json の出力が JSON として読めない");
    expectRedacted(run.all);
  });

  it("版の JSON（author_email を含む）はファイルに受け、ログには出さない", async () => {
    const run = await rollback(["--env", "production", "--rollback-to", SHA_OLD], fakeState({}));
    expect(run.code, run.all).toBe(EXIT_OK);
    const kept = readdirSync(dir).filter((name) => /^deploy-worker-production-rollback-\d+\.json$/.test(name));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.some((name) => readFileSync(join(dir, name), "utf8").includes(AUTHOR_EMAIL))).toBe(true);
    expect(run.all).not.toContain(AUTHOR_EMAIL);
  });

  it.each([
    ["--target と一緒", ["--env", "production", "--rollback-to", SHA_OLD, "--target", "host"], "--rollback-to は --target・--sha と一緒に使わない"],
    ["--sha と一緒", ["--env", "production", "--rollback-to", SHA_OLD, "--sha", SHA_OLD], "--rollback-to は --target・--sha と一緒に使わない"],
    ["SHA でない（値を出さない）", ["--env", "production", "--rollback-to", SUBDOMAIN], "--rollback-to は 7〜40 桁の 16 進"],
    ["--env が無い", ["--rollback-to", SHA_OLD], "--env が無い"],
  ])("引数の誤り（%s）は wrangler を起動せずに exit 1", async (_, argv, message) => {
    const run = await rollback(argv, fakeState({}));
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toEqual([]);
    expect(run.err[0]).toContain(`deploy-worker: ${message}`);
    expectRedacted(run.all);
  });

  it(
    "実物の wrangler も、版を読む・切り替える呼び方を受け付ける（資格情報を渡さないので、認証の手前で止まり Cloudflare に届かない）",
    () => {
      const bin = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
      const home = mkdtempSync(join(dir, "home-"));
      const name = workerName(ROOT, "host", "production");
      const id = versionId(2, 0);
      for (const call of [readCall.status(name), readCall.list(name), readCall.view(name, id), rollbackCall(name, id, SHA_OLD)]) {
        const result = spawnSync(process.execPath, [bin, ...call.args], {
          cwd: home,
          env: { PATH: process.env["PATH"], HOME: home, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
        const output = `${result.stdout}${result.stderr}`;
        expect(result.status, `${call.args.join(" ")}\n${output}`).toBe(1);
        expect(output).not.toMatch(/Unknown argument/i);
        expect(output).toContain("it's necessary to set a CLOUDFLARE_API_TOKEN environment variable");
      }
    },
    60_000,
  );
});

/** ステップの run の本文（`run: |` の塊か、1行の `run:`）。 */
const runOf = (step: Step): string =>
  /^\s+(?:- )?run: \|$/m.test(step.body) ? runScript(step) : (step.body.match(/^\s+(?:- )?run: (.+)$/m)?.[1] ?? "");

describe("rollback.yml", () => {
  const { yaml, steps, indexOf } = readWorkflow("rollback.yml");

  it("起動は手動実行だけ（to は必須の文字列）。push・schedule・pull_request では起動しない", () => {
    expect(code(yaml)).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}to:\n/m);
    const input = code(yaml).match(/^ {6}to:\n((?: {8}.+\n)+)/m)?.[1] ?? "";
    expect(input).toMatch(/^ {8}required: true$/m);
    expect(input).toMatch(/^ {8}type: string$/m);
    expect(code(yaml)).not.toMatch(/^\s+push:|schedule|pull_request|branches/m);
  });

  it("前提の確認：v タグから起動したときだけ動く", () => {
    const preflight = steps[0] ?? { body: "" };
    const allSet = Object.fromEntries([...preflight.body.matchAll(/^\s+(HAS_[A-Z0-9_]+):/gm)].map((m) => [m[1] ?? "", "true"]));
    expect(runPreflight(preflight, { ...allSet, REF: "refs/tags/v0.1.1", TO: "v0.1.0" }).code).toBe(0);
    for (const ref of ["refs/heads/main", "refs/tags/0.1.1", "refs/pull/1/merge"]) {
      const run = runPreflight(preflight, { ...allSet, REF: ref, TO: "v0.1.0" });
      expect(run.code, ref).toBe(1);
      expect(run.output).toContain("::error::production を切り替えるのは v タグから起動したときだけ");
    }
  });

  it("前提の確認：to が v タグの名前の形でなければ、値を表示せずに落とす", () => {
    const preflight = steps[0] ?? { body: "" };
    const allSet = Object.fromEntries([...preflight.body.matchAll(/^\s+(HAS_[A-Z0-9_]+):/gm)].map((m) => [m[1] ?? "", "true"]));
    for (const to of ["", "0.9.9", "main", "v0.9.9; id", "v0.9.9\n::warning::injected", "$(id)", `v${"9".repeat(70)}`, "-v9"]) {
      const run = runPreflight(preflight, { ...allSet, REF: "refs/tags/v0.1.1", TO: to });
      expect(run.code, JSON.stringify(to)).toBe(1);
      expect(run.output).toContain("::error::to は v タグの名前");
      if (to !== "") expect(run.output).not.toContain(to);
    }
  });

  it("前提の確認：Secret が1つでも空なら、名前を挙げて落とす（値は受け取らない）", () => {
    const preflight = steps[0] ?? { body: "" };
    const names = [...preflight.body.matchAll(/^\s+HAS_([A-Z0-9_]+):/gm)].map((m) => m[1] ?? "");
    expect(names.toSorted()).toEqual(["CLOUDFLARE_ACCOUNT_ID_PROD", "CLOUDFLARE_API_TOKEN_PROD", "MUSUBI_PROBE_TOKEN", "SMOKE_BASE_URL"]);
    for (const missing of names) {
      const env = Object.fromEntries(names.map((name) => [`HAS_${name}`, name === missing ? "false" : "true"]));
      const run = runPreflight(preflight, { ...env, REF: "refs/tags/v0.1.1", TO: "v0.1.0" });
      expect(run.code, missing).toBe(1);
      expect(run.output).toContain(`::error::${missing} が空`);
    }
  });

  it("concurrency は deploy-production と同じ group で取り消さない。permissions は読み取りだけ", () => {
    expect(code(yaml)).toContain("concurrency: { group: deploy-production, cancel-in-progress: false }");
    expect(code(readFileSync(join(ROOT, ".github/workflows/deploy-production.yml"), "utf8"))).toContain("concurrency: { group: deploy-production,");
    expect(code(yaml)).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(code(yaml)).not.toMatch(/: write\b/);
  });

  it("production 環境を宣言し（承認待ちと本番の Secret はここから）、url は書かない", () => {
    expect(code(yaml)).toMatch(/^ {4}environment: production$/m);
    expect(code(yaml).match(/environment:/g)).toHaveLength(1);
    expect(code(yaml)).not.toMatch(/^\s+url:/m);
  });

  it("前提の確認 → checkout → 切り替え先の commit → install → 切り替え → smoke の順。build・migration・乖離チェック・deploy はしない", () => {
    const order = [
      indexOf(/refs\/tags\/v\*/),
      indexOf(/actions\/checkout@/),
      indexOf(/git rev-parse --verify "refs\/tags\/\$\{TO\}\^\{commit\}"/),
      indexOf(/pnpm install --frozen-lockfile/),
      indexOf(/deploy-worker\.ts --env production --rollback-to "\$TO_SHA"$/m),
      indexOf(/pnpm smoke --env production --expect-sha "\$TO_SHA"$/m),
    ];
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(steps.filter((step) => /deploy-worker\.ts/.test(step.body))).toHaveLength(1);
    expect(code(yaml)).not.toMatch(/pnpm build|--target|terraform|infra:sync|migrations|--env (?:dev|staging)\b/);
  });

  it("inputs.to は env で渡し、run に式を埋め込まない（シェルへの注入を作らない）", () => {
    for (const step of steps) {
      expect(runOf(step), step.body).not.toContain("${{");
    }
    const usages = code(yaml)
      .split("\n")
      .filter((line) => /\$\{\{\s*inputs\./.test(line));
    expect(usages.length).toBeGreaterThan(0);
    for (const line of usages) expect(line).toMatch(/^\s+TO: \$\{\{ inputs\.to \}\}$/);
  });

  it("TO_SHA は、切り替え先の commit を引いたステップ（id: to）の出力から渡す", () => {
    const resolveStep = steps[indexOf(/git rev-parse --verify/)]?.body ?? "";
    expect(resolveStep).toMatch(/^\s+id: to$/m);
    expect(resolveStep).toContain('echo "sha=${sha}" >> "$GITHUB_OUTPUT"');
    for (const step of steps.filter((s) => /"\$TO_SHA"/.test(s.body))) {
      expect(step.body).toContain("TO_SHA: ${{ steps.to.outputs.sha }}");
    }
  });

  it("切り替え先の commit を引くスクリプトは、注釈付きタグが指す commit を出力に書く。無いタグなら落とす", () => {
    const repo = mkdtempSync(join(tmpdir(), "rollback-yml-test-"));
    try {
      const gitEnv = { PATH: process.env["PATH"], HOME: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(repo, "gitconfig") };
      const git = (cwd: string, ...args: string[]): string => {
        const result = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, env: gitEnv, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const origin = join(repo, "origin");
      const clone = join(repo, "clone");
      for (const path of [origin, clone]) mkdirSync(path);
      git(origin, "init", "-q");
      git(origin, "commit", "-q", "--allow-empty", "-m", "release");
      git(origin, "tag", "-a", "v9.9.9", "-m", "fixture release");
      git(origin, "commit", "-q", "--allow-empty", "-m", "later");
      const tagged = git(origin, "rev-parse", "v9.9.9^{commit}");
      git(clone, "init", "-q");
      git(clone, "remote", "add", "origin", `file://${origin}`);

      const script = runScript(steps[indexOf(/git rev-parse --verify/)] ?? { body: "" });
      const output = join(repo, "github-output");
      const resolveTag = (to: string) =>
        spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd: clone, env: { ...gitEnv, TO: to, GITHUB_OUTPUT: output }, encoding: "utf8" });

      const ok = resolveTag("v9.9.9");
      expect(ok.status, ok.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`sha=${tagged}\n`);
      expect(ok.stdout).toContain(`切り替え先: v9.9.9 = ${tagged}`);

      const missing = resolveTag("v9.9.8");
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain("::error::タグ v9.9.8 を取れない");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("wrangler を直接呼ばない。smoke に --base-url を渡さない。Worker に secret を載せない", () => {
    for (const step of steps) {
      expect(step.body).not.toMatch(/(?:^|\s)wrangler\s/m);
      expect(step.body).not.toContain("--base-url");
      expect(step.body).not.toContain("--secrets-file");
      expect(runOf(step)).not.toMatch(/\$\{?(?:MUSUBI_PROBE_TOKEN|SMOKE_PROBE_TOKEN|CLOUDFLARE_API_TOKEN)\b/);
    }
  });

  it("Cloudflare のトークンと Account ID は production 環境の *_PROD を、切り替えのステップにだけ渡す", () => {
    for (const step of steps) {
      const switches = /deploy-worker\.ts/.test(step.body);
      expect(passesAs(step, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_PROD"), step.body).toBe(switches);
      expect(passesAs(step, "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID_PROD"), step.body).toBe(switches);
      expect(passes(step, "CLOUDFLARE_API_TOKEN"), step.body).toBe(false);
      expect(passes(step, "CLOUDFLARE_ACCOUNT_ID"), step.body).toBe(false);
    }
  });

  it("MUSUBI_PROBE_TOKEN は smoke に SMOKE_PROBE_TOKEN としてだけ渡す（Worker に載せない）。SMOKE_BASE_URL も smoke だけ", () => {
    for (const step of steps) {
      const smoke = /pnpm smoke/.test(step.body);
      expect(passes(step, "MUSUBI_PROBE_TOKEN"), step.body).toBe(smoke);
      expect(passesAs(step, "SMOKE_PROBE_TOKEN", "MUSUBI_PROBE_TOKEN"), step.body).toBe(smoke);
      expect(passesAs(step, "MUSUBI_PROBE_TOKEN", "MUSUBI_PROBE_TOKEN"), step.body).toBe(false);
      expect(passes(step, "SMOKE_BASE_URL"), step.body).toBe(smoke);
    }
  });

  it("R2 の資格情報・TF_* は使わない。Secret はステップの env にだけ置き、vars を使わない", () => {
    expect(code(yaml)).not.toMatch(/R2_|TF_CLOUDFLARE|AWS_/);
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

// ── 8. dev の貫通スモーク（--smoke）────────────────────────────────────────────────

describe("--smoke：dev の宛先を組み立てて smoke に渡す（偽の fetch）", () => {
  /** 目印。CI 用トークンの代わり */
  const API_TOKEN = "fixture-ci-token-2f7c9e1b";
  const HOSTNAME = `musubi-dev-host.${SUBDOMAIN}.workers.dev`;
  const SUBDOMAIN_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID_HEX}/workers/subdomain`;
  const FAST: RetryPolicy = { maxAttempts: 3, retryIntervalMs: 10, requestTimeoutMs: 1_000, deadlineMs: 10_000 };
  const CREDENTIALS = { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID_HEX, CLOUDFLARE_ACCOUNT_ID_PROD: "1a2b3c4d5e6f708192a3b4c5d6e7f809" };
  const healthy = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    service: "host",
    env: "dev",
    version: SHA,
    checks: { gateway: "ok", data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
    elapsed_ms: 12.5,
    ...overrides,
  });

  interface SmokeRun {
    code: number;
    out: string[];
    all: string;
    /** 呼ばれた URL（Cloudflare の API と host の /healthz） */
    urls: string[];
    /** /healthz に付いたヘッダ */
    healthzHeaders: Headers[];
  }

  async function smoke(
    argv: readonly string[],
    options: { env?: Record<string, string | undefined>; subdomain?: () => Response; healthz?: () => Response; unreachable?: boolean } = {},
  ): Promise<SmokeRun> {
    const out: string[] = [];
    const err: string[] = [];
    const urls: string[] = [];
    const healthzHeaders: Headers[] = [];
    let now = 0;
    const exit = await runCli(argv, {
      root: ROOT,
      // 起動されたら落ちる wrangler（--smoke は wrangler を使わない）
      wrangler: [join(tmpdir(), "deploy-worker-test-no-such-wrangler")],
      env: options.env ?? { ...CREDENTIALS, [PROBE_TOKEN_ENV]: PROBE_TOKEN, SMOKE_BASE_URL: "https://fixture-wrong-origin.example" },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetch: async (input, init) => {
        const url = String(input);
        urls.push(url);
        if (options.unreachable === true) {
          throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: "ECONNREFUSED" }) });
        }
        if (url === SUBDOMAIN_API) {
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
          return options.subdomain?.() ?? Response.json({ success: true, errors: [], messages: [], result: { subdomain: SUBDOMAIN } });
        }
        if (url === `https://${HOSTNAME}/healthz`) {
          healthzHeaders.push(new Headers(init?.headers));
          return options.healthz?.() ?? Response.json(healthy());
        }
        throw new Error(`想定外の宛先: ${url}`);
      },
      smoke: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        policy: FAST,
      },
    });
    return { code: exit, out, all: [...out, ...err].join("\n"), urls, healthzHeaders };
  }

  function expectNothingSecret(run: SmokeRun): void {
    expectRedacted(run.all);
    for (const secret of [API_TOKEN, HOSTNAME, "https://", "fixture-wrong-origin"]) expect(run.all).not.toContain(secret);
  }

  it("--smoke で組み立ててよい env は dev だけ。dev の host は X-Musubi-Probe が無くても詳細を返す", () => {
    expect(SMOKE_ENVS).toEqual(["dev"]);
    for (const env of SMOKE_ENVS) expect(PROBE_REQUIRED_ENVS).not.toContain(env);
  });

  it("host の Worker 名とサブドメインから作るオリジンは、smoke が SMOKE_BASE_URL として受け付ける形", () => {
    const origin = hostOrigin(workerName(ROOT, "host", "dev"), SUBDOMAIN);
    expect(healthzUrl(origin, "SMOKE_BASE_URL").href).toBe(`https://${HOSTNAME}/healthz`);
  });

  it("サブドメインの応答：DNS のラベルだけを受け付け、値は出さない", () => {
    expect(parseSubdomain({ success: true, result: { subdomain: "Fixture-Sub-1" } })).toBe("fixture-sub-1");
    for (const body of [{ success: false, result: { subdomain: SUBDOMAIN } }, { success: true, result: { subdomain: `${SUBDOMAIN}.evil/x` } }, { success: true, result: {} }, "x"]) {
      expect(() => parseSubdomain(body)).toThrow("Workers のサブドメインが読めない");
    }
  });

  it("資格情報：production のアカウント・Account ID の形でない値は止める。値は出さない", () => {
    expect(readApiCredentials(CREDENTIALS)).toEqual({ token: API_TOKEN, accountId: ACCOUNT_ID_HEX });
    expect(() => readApiCredentials({ ...CREDENTIALS, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID_HEX.toUpperCase() })).toThrow("production のアカウント");
    expect(() => readApiCredentials({ ...CREDENTIALS, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID })).toThrow("Account ID の形");
    expect(() => readApiCredentials({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID_HEX })).toThrow("CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る");
  });

  it("成功：サブドメインを読み、host の /healthz を1回叩いて全層 ok なら exit 0。宛先は出さず、SMOKE_PROBE_TOKEN を dev の host に送らない", async () => {
    const run = await smoke(["--env", "dev", "--smoke", "--sha", SHA]);
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(run.urls).toEqual([SUBDOMAIN_API, `https://${HOSTNAME}/healthz`]);
    expect(run.healthzHeaders[0]?.get(PROBE_HEADER)).toBeNull();
    expect(run.out[0]).toBe("deploy-worker: smoke（env=dev）: 宛先は host（musubi-dev-host）の workers.dev のオリジン。Cloudflare の API で読んだサブドメインから組み立て、表示しない");
    expect(run.out).toContain(`smoke: GET /healthz（env=dev, expect-sha=${SHA}）`);
    expect(run.out).toContainEqual(expect.stringMatching(/^smoke: OK {2}host → gateway → data_api → d1 \/ r2 \/ do/));
    expect(run.out.at(-1)).toBe("deploy-worker: OK  smoke（env=dev）");
    expectNothingSecret(run);
  });

  it("smoke が NG（checks の r2 が ng）なら exit 1。smoke の判定をそのまま出す", async () => {
    const broken = healthy({ checks: { gateway: "ok", data_api: "ok", d1: "ok", r2: "ng: R2 unreachable", do: "ok" } });
    const run = await smoke(["--env", "dev", "--smoke"], { healthz: () => Response.json(broken, { status: 503 }) });
    expect(run.code).toBe(EXIT_NG);
    expect(run.out).toContainEqual(expect.stringMatching(/^smoke: NG \[r2\] /));
    expect(run.out.at(-1)).toBe("deploy-worker: NG  smoke（env=dev）");
    expectNothingSecret(run);
  });

  it("--sha が配った版と違えば exit 1（--expect-sha として照合する）", async () => {
    const run = await smoke(["--env", "dev", "--smoke", "--sha", "fedcba9"]);
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("version が --expect-sha と一致しない");
  });

  it.each([
    ["staging", ["--env", "staging", "--smoke"], "--smoke は dev だけ。staging の宛先は CI の staging 環境の Secret SMOKE_BASE_URL"],
    ["production", ["--env", "production", "--smoke"], "--smoke は dev だけ。production の宛先は CI の production 環境の Secret SMOKE_BASE_URL"],
    ["--target と一緒", ["--env", "dev", "--smoke", "--target", "host", "--sha", SHA], "--smoke は --target・--rollback-to と一緒に使わない"],
    ["--rollback-to と一緒", ["--env", "dev", "--smoke", "--rollback-to", SHA], "--smoke は --target・--rollback-to と一緒に使わない"],
    ["--sha が SHA でない（値を出さない）", ["--env", "dev", "--smoke", "--sha", SUBDOMAIN], "--sha は 7〜40 桁の 16 進"],
  ])("%s は API を呼ばずに exit 1", async (_, argv, message) => {
    const run = await smoke(argv);
    expect(run.code).toBe(EXIT_NG);
    expect(run.urls).toEqual([]);
    expect(run.all).toContain(`deploy-worker: ${message}`);
    expectNothingSecret(run);
  });

  it.each([
    ["資格情報が無い", {}, "CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る"],
    ["production のアカウント", { ...CREDENTIALS, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID_HEX }, "production のアカウント"],
  ])("%s なら API を呼ばずに exit 1", async (_, env, message) => {
    const run = await smoke(["--env", "dev", "--smoke"], { env });
    expect(run.code).toBe(EXIT_NG);
    expect(run.urls).toEqual([]);
    expect(run.all).toContain(message);
    expectNothingSecret(run);
  });

  it.each([
    ["権限が無い（403）", () => Response.json({ success: false, errors: [{ code: 10000, message: `denied ${ACCOUNT_ID_HEX}` }] }, { status: 403 }), "Workers のサブドメインを読む権限が無い（HTTP 403）"],
    ["サブドメインが無い", () => Response.json({ success: true, result: { subdomain: null } }), "Workers のサブドメインが読めない"],
    ["JSON でない", () => new Response(`<html>${SUBDOMAIN}</html>`, { status: 502 }), "応答が JSON でない（HTTP 502）"],
  ])("サブドメインが読めない（%s）なら、host を叩かずに exit 1", async (_, subdomain, message) => {
    const run = await smoke(["--env", "dev", "--smoke"], { subdomain });
    expect(run.code).toBe(EXIT_NG);
    expect(run.urls).toEqual([SUBDOMAIN_API]);
    expect(run.all).toContain(message);
    expectNothingSecret(run);
  });

  it("Cloudflare の API に届かなければ、URL を出さずに exit 1", async () => {
    const run = await smoke(["--env", "dev", "--smoke"], { unreachable: true });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("Cloudflare の API に届かない（ECONNREFUSED）");
    expectNothingSecret(run);
  });
});

// ── 9. reproduce-dev.sh（試験A）────────────────────────────────────────────────────

describe("reproduce-dev.sh：試験A の ①〜⑤ を1本で流す（偽の terraform と pnpm）", () => {
  const SCRIPT = join(ROOT, "infra/scripts/reproduce-dev.sh");
  const HEAD = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const TF_VERSION = readFileSync(join(ROOT, ".terraform-version"), "utf8").trim();
  const PROD_ACCOUNT_HEX = "1a2b3c4d5e6f708192a3b4c5d6e7f809";

  /** .env の形の目印。production の資格情報も混ぜ、どの段にも届かないことを見る */
  const CREDENTIALS: Readonly<Record<string, string>> = {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID_HEX,
    CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT_HEX,
    TF_CLOUDFLARE_API_TOKEN: "fixture-tf-token-8c1d4e",
    CLOUDFLARE_API_TOKEN: "fixture-ci-token-3b7a9f",
    TF_CLOUDFLARE_API_TOKEN_PROD: "fixture-tf-prod-token-5e2c",
    CLOUDFLARE_API_TOKEN_PROD: "fixture-ci-prod-token-9a4b",
    MUSUBI_PROBE_TOKEN_PROD: PROBE_TOKEN,
    R2_ACCESS_KEY_ID: "fixture-r2-key-6d0e2a",
    R2_SECRET_ACCESS_KEY: "fixture-r2-secret-1f8b3c",
    R2_S3_ENDPOINT: `https://${ACCOUNT_ID_HEX}.r2.cloudflarestorage.com`,
    TFSTATE_BUCKET: "musubi-tfstate",
  };
  /** 手元のシェルに残っていそうな値。どの段にも届かないはず */
  const STRAY_ENV: Readonly<Record<string, string>> = {
    MUSUBI_PROBE_TOKEN: "fixture-stray-probe-token-47d1",
    SMOKE_PROBE_TOKEN: "fixture-stray-smoke-token-8b2e",
    SMOKE_BASE_URL: `https://musubi-production-host.${SUBDOMAIN}.workers.dev`,
    AWS_SESSION_TOKEN: "fixture-stray-aws-session-3c9f",
    CLOUDFLARE_ENV: "production",
    TF_VAR_account_id_prod: PROD_ACCOUNT_HEX,
  };
  const SECRET_VALUES = [...Object.values(CREDENTIALS).filter((v) => v !== "musubi-tfstate"), ...Object.values(STRAY_ENV).filter((v) => v !== "production")];

  interface ScriptCall {
    readonly cmd: "terraform" | "pnpm";
    readonly args: readonly string[];
    /** 資格情報の形の環境変数（FAKE_* を除く）と CLOUDFLARE_ENV */
    readonly env: Readonly<Record<string, string>>;
  }

  interface ScriptRun {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly all: string;
    readonly calls: readonly ScriptCall[];
  }

  let dir: string;
  let bin: string;
  let seq = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "reproduce-dev-test-"));
    bin = join(dir, "bin");
    mkdirSync(bin);
    // 受けた引数と、資格情報の形の環境変数を記録する（値は作り物）
    const record = [
      "#!/usr/bin/env node",
      'const { appendFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      "const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FAKE_') && /TOKEN|SECRET|ACCOUNT|^AWS_|^TF_VAR_|^R2_|^SMOKE_|^MUSUBI_|^CLOUDFLARE_/.test(k)));",
      "appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ cmd: require('node:path').basename(process.argv[1]), args, env }) + '\\n');",
      "const out = (s) => process.stdout.write(s + '\\n');",
      "const { FAKE_ACCOUNT: ACC, FAKE_SUB: SUB } = process.env;",
    ];
    writeFileSync(
      join(bin, "terraform"),
      [
        ...record,
        "const sub = args.find((a) => !a.startsWith('-'));",
        "if (sub === 'version') { out(`Terraform v${process.env.FAKE_TF_VERSION}`); out('on linux_amd64'); }",
        "if (sub === 'init') { out('Initializing the backend...'); out(`Successfully configured the backend \"s3\" (https://${ACC}.r2.cloudflarestorage.com)`); out('Terraform has been successfully initialized!'); }",
        "if (sub === 'destroy') { out('module.env.cloudflare_d1_database.control: Destroying... [id=0f6c9f7e-1a2b-4c3d-8e9f-0123456789ab]'); out('module.env.cloudflare_d1_database.control: Destruction complete after 1s'); out('Destroy complete! Resources: 5 destroyed.'); }",
        "if (sub === 'apply') { out(`module.env.cloudflare_queue.build: Creation complete after 1s [id=${ACC}]`); out('Apply complete! Resources: 5 added, 0 changed, 0 destroyed.'); }",
        "if (sub === 'plan' && process.env.FAKE_PLAN_EXIT === '2') { out('  # module.env.cloudflare_d1_database.control will be updated in-place'); out(`      account_id = \"${ACC}\"`); out('Plan: 0 to add, 1 to change, 0 to destroy.'); process.exitCode = 2; }",
        "else if (sub === 'plan') { out('No changes. Your infrastructure matches the configuration.'); }",
        "if (process.env.FAKE_TF_FAIL === sub) { process.stderr.write(`Error: deleting /accounts/${ACC}/d1/database failed; see https://musubi-dev-host.${SUB}.workers.dev\\n`); process.exitCode = 1; }",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "pnpm"),
      [
        ...record,
        "if (args[0] === 'build') { out(`> musubi@ build ${process.cwd()}`); out(' Tasks:    11 successful, 11 total'); out('Cached:    9 cached, 11 total'); out('  Time:    5.778s'); }",
        "else { out(`fake: ${args.slice(2).join(' ')}`); }",
        "if (process.env.FAKE_PNPM_FAIL && args.join(' ').includes(process.env.FAKE_PNPM_FAIL)) { process.stderr.write(`fake failure at https://musubi-dev-host.${SUB}.workers.dev\\n`); process.exitCode = 1; }",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function reproduce(
    options: { envFile?: Readonly<Record<string, string>> | null; args?: readonly string[]; env?: Readonly<Record<string, string>> } = {},
  ): ScriptRun {
    const n = ++seq;
    const recordPath = join(dir, `record-${n}.jsonl`);
    const envFile = join(dir, `env-${n}`);
    const lines = Object.entries(options.envFile === undefined ? CREDENTIALS : (options.envFile ?? {})).map(([k, v]) => `${k}=${v}`);
    writeFileSync(envFile, `${lines.join("\n")}\n`);
    const result = spawnSync("bash", [SCRIPT, ...(options.args ?? ["--env-file", envFile])], {
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        HOME: dir,
        TMPDIR: dir,
        FAKE_RECORD: recordPath,
        FAKE_TF_VERSION: TF_VERSION,
        FAKE_ACCOUNT: ACCOUNT_ID_HEX,
        FAKE_SUB: SUBDOMAIN,
        ...STRAY_ENV,
        ...options.env,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const calls = existsSync(recordPath)
      ? readFileSync(recordPath, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as ScriptCall)
      : [];
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, all: `${result.stdout}${result.stderr}`, calls };
  }

  /** 引数のリポジトリのパスとログの置き場を置き換えた、呼び出しの1行 */
  const shown = (call: ScriptCall): string =>
    `${call.cmd} ${call.args.join(" ")}`
      .replaceAll(realpathSync(ROOT), "<root>")
      .replaceAll(ROOT, "<root>")
      .replace(/\S*\/reproduce-dev\.[A-Za-z0-9]+/g, "<logs>");

  function expectNothingSecret(run: ScriptRun): void {
    for (const value of SECRET_VALUES) expect(run.all).not.toContain(value);
    // commit の SHA（40 桁）は出してよい。Account ID の形（ちょうど 32 桁）だけを見る
    expect(run.all).not.toMatch(/\b[0-9a-f]{32}\b/i);
    expect(run.all).not.toMatch(/[a-z0-9_-]+\.workers\.dev/i);
    expect(run.all).not.toContain("[id=");
  }

  const TF = "terraform -chdir=<root>/infra/terraform/envs/dev";
  const DEPLOY = "pnpm exec tsx infra/scripts/deploy-worker.ts --env dev";
  const EXPECTED_CALLS = [
    "terraform version",
    "pnpm exec tsx infra/scripts/empty-buckets.ts --env dev",
    `${TF} init -input=false -lockfile=readonly -no-color`,
    `${TF} destroy -auto-approve -input=false -no-color`,
    `${TF} apply -auto-approve -input=false -no-color`,
    `${TF} plan -detailed-exitcode -input=false -lock=false -no-color`,
    "pnpm exec tsx infra/scripts/sync-bindings.ts --env dev",
    "pnpm exec tsx infra/scripts/sync-bindings.ts --env dev --check",
    "pnpm build",
    `${DEPLOY} --target migrate --log-dir <logs>`,
    `${DEPLOY} --target data-api --sha ${HEAD} --log-dir <logs>`,
    `${DEPLOY} --target gateway --sha ${HEAD} --log-dir <logs>`,
    `${DEPLOY} --target host --sha ${HEAD} --log-dir <logs>`,
    `${DEPLOY} --smoke --sha ${HEAD}`,
  ];

  it("成功：空にする → destroy → apply → 同期 → build → 配る → smoke の順に1回ずつ呼び、所要時間を出して exit 0", () => {
    const run = reproduce();
    expect(run.code, run.all).toBe(0);
    expect(run.calls.map(shown)).toEqual(EXPECTED_CALLS);

    for (const label of ["① 空にする（R2）", "① 消す（terraform destroy）", "② 作り直す（terraform apply）", "③ 同期（infra:sync）", "④ build（CLOUDFLARE_ENV=dev）", "④ 配る（migrate → data-api → gateway → host）", "⑤ 貫通スモーク"]) {
      expect(run.stdout).toContain(`reproduce-dev: ── ${label} ──`);
      expect(run.stdout).toMatch(new RegExp(`^ {2}${label.replace(/[()（）→]/g, ".")}: \\d+ 秒$`, "m"));
    }
    expect(run.stdout).toMatch(/^reproduce-dev: 合計（①〜⑤）: \d+ 秒（\d+ 分 \d\d 秒）。宣言した線 900 秒（15 分）以内$/m);
    // terraform と build は要約の行だけ（[id=…] を外し、backend の endpoint を含む init の行は出さない）
    expect(run.stdout).toContain("  module.env.cloudflare_d1_database.control: Destruction complete after 1s");
    expect(run.stdout).toContain("  Destroy complete! Resources: 5 destroyed.");
    expect(run.stdout).toContain("  module.env.cloudflare_queue.build: Creation complete after 1s");
    expect(run.stdout).toContain("  apply の後の plan: No changes（exit 0）");
    expect(run.stdout).toContain("   Tasks:    11 successful, 11 total");
    expect(run.stdout).not.toContain("Successfully configured the backend");
    expect(run.stdout).not.toContain("> musubi@ build");
    expect(run.stdout.trimEnd().split("\n").at(-1)).toBe(`reproduce-dev: OK  dev を消して作り直し、貫通スモークが通った（commit ${HEAD}）`);
    expectNothingSecret(run);
  });

  it("資格情報は、段ごとに要るものだけを渡す。production の資格情報と、手元のシェルに残った値はどの段にも届かない", () => {
    const run = reproduce();
    expect(run.code, run.all).toBe(0);
    const account = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID_HEX, CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT_HEX };
    const backend = {
      AWS_ACCESS_KEY_ID: CREDENTIALS["R2_ACCESS_KEY_ID"],
      AWS_SECRET_ACCESS_KEY: CREDENTIALS["R2_SECRET_ACCESS_KEY"],
      AWS_ENDPOINT_URL_S3: CREDENTIALS["R2_S3_ENDPOINT"],
    };
    const expected = (line: string): Record<string, string | undefined> => {
      if (line === "terraform version") return {};
      if (line.includes("empty-buckets.ts")) return { CLOUDFLARE_API_TOKEN: CREDENTIALS["TF_CLOUDFLARE_API_TOKEN"], ...account };
      if (line.startsWith("terraform ")) return { CLOUDFLARE_API_TOKEN: CREDENTIALS["TF_CLOUDFLARE_API_TOKEN"], TF_VAR_account_id: ACCOUNT_ID_HEX, ...backend };
      if (line.includes("sync-bindings.ts")) return backend;
      if (line === "pnpm build") return { CLOUDFLARE_ENV: "dev" };
      if (line.includes("deploy-worker.ts")) return { CLOUDFLARE_API_TOKEN: CREDENTIALS["CLOUDFLARE_API_TOKEN"], ...account };
      throw new Error(`想定外の呼び出し: ${line}`);
    };
    for (const call of run.calls) expect(call.env, shown(call)).toEqual(expected(shown(call)));
  });

  it("既定の .env が無くても、今のシェルの環境変数から読める（--env-file に空のファイル）", () => {
    const run = reproduce({ envFile: null, env: CREDENTIALS });
    expect(run.code, run.all).toBe(0);
    expect(run.calls.map(shown)).toEqual(EXPECTED_CALLS);
    const deploy = run.calls.find((call) => call.args.includes("--smoke"));
    expect(deploy?.env).toEqual({ CLOUDFLARE_API_TOKEN: CREDENTIALS["CLOUDFLARE_API_TOKEN"], CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID_HEX, CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT_HEX });
  });

  it("destroy が落ちたら、そこで止めて exit 1。伏せた全文と、そこまでの所要時間を出す", () => {
    const run = reproduce({ env: { FAKE_TF_FAIL: "destroy" } });
    expect(run.code).toBe(1);
    expect(run.calls.map(shown)).toEqual(EXPECTED_CALLS.slice(0, 4));
    expect(run.stderr).toContain("  Error: deleting /accounts/<REDACTED>/d1/database failed; see https://<REDACTED>.workers.dev");
    expect(run.stderr).toMatch(/reproduce-dev: NG {2}① 消す（terraform destroy） で止まった（exit 1）。①から \d+ 分 \d\d 秒。ログ: /);
    expect(run.stdout).toMatch(/^ {2}① 消す.terraform destroy.: \d+ 秒$/m);
    expect(run.stdout).not.toContain("② 作り直す");
    expectNothingSecret(run);
  });

  it("apply の後の plan に差分があれば、リソースのアドレスと Plan の行だけを出して止める（属性値は出さない）", () => {
    const run = reproduce({ env: { FAKE_PLAN_EXIT: "2" } });
    expect(run.code).toBe(1);
    expect(run.calls.map(shown)).toEqual(EXPECTED_CALLS.slice(0, 6));
    expect(run.stderr).toContain("    # module.env.cloudflare_d1_database.control will be updated in-place");
    expect(run.stderr).toContain("  Plan: 0 to add, 1 to change, 0 to destroy.");
    expect(run.stderr).not.toContain("account_id =");
    expect(run.stderr).toContain("② 作り直す（terraform apply） で止まった");
    expectNothingSecret(run);
  });

  it.each([
    ["空にする", "empty-buckets.ts", 2, "① 空にする（R2）"],
    ["同期の --check", "--check", 8, "③ 同期（infra:sync）"],
    ["host の配備", "--target host", 13, "④ 配る（migrate → data-api → gateway → host）"],
    ["smoke", "--smoke", 14, "⑤ 貫通スモーク"],
  ])("%s が落ちたら、そこで止めて exit 1", (_, failAt, calls, label) => {
    const run = reproduce({ env: { FAKE_PNPM_FAIL: failAt } });
    expect(run.code).toBe(1);
    expect(run.calls.map(shown)).toEqual(EXPECTED_CALLS.slice(0, calls));
    expect(run.stderr).toContain(`reproduce-dev: NG  ${label} で止まった（exit 1）`);
    expect(run.stdout).not.toMatch(/合計（①〜⑤）/);
  });

  it("build が落ちたら、伏せた全文を出して止める", () => {
    const run = reproduce({ env: { FAKE_PNPM_FAIL: "build" } });
    expect(run.code).toBe(1);
    expect(run.calls.map(shown)).toEqual(EXPECTED_CALLS.slice(0, 9));
    expect(run.stderr).toContain("  fake failure at https://<REDACTED>.workers.dev");
    expectNothingSecret(run);
  });

  it.each([
    ["資格情報が1つ足りない", { envFile: Object.fromEntries(Object.entries(CREDENTIALS).filter(([k]) => k !== "R2_SECRET_ACCESS_KEY")) }, "資格情報が無い: R2_SECRET_ACCESS_KEY"],
    ["CLOUDFLARE_ACCOUNT_ID が production のアカウント", { envFile: { ...CREDENTIALS, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID_HEX.toUpperCase() } }, "production のアカウント"],
    ["CLOUDFLARE_ACCOUNT_ID が Account ID の形でない", { envFile: { ...CREDENTIALS, CLOUDFLARE_ACCOUNT_ID: "fixture-not-an-account" } }, "Account ID の形"],
    ["--env-file のファイルが無い", { args: ["--env-file", "fixture-no-such-env-file"] }, "--env-file のファイルが無い"],
  ])("%s なら、terraform も pnpm も呼ばずに exit 1。値は出さない", (_, options, message) => {
    const run = reproduce(options);
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain(message);
    expectNothingSecret(run);
    expect(run.all).not.toContain("fixture-not-an-account");
  });

  it("terraform の版が .terraform-version と違えば、版を見ただけで止める", () => {
    const run = reproduce({ env: { FAKE_TF_VERSION: "0.0.1" } });
    expect(run.code).toBe(1);
    expect(run.calls.map(shown)).toEqual(["terraform version"]);
    expect(run.stderr).toContain(`terraform のバージョンが .terraform-version と一致しない（入っている: 0.0.1 / 期待: ${TF_VERSION}）`);
  });

  it("知らない引数は使い方を出して exit 2。--help は exit 0。どちらも何も呼ばない", () => {
    const bad = reproduce({ args: ["--yes"] });
    expect(bad.code).toBe(2);
    expect(bad.calls).toEqual([]);
    expect(bad.stderr).toContain("infra/scripts/reproduce-dev.sh [--env-file <file>]");
    const help = reproduce({ args: ["--help"] });
    expect(help.code).toBe(0);
    expect(help.calls).toEqual([]);
    expect(help.stdout).toContain("infra/scripts/reproduce-dev.sh [--env-file <file>]");
  });

  it("スクリプトは値を echo しない（set -x を使わない）。wrangler・terraform output・smoke を直接呼ばない", () => {
    const body = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(body).not.toMatch(/set -[a-z]*x|set -o xtrace/);
    expect(body).not.toMatch(/\bwrangler (?:deploy|d1|rollback|versions|deployments)|exec wrangler|terraform output|pnpm smoke|--base-url/);
    expect(body).not.toMatch(/echo [^\n]*\$\{?(tf_token|ci_token|account_id|r2_key|r2_secret|r2_endpoint)/);
  });
});
