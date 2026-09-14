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
// 並び（migrate → data-api → gateway → host → smoke）はワークフローが持つ（.github/workflows/deploy-staging.yml・deploy-production.yml）。
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
//
// ── Worker の secret（production の host と gateway の MUSUBI_PROBE_TOKEN）──────────────────────
//
// production の host と gateway は、X-Musubi-Probe が secret MUSUBI_PROBE_TOKEN と一致したときだけ /healthz の詳細を返す
// （03 §5「セキュリティ上の注意」）。secret の無い production の host は常に {"ok": false}（503）になり、貫通スモークが通らない。
// だから **詳細を隠す env（smoke.ts の PROBE_REQUIRED_ENVS）の gateway と host を配るときは、毎回 secret を一緒に載せる**
// （2026-09-14・Issue #16 の決定。手で wrangler secret put をしない）。
//   - 値は同じ名前の環境変数から読む。CI では **production 環境の Secret** MUSUBI_PROBE_TOKEN を、そのステップの env にだけ渡す
//   - 無ければ wrangler を起動せずに exit 1（secret の無い production を配らない）。ヘッダに載らない文字（smoke.ts と同じ規則）と、
//     短すぎる値（PROBE_TOKEN_MIN_LENGTH 未満）も弾く。値はエラーにも出さない
//   - 値は一時ディレクトリ（0700）の中のファイル（0600）に JSON で書き、wrangler deploy --secrets-file に渡し、
//     wrangler が終わったらすぐに消す（成功しても失敗しても）。ログに出すのは secret の名前だけ
//   - wrangler の子プロセスには、この環境変数を渡さない（ファイルで渡す）
//   - wrangler は secret の値を "(hidden)" と表示するが、伏せる側でも値を持って伏せる（上の Account ID と同じ）
//   - --secrets-file は足し算で、ファイルに無い secret を消さない（wrangler 4.131.1 の deploy --help）
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROBE_REQUIRED_ENVS } from "./smoke.ts";
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

/** X-Musubi-Probe と照合する Worker の secret。apps/host/src/worker/contract.ts・apps/gateway/src/contract.ts の PROBE_TOKEN_SECRET と同じ。 */
export const PROBE_TOKEN_SECRET = "MUSUBI_PROBE_TOKEN";

/** /healthz の詳細を隠す Worker（wrangler.jsonc に vars.HEALTHZ_DETAIL を持つもの）。詳細を隠す env ではこれらに secret を載せる。 */
export const PROBE_TARGETS: readonly WorkerTarget[] = ["gateway", "host"];

/** MUSUBI_PROBE_TOKEN の長さの下限。短い値は総当たりで当たる（例：`openssl rand -hex 32` は 64 文字） */
export const PROBE_TOKEN_MIN_LENGTH = 32;

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
  /** wrangler に渡す引数（--secrets-file を除く。一時ファイルのパスは動かすときに決まる） */
  readonly args: readonly string[];
  /** 一緒に載せる Worker の secret の名前。値は同じ名前の環境変数から読み、--secrets-file で渡す */
  readonly secrets: readonly string[];
}

/** 純粋関数。target と env から、配るときに載せる Worker の secret の名前を決める。 */
export function secretsFor(target: Target, env: Env): readonly string[] {
  return target !== "migrate" && PROBE_TARGETS.includes(target) && PROBE_REQUIRED_ENVS.includes(env) ? [PROBE_TOKEN_SECRET] : [];
}

/** 純粋関数。target と env から wrangler の呼び方を決める。 */
export function wranglerCall(target: Target, env: Env, sha: string | undefined): WranglerCall {
  if (target === "migrate") {
    if (sha !== undefined) throw new DeployError("--target migrate は --sha を取らない（GIT_SHA は Worker の配備で渡す）");
    return {
      kind: "migrate",
      cwd: ".",
      args: ["d1", "migrations", "apply", MIGRATION_DATABASE, "--env", env, "--config", MIGRATION_CONFIG, "--remote"],
      secrets: [],
    };
  }
  if (sha === undefined) {
    throw new DeployError(`--target ${target} には --sha が要る（host の /healthz の version になり、smoke の --expect-sha が照合する）`);
  }
  return {
    kind: "deploy",
    cwd: WORKER_DIRS[target],
    args: ["deploy", "--env", env, "--var", `GIT_SHA:${sha}`],
    secrets: secretsFor(target, env),
  };
}

/**
 * 載せる secret の値を環境変数から読む。無い・空・ヘッダに載らない文字・短すぎる値は、wrangler を起動する前に落とす。
 * 値はエラーにも出さない。
 */
export function readSecrets(names: readonly string[], env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new DeployError(
        `環境変数 ${name} が要る（この env の Worker は secret ${name} が無いと /healthz の詳細を返さず、貫通スモークが通らない。` +
          "CI では production 環境の Secret から渡す）。wrangler を起動せずに止める",
      );
    }
    // X-Musubi-Probe に載せる値。smoke.ts の SMOKE_PROBE_TOKEN と同じく、空白を含まない表示可能な ASCII だけ
    if (!/^[\x21-\x7e]+$/.test(value)) {
      throw new DeployError(`${name} にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）`);
    }
    if (value.length < PROBE_TOKEN_MIN_LENGTH) {
      throw new DeployError(
        `${name} が短すぎる（${PROBE_TOKEN_MIN_LENGTH} 文字以上にする。例：openssl rand -hex 32。値も長さも表示しない）`,
      );
    }
    values[name] = value;
  }
  return values;
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
export const REDACTED_SECRET = "<伏せた:secret>";

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** 1行を伏せる。accountId は環境変数 CLOUDFLARE_ACCOUNT_ID の値（あれば）、secrets は載せた Worker の secret の値。 */
export function redact(line: string, accountId?: string, secrets: readonly string[] = []): string {
  let out = stripAnsi(line);
  // secret を先に伏せる（Account ID の形をした値でも、secret として伏せたことが読めるように）
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED_SECRET);
  }
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
export function summarize(kind: WranglerCall["kind"], text: string, accountId?: string, secrets: readonly string[] = []): string[] {
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
  return picked.map((line) => neutralize(redact(line, accountId, secrets)));
}

/** 失敗したときの全文。伏せてから返す。 */
export function failureLines(text: string, accountId?: string, secrets: readonly string[] = []): string[] {
  return linesOf(text).map((line) => neutralize(redact(line, accountId, secrets)));
}

// ── CLI ─────────────────────────────────────────────────────────────────

export interface CliIo {
  /** リポジトリルート */
  root: string;
  /**
   * 子プロセスへ渡す環境変数。CLOUDFLARE_ACCOUNT_ID（伏せる値）、RUNNER_TEMP（--log-dir と secret の一時ファイルの置き場の既定）、
   * 載せる Worker の secret（MUSUBI_PROBE_TOKEN。子プロセスには渡さない）もここから読む
   */
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

${PROBE_REQUIRED_ENVS.join(" / ")} の ${PROBE_TARGETS.join(" / ")} は、環境変数 ${PROBE_TOKEN_SECRET} の値を secret として一緒に載せる（必須）。
値は一時ファイルに書いて --secrets-file で渡し、wrangler が終わったらすぐ消す。値は一切表示しない。
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
  const secrets = readSecrets(call.secrets, io.env);

  const tempBase = io.env["RUNNER_TEMP"] ?? tmpdir();
  const logDir = resolve(values["log-dir"] ?? tempBase);
  const logPath = join(logDir, `deploy-worker-${env}-${target}.log`);
  const accountId = io.env["CLOUDFLARE_ACCOUNT_ID"];
  const secretValues = Object.values(secrets);
  const label = `${target}（env=${env}）`;

  // 一時ファイルのパスは毎回変わるので、載せる secret の名前だけを出す
  const shownArgs = [...call.args, ...(call.secrets.length === 0 ? [] : ["--secrets-file", `<一時ファイル: ${call.secrets.join(", ")}>`])];
  io.out(`deploy-worker: ${label}: wrangler ${shownArgs.join(" ")}（${call.cwd}）`);
  const code = await runWrangler(io, call, logPath, secrets, resolve(tempBase));
  const text = readFileSync(logPath, "utf8");

  if (code === 0) {
    const lines = summarize(call.kind, text, accountId, secretValues);
    io.out(`deploy-worker: wrangler の出力は ${logPath} に受けた。ここには workers.dev のホスト名と Account ID を伏せた要約だけを出す`);
    if (lines.length === 0) io.out("  （要約に当たる行が無い。wrangler の出力の形が変わった可能性がある）");
    for (const line of lines) io.out(`  ${line}`);
    io.out(`deploy-worker: OK  ${label}`);
    return EXIT_OK;
  }

  io.out(`deploy-worker: wrangler が exit ${code} で終わった。出力（${logPath}）の全文を、workers.dev のホスト名と Account ID を伏せて出す`);
  for (const line of failureLines(text, accountId, secretValues)) io.out(`  ${line}`);
  io.out(`deploy-worker: NG  ${label}`);
  return EXIT_NG;
}

/**
 * wrangler を1回動かし、標準出力と標準エラーを logPath に受ける。exit code を返す（シグナルで終われば 1）。
 * secrets があれば tempBase の下の一時ディレクトリにファイルで書いて --secrets-file で渡し、wrangler が終わったら消す。
 */
async function runWrangler(
  io: CliIo,
  call: WranglerCall,
  logPath: string,
  secrets: Readonly<Record<string, string>>,
  tempBase: string,
): Promise<number> {
  const [command, ...prefix] = io.wrangler;
  if (command === undefined) throw new DeployError("wrangler を起動するコマンドが無い");
  // 載せる secret の環境変数は子プロセスに渡さない（ファイルで渡す）
  const childEnv: Record<string, string | undefined> = { ...io.env, FORCE_COLOR: "0" };
  delete childEnv[PROBE_TOKEN_SECRET];
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  let secretsDir: string | undefined;
  try {
    const args = [...call.args];
    if (call.secrets.length > 0) {
      // mkdtemp は 0700 で作る。ファイルは 0600・既存なら失敗（wx）
      secretsDir = mkdtempSync(join(tempBase, "deploy-worker-secrets-"));
      const secretsFile = join(secretsDir, "secrets.json");
      writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
      args.push("--secrets-file", secretsFile);
    }
    return await new Promise<number>((done, fail) => {
      const child = spawn(command, [...prefix, ...args], {
        cwd: join(io.root, call.cwd),
        // 色を切る（伏せる前に ANSI も落とすが、出さないに越したことはない）。stdin を渡さない：確認は非対話の既定値で進む
        env: childEnv,
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
    // 成功しても失敗しても、wrangler が終わったらすぐ消す
    if (secretsDir !== undefined) rmSync(secretsDir, { recursive: true, force: true });
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
