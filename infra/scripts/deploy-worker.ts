// deploy-worker — CD（deploy-staging / deploy-production）が wrangler で D1 マイグレーションと Worker の配備を行う入口（04 §4）。
//
//   pnpm exec tsx infra/scripts/deploy-worker.ts --env <dev|staging|production> --target <migrate|data-api|gateway|host> [--sha <sha>] [--log-dir <dir>]
//
//   --target migrate   … wrangler d1 migrations apply CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc --remote
//                        （リポジトリ直下で。SQL は control-plane にあり、当てる先は data-api の設定の CONTROL_DB。docs/runbook/d1-migration.md）
//   --target data-api  … wrangler deploy --env <env> --var GIT_SHA:<sha>（packages/data-api で）
//   --target gateway   … 同（apps/gateway で）
//   --target host      … 同（apps/host で）。host は **CLOUDFLARE_ENV=<env> でビルドした出力**を配る（apps/host/wrangler.jsonc 冒頭）。
//                        別の env でビルドした出力なら wrangler が食い違いで落とす
//
// 並び（migrate → data-api → gateway → host → smoke）はワークフローが持つ（.github/workflows/deploy-staging.yml）。
// --sha は deploy に必須。host の /healthz の version になり、貫通スモークの --expect-sha がそれを照合する。
// wrangler が exit 0 なら exit 0、それ以外（引数の誤り・起動できない も含む）は exit 1。
//
// ── なぜ wrangler の出力をそのまま流さないか ─────────────────────────────────────
//
// wrangler deploy は配備の後に workers.dev の URL（https://<worker>.<アカウントのサブドメイン>.workers.dev）を表示する
// （wrangler 4.131.1 の triggers の配備）。サブドメインが公開の CI ログに載ると、無償枠（100k req/日）を他人に消費させる入口になる
// （smoke.ts と同じ理由。CLAUDE.md「このリポジトリは public である」）。
// だから wrangler の標準出力と標準エラーは**ファイルに受け**（--log-dir。既定は $RUNNER_TEMP、無ければ OS の一時ディレクトリ）、
// ログには次だけを出す。ファイルは CI のアーティファクトにしない（公開される）。
//
//   成功 … 要約（SUMMARY に当たる行）だけ。伏せてから出す
//   失敗 … 全文。伏せてから出す（原因が読めないと直せない）
//
// 伏せるもの（redact）：
//   - workers.dev のホスト名。サブドメインの段を全部まとめて `<伏せた>.workers.dev` にする
//   - Account ID の形（32 桁の 16 進）と、環境変数 CLOUDFLARE_ACCOUNT_ID の値。wrangler はエラーや案内に
//     /accounts/<id>/ や dash.cloudflare.com/<id>/ を出しうる。Secret の値は GitHub もマスクするが、文字列の一致だけなので伏せる側でも持つ
//   - ANSI エスケープは伏せる前に取り除く。色の切り替えがホスト名の途中に入ると一致しなくなり、OSC 8 のリンクは URL を運ぶ
// 行頭（空白の後を含む）の `::` は崩す。GitHub Actions のワークフローコマンドとして解釈させない。
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ENVS, type Env } from "./sync-bindings.ts";

export const TARGETS = ["migrate", "data-api", "gateway", "host"] as const;
export type Target = (typeof TARGETS)[number];
export type WorkerTarget = Exclude<Target, "migrate">;

/** 配る Worker と、wrangler deploy を動かすディレクトリ（リポジトリルートからの相対パス）。infra:sync の同期先と同じ集合。 */
export const WORKER_DIRS: Readonly<Record<WorkerTarget, string>> = {
  "data-api": "packages/data-api",
  gateway: "apps/gateway",
  host: "apps/host",
};

/** D1 マイグレーションを当てる先の設定（リポジトリルートからの相対パス）と binding。 */
export const MIGRATION_CONFIG = "packages/data-api/wrangler.jsonc";
export const MIGRATION_DATABASE = "CONTROL_DB";

export const EXIT_OK = 0;
export const EXIT_NG = 1;

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class DeployError extends Error {
  override name = "DeployError";
}

export interface WranglerCall {
  readonly kind: "migrate" | "deploy";
  /** wrangler を動かすディレクトリ（リポジトリルートからの相対パス。"." は直下） */
  readonly cwd: string;
  /** wrangler に渡す引数 */
  readonly args: readonly string[];
}

/** 純粋関数。target と env から wrangler の呼び方を決める。 */
export function wranglerCall(target: Target, env: Env, sha: string | undefined): WranglerCall {
  if (target === "migrate") {
    if (sha !== undefined) throw new DeployError("--target migrate は --sha を取らない（GIT_SHA は Worker の配備で渡す）");
    return {
      kind: "migrate",
      cwd: ".",
      args: ["d1", "migrations", "apply", MIGRATION_DATABASE, "--env", env, "--config", MIGRATION_CONFIG, "--remote"],
    };
  }
  if (sha === undefined) {
    throw new DeployError(`--target ${target} には --sha が要る（host の /healthz の version になり、smoke の --expect-sha が照合する）`);
  }
  return { kind: "deploy", cwd: WORKER_DIRS[target], args: ["deploy", "--env", env, "--var", `GIT_SHA:${sha}`] };
}

// ── 伏せる ─────────────────────────────────────────────────────────────────

// CSI（色・カーソル）、OSC（リンク。BEL か ST で終わる）、それ以外の2文字のエスケープ
// oxlint-disable-next-line no-control-regex -- ANSI エスケープを取り除くための意図した制御文字
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** workers.dev のホスト名（サブドメインの段を全部含む）。 */
export const WORKERS_DEV_HOST = /(?:[a-z0-9_-]+\.)+workers\.dev(?![a-z0-9_-])/gi;
const ACCOUNT_ID_SHAPE = /\b[0-9a-f]{32}\b/gi;

export const REDACTED_HOST = "<伏せた>.workers.dev";
export const REDACTED_ACCOUNT = "<伏せた:account>";

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** 1行を伏せる。accountId は環境変数 CLOUDFLARE_ACCOUNT_ID の値（あれば）。 */
export function redact(line: string, accountId?: string): string {
  let out = stripAnsi(line);
  // 短すぎる値で伏せると、関係の無い文字列まで崩す。Account ID は 32 桁
  if (accountId !== undefined && accountId.length >= 8) out = out.split(accountId).join(REDACTED_ACCOUNT);
  return out.replace(ACCOUNT_ID_SHAPE, REDACTED_ACCOUNT).replace(WORKERS_DEV_HOST, REDACTED_HOST);
}

/** 行頭（空白の後を含む）の `::` を崩す。GitHub Actions はそこから始まる行をワークフローコマンドとして読む。 */
export function neutralize(line: string): string {
  return line.replace(/^(\s*)::/, "$1: :");
}

/** wrangler の出力を行に分ける。ANSI を落とし、\r（スピナーの書き換え）も改行として扱う。末尾の空行は捨てる。 */
function linesOf(text: string): string[] {
  const lines = stripAnsi(text).split(/\r\n|\r|\n/);
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  return lines;
}

// ── 要約 ─────────────────────────────────────────────────────────────────

interface SummaryRule {
  readonly line: RegExp;
  /** 当たった行に続く、字下げされた行も要約に含める */
  readonly continuation?: boolean;
}

/**
 * 成功したときにログへ出す行（wrangler 4.131.1 の出力の形）。**許した行だけを出す。**
 * 知らない行に何が載るかは保証できないので、伏せる処理だけに頼らない。
 */
export const SUMMARY: Readonly<Record<WranglerCall["kind"], readonly SummaryRule[]>> = {
  deploy: [
    { line: /Success! Uploaded \d+ files?/ }, // Static Assets（host）
    { line: /^No updated asset files to upload/ },
    { line: /^Total Upload: / },
    { line: /^Worker Startup Time: / },
    { line: /^Your Worker has access to the following bindings:/ },
    { line: /^Binding\s+Resource\s*$/ },
    { line: /^env\.\S+ / }, // binding の表の行。GIT_SHA は --var で渡すので "(hidden)" と出る
    { line: /^Uploaded \S+ \(/ },
    // 続く字下げの行が配備先（workers.dev の URL）。伏せてから出す
    { line: /^Deployed \S+ triggers/, continuation: true },
    { line: /^No targets deployed for / },
    { line: /^Current Version ID: / },
    { line: /^▲ \[WARNING\] / },
  ],
  migrate: [
    { line: /^Resource location: / },
    { line: /No migrations to apply!/ },
    { line: /^Migrations to be applied:/ },
    { line: /^[┌├│└]/ }, // マイグレーションの表
    { line: /Using fallback value in non-interactive context:/ }, // 確認を CI で自動で yes にしたこと
    { line: /Executing on (?:remote|local) database / },
    { line: /^▲ \[WARNING\] / },
  ],
};

/** 成功したときの要約。許した行だけを、伏せてから返す。 */
export function summarize(kind: WranglerCall["kind"], text: string, accountId?: string): string[] {
  const rules = SUMMARY[kind];
  const picked: string[] = [];
  let continuing = false;
  for (const line of linesOf(text)) {
    if (continuing && /^\s+\S/.test(line)) {
      picked.push(line);
      continue;
    }
    const rule = rules.find((r) => r.line.test(line));
    continuing = rule?.continuation === true;
    if (rule !== undefined) picked.push(line);
  }
  return picked.map((line) => neutralize(redact(line, accountId)));
}

/** 失敗したときの全文。伏せてから返す。 */
export function failureLines(text: string, accountId?: string): string[] {
  return linesOf(text).map((line) => neutralize(redact(line, accountId)));
}

// ── CLI ─────────────────────────────────────────────────────────────────

export interface CliIo {
  /** リポジトリルート */
  root: string;
  /** 子プロセスへ渡す環境変数。CLOUDFLARE_ACCOUNT_ID（伏せる値）と RUNNER_TEMP（--log-dir の既定）もここから読む */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** wrangler を起動するコマンド（実行ファイルと、その前に置く引数） */
  wrangler: readonly string[];
}

const USAGE = `usage: pnpm exec tsx infra/scripts/deploy-worker.ts --env <${ENVS.join("|")}> --target <${TARGETS.join("|")}> [--sha <sha>] [--log-dir <dir>]

  --env <env>        配る先の環境。wrangler の --env に渡す
  --target <target>  migrate … D1 マイグレーション（${MIGRATION_CONFIG} の ${MIGRATION_DATABASE} に --remote で当てる）
                     ${Object.entries(WORKER_DIRS)
                       .map(([name, dir]) => `${name} … ${dir} で wrangler deploy`)
                       .join("\n                     ")}
  --sha <sha>        deploy に必須。--var GIT_SHA:<sha> で渡す（7〜40 桁の 16 進）
  --log-dir <dir>    wrangler の出力を受けるファイルの置き場。既定は $RUNNER_TEMP、無ければ OS の一時ディレクトリ

wrangler の出力はファイルに受け、ログには workers.dev のホスト名と Account ID を伏せた要約だけを出す（失敗したときは伏せた全文）。
wrangler が exit 0 なら exit ${EXIT_OK}、それ以外は exit ${EXIT_NG}。`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof DeployError) {
      io.err(`deploy-worker: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない。種別だけ出す。
      const kind = e instanceof Error ? e.name : typeof e;
      const code = (e as { code?: unknown }).code;
      io.err(`deploy-worker: 予期しない失敗（${kind}${typeof code === "string" ? ` ${code}` : ""}）`);
    }
    return EXIT_NG;
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        env: { type: "string" },
        target: { type: "string" },
        sha: { type: "string" },
        "log-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    // parseArgs の文言は引数をそのまま含む。コードだけで言い分ける（smoke.ts と同じ）。
    const code = (e as { code?: unknown }).code;
    const what =
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? "知らないオプションがある"
        : code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
          ? "位置引数は取らない"
          : code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
            ? "オプションの値が無い"
            : "読めない";
    throw new DeployError(`引数が不正: ${what}（値は表示しない）\n${USAGE}`);
  }
}

const isEnv = (v: string): v is Env => (ENVS as readonly string[]).includes(v);
const isTarget = (v: string): v is Target => (TARGETS as readonly string[]).includes(v);

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const values = parseCliArgs(argv);
  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (values.env === undefined) throw new DeployError(`--env が無い\n${USAGE}`);
  if (!isEnv(values.env)) throw new DeployError(`未知の env（${ENVS.join(" / ")} のいずれか。値は表示しない）`);
  if (values.target === undefined) throw new DeployError(`--target が無い\n${USAGE}`);
  if (!isTarget(values.target)) throw new DeployError(`未知の target（${TARGETS.join(" / ")} のいずれか。値は表示しない）`);
  const sha = values.sha;
  if (sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new DeployError("--sha は 7〜40 桁の 16 進（commit の SHA）を渡す（値は表示しない）");
  }
  const env = values.env;
  const target = values.target;
  const call = wranglerCall(target, env, sha);

  const logDir = resolve(values["log-dir"] ?? io.env["RUNNER_TEMP"] ?? tmpdir());
  const logPath = join(logDir, `deploy-worker-${env}-${target}.log`);
  const accountId = io.env["CLOUDFLARE_ACCOUNT_ID"];
  const label = `${target}（env=${env}）`;

  io.out(`deploy-worker: ${label}: wrangler ${call.args.join(" ")}（${call.cwd}）`);
  const code = await runWrangler(io, call, logPath);
  const text = readFileSync(logPath, "utf8");

  if (code === 0) {
    const lines = summarize(call.kind, text, accountId);
    io.out(`deploy-worker: wrangler の出力は ${logPath} に受けた。ここには workers.dev のホスト名と Account ID を伏せた要約だけを出す`);
    if (lines.length === 0) io.out("  （要約に当たる行が無い。wrangler の出力の形が変わった可能性がある）");
    for (const line of lines) io.out(`  ${line}`);
    io.out(`deploy-worker: OK  ${label}`);
    return EXIT_OK;
  }

  io.out(`deploy-worker: wrangler が exit ${code} で終わった。出力（${logPath}）の全文を、workers.dev のホスト名と Account ID を伏せて出す`);
  for (const line of failureLines(text, accountId)) io.out(`  ${line}`);
  io.out(`deploy-worker: NG  ${label}`);
  return EXIT_NG;
}

/** wrangler を1回動かし、標準出力と標準エラーを logPath に受ける。exit code を返す（シグナルで終われば 1）。 */
async function runWrangler(io: CliIo, call: WranglerCall, logPath: string): Promise<number> {
  const [command, ...prefix] = io.wrangler;
  if (command === undefined) throw new DeployError("wrangler を起動するコマンドが無い");
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  try {
    return await new Promise<number>((done, fail) => {
      const child = spawn(command, [...prefix, ...call.args], {
        cwd: join(io.root, call.cwd),
        // 色を切る（伏せる前に ANSI も落とすが、出さないに越したことはない）。stdin を渡さない：確認は非対話の既定値で進む
        env: { ...io.env, FORCE_COLOR: "0" },
        stdio: ["ignore", fd, fd],
      });
      child.on("error", (e) => {
        const code = (e as { code?: unknown }).code;
        fail(new DeployError(`wrangler を起動できない（${typeof code === "string" ? code : e.name}）`));
      });
      child.on("close", (exit) => done(exit ?? 1));
    });
  } finally {
    closeSync(fd);
  }
}

const requireFromHere = createRequire(import.meta.url);

const defaultIo: CliIo = {
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  // リポジトリ直下の devDependencies の wrangler を、今の Node で直接動かす（pnpm exec を挟まない）
  wrangler: [process.execPath, join(dirname(requireFromHere.resolve("wrangler/package.json")), "bin", "wrangler.js")],
};

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  void runCli(process.argv.slice(2), defaultIo).then((code) => {
    process.exitCode = code;
  });
}
