// infra:empty-buckets — dev の R2 バケット（BUNDLES・UPLOADS）のオブジェクトを全部消す（試験A ①。05 §1・infra/terraform/README.md §4）。
//
//   pnpm infra:empty-buckets --env dev [--dry-run]
//
// なぜ要るか：R2 バケットはオブジェクトが残っていると terraform destroy が失敗する。provider v5 に force_destroy 相当は無い（README §4）。
// そして data-api の /healthz は BUNDLES に probe のオブジェクト（packages/data-api/src/cloudflare.ts の PROBE_OBJECT_KEY）を書くので、
// dev で1回でも貫通スモークを通したら、BUNDLES は空ではない。
//
// ── dev だけ ────────────────────────────────────────────────────────────────
//
// --env dev 以外（staging・production・未知の値）は、設定も資格情報も読まず、API も呼ばずに exit 1。さらに二重に止める：
//   - 消す先のバケット名は packages/data-api/wrangler.jsonc の env.dev.r2_buckets（infra:sync が terraform output から書き戻す欄）から読み、
//     Terraform のモジュールの名前の形（`<name_prefix>-dev-bundles`・`<name_prefix>-dev-uploads`）でなければ1つも消さない
//   - CLOUDFLARE_ACCOUNT_ID が CLOUDFLARE_ACCOUNT_ID_PROD と同じなら1つも消さない（production はアカウント②。00b D-1）
//
// ── どう消すか ──────────────────────────────────────────────────────────────
//
// wrangler にはオブジェクトの一覧のコマンドが無い（wrangler 4.131.1 の r2 object は get / put / delete だけ）。
// R2 の S3 互換キーは tfstate のバケットだけに限ってある（00 H-03）。だから Cloudflare の API をトークン
// （CLOUDFLARE_API_TOKEN。Workers R2 Storage: Edit を持つもの。00 H-02）で呼ぶ。
//
//   一覧 … GET    /accounts/<id>/r2/buckets/<bucket>/objects
//   削除 … DELETE /accounts/<id>/r2/buckets/<bucket>/objects/<key>（wrangler r2 object delete と同じ経路）
//
// 続きのページ（cursor）には頼らない。「最初のページを読む → 並んだキーを全部消す → また最初のページを読む」を空になるまで繰り返す。
// 空の一覧を読めたことが「destroy が通る」の根拠になる。
//   - 消したはずのキーがまた並んだら止める（消えていない・消している間に書かれた）
//   - 1バケットで消すのは MAX_DELETIONS 件まで（dev に想定外の量が溜まっているなら、黙って消し続けずに人に返す）
//   - 途中で止まっても、もう一度動かせば残りから消す。バケットが無い（HTTP 404）なら消すものは無いとして進む（destroy の後にもう一度動かしたとき）
//
// --dry-run は最初のページを読んで件数を出すだけで、消さない。
//
// ── 安全面（CLAUDE.md「このリポジトリは public である」）─────────────────────────
//
// 出すのはバケットの binding・名前（どちらも wrangler.jsonc に書いてある）と件数だけ。
// **キーは出さない**（UPLOADS のキーは利用者のファイル名になりうる）。トークン・Account ID も出さない。
// API のエラーは code と、伏せて長さを切った message だけを出す。想定外の例外は種別だけを出す。
import { realpathSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { redact } from "./deploy-worker.ts";
import { ENVS, type Env } from "./sync-bindings.ts";

/** オブジェクトを消してよい env。**dev だけ**（README §4「dev だけは壊して直すを日常化する」）。 */
export const EMPTYABLE_ENVS: readonly Env[] = ["dev"];

/** 消す先のバケット名を読む設定（リポジトリルートからの相対パス）。R2 を binding しているのは data-api だけ。 */
export const BUCKET_CONFIG = "packages/data-api/wrangler.jsonc";

/** 消すバケットの binding と、Terraform のモジュールが付ける名前の末尾（infra/terraform/modules/musunest-env/main.tf の `${local.p}-<末尾>`）。 */
export const BUCKETS = { BUNDLES: "bundles", UPLOADS: "uploads" } as const;
export type BucketBinding = keyof typeof BUCKETS;

/** 1バケットで消すオブジェクトの上限。超えるなら止めて人に返す。 */
export const MAX_DELETIONS = 10_000;

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** 1回の API 呼び出しの上限 */
export const REQUEST_TIMEOUT_MS = 30_000;

export const EXIT_OK = 0;
export const EXIT_NG = 1;

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class EmptyError extends Error {
  override name = "EmptyError";
}

export interface Bucket {
  readonly binding: BucketBinding;
  readonly name: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBinding = (v: string): v is BucketBinding => Object.hasOwn(BUCKETS, v);

/**
 * 純粋関数。data-api の wrangler.jsonc のテキストから、env の BUNDLES と UPLOADS のバケット名を読む。
 * 知らない binding がある・どちらかが無い・名前が Terraform の形でない なら EmptyError（1つも消さない）。
 */
export function readBuckets(text: string, env: Env): Bucket[] {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first !== undefined) throw new EmptyError(`${BUCKET_CONFIG} が壊れている（${printParseErrorCode(first.error)}）`);
  const block = isRecord(config) && isRecord(config["env"]) ? config["env"][env] : undefined;
  const list = isRecord(block) ? block["r2_buckets"] : undefined;
  if (!Array.isArray(list)) throw new EmptyError(`${BUCKET_CONFIG} に env.${env}.r2_buckets が無い`);

  const found = new Map<BucketBinding, string>();
  for (const [index, entry] of list.entries()) {
    const binding = isRecord(entry) ? entry["binding"] : undefined;
    const name = isRecord(entry) ? entry["bucket_name"] : undefined;
    if (typeof binding !== "string" || typeof name !== "string") {
      throw new EmptyError(`${BUCKET_CONFIG} の env.${env}.r2_buckets[${index}] に文字列の binding と bucket_name が無い`);
    }
    if (!isBinding(binding)) {
      throw new EmptyError(
        `${BUCKET_CONFIG} の env.${env}.r2_buckets に empty-buckets が知らない binding（${binding}）がある。` +
          "Terraform の資源と empty-buckets の BUCKETS を先に揃える。1つも消さない",
      );
    }
    // Terraform のモジュールが付ける名前の形。env の段が違う（staging・production のバケット）なら消さない
    if (!new RegExp(`^[a-z0-9][a-z0-9-]*-${env}-${BUCKETS[binding]}$`).test(name)) {
      throw new EmptyError(
        `${BUCKET_CONFIG} の env.${env}.r2_buckets[${binding}] の bucket_name が <name_prefix>-${env}-${BUCKETS[binding]} の形でない。1つも消さない`,
      );
    }
    found.set(binding, name);
  }
  const missing = (Object.keys(BUCKETS) as BucketBinding[]).filter((binding) => !found.has(binding));
  if (missing.length > 0) throw new EmptyError(`${BUCKET_CONFIG} の env.${env}.r2_buckets に ${missing.join(", ")} が無い`);
  return (Object.keys(BUCKETS) as BucketBinding[]).map((binding) => ({ binding, name: found.get(binding) ?? "" }));
}

// ── 資格情報 ─────────────────────────────────────────────────────────────────

export interface Credentials {
  readonly token: string;
  readonly accountId: string;
}

/** CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を読む。production のアカウントなら止める。値はエラーにも出さない。 */
export function readCredentials(env: Readonly<Record<string, string | undefined>>): Credentials {
  const token = env["CLOUDFLARE_API_TOKEN"];
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"];
  if (token === undefined || token === "" || accountId === undefined || accountId === "") {
    throw new EmptyError(
      "環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る（アカウント①のトークン。Workers R2 Storage: Edit を持つもの）",
    );
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new EmptyError("CLOUDFLARE_API_TOKEN にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）");
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new EmptyError("CLOUDFLARE_ACCOUNT_ID が Account ID の形（32 桁の 16 進）でない（値は表示しない）");
  }
  const production = env["CLOUDFLARE_ACCOUNT_ID_PROD"];
  if (production !== undefined && production.toLowerCase() === accountId.toLowerCase()) {
    throw new EmptyError("CLOUDFLARE_ACCOUNT_ID が production のアカウント（CLOUDFLARE_ACCOUNT_ID_PROD）を指している。1つも消さない");
  }
  return { token, accountId };
}

// ── API の形 ─────────────────────────────────────────────────────────────────

/** オブジェクトの一覧の API のパス。 */
export const listPath = (accountId: string, bucket: string): string => `/accounts/${accountId}/r2/buckets/${bucket}/objects`;

/**
 * オブジェクトを消す API のパス。キーの `/` はそのまま段にし（wrangler r2 object delete と同じ）、段ごとに URL エンコードする。
 * URL の解決は `.` と `..` の段（`%2e` も）を畳み、別のキーを指してしまうので、そうなるキーは消さない。
 */
export function objectPath(accountId: string, bucket: string, key: string): string {
  if (key === "") throw new EmptyError("空のキーは消さない（一覧の API を指してしまう）");
  const path = `${listPath(accountId, bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  if (new URL(`${CLOUDFLARE_API}${path}`).pathname !== `${new URL(CLOUDFLARE_API).pathname}${path}`) {
    throw new EmptyError("URL の経路で正しく指せないキー（. や .. の段を含む）がある。消さずに止める（キーは表示しない）");
  }
  return path;
}

export interface Page {
  readonly keys: readonly string[];
  /** 続きのページがある（--dry-run の件数に「以上」を付ける） */
  readonly truncated: boolean;
}

/** 一覧の API の応答（{ success, result: [{ key, … }], result_info: { cursor, is_truncated } }）を読む。 */
export function parsePage(body: unknown): Page {
  const result = isRecord(body) ? body["result"] : undefined;
  if (!isRecord(body) || body["success"] !== true || !Array.isArray(result)) {
    throw new EmptyError("オブジェクトの一覧の応答の形が想定と違う（success と result の配列）");
  }
  const keys = result.map((object) => (isRecord(object) ? object["key"] : undefined));
  if (!keys.every((key): key is string => typeof key === "string" && key !== "")) {
    throw new EmptyError("オブジェクトの一覧の応答の形が想定と違う（result の各要素に key が無い）");
  }
  const info = body["result_info"];
  const flag = isRecord(info) ? info["is_truncated"] : undefined;
  const cursor = isRecord(info) ? info["cursor"] : undefined;
  return { keys, truncated: typeof flag === "boolean" ? flag : typeof cursor === "string" && cursor !== "" };
}

/** API のエラーの要約。code と、伏せて長さを切った message を3つまで。 */
export function describeErrors(body: unknown, credentials: Credentials): string {
  const errors = isRecord(body) && Array.isArray(body["errors"]) ? body["errors"] : [];
  const shown = errors.slice(0, 3).map((e) => {
    const code = isRecord(e) && typeof e["code"] === "number" ? `code ${e["code"]}` : "code 不明";
    const raw = isRecord(e) && typeof e["message"] === "string" ? e["message"] : "";
    const message = redact(raw.length > 160 ? `${raw.slice(0, 160)}…` : raw, credentials.accountId, [credentials.token]);
    return message === "" ? code : `${code}: ${JSON.stringify(message)}`;
  });
  return shown.length === 0 ? "" : `（${shown.join(" / ")}）`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface CliIo {
  /** リポジトリルート */
  root: string;
  /** CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID・CLOUDFLARE_ACCOUNT_ID_PROD を読む */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Cloudflare の API を呼ぶ */
  fetch: typeof fetch;
  requestTimeoutMs: number;
}

const USAGE = `usage: pnpm infra:empty-buckets --env ${EMPTYABLE_ENVS.join("|")} [--dry-run]

  --env ${EMPTYABLE_ENVS.join("|")}   ${EMPTYABLE_ENVS.join(" / ")} だけ。${ENVS.filter((e) => !EMPTYABLE_ENVS.includes(e)).join(" / ")} は受け付けない
  --dry-run   最初のページを読んで件数を出すだけ。消さない

${BUCKET_CONFIG} の env.<env>.r2_buckets の ${Object.keys(BUCKETS).join(" / ")} のバケットのオブジェクトを全部消す（terraform destroy の前に）。
資格情報は環境変数 CLOUDFLARE_API_TOKEN（Workers R2 Storage: Edit）と CLOUDFLARE_ACCOUNT_ID。production のアカウントなら止める。
出すのはバケットと件数だけ（キー・トークン・Account ID は出さない）。
空になれば exit ${EXIT_OK}、それ以外は exit ${EXIT_NG}。`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof EmptyError) {
      io.err(`empty-buckets: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない（キー・Account ID を含み得る）。種別だけ出す。
      const kind = e instanceof Error ? e.name : typeof e;
      const code = (e as { code?: unknown }).code;
      io.err(`empty-buckets: 予期しない失敗（${kind}${typeof code === "string" ? ` ${code}` : ""}）`);
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
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    // parseArgs の文言は引数をそのまま含む。コードだけで言い分ける（deploy-worker.ts と同じ）。
    const code = (e as { code?: unknown }).code;
    const what =
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? "知らないオプションがある"
        : code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
          ? "位置引数は取らない"
          : code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
            ? "オプションの値が無い"
            : "読めない";
    throw new EmptyError(`引数が不正: ${what}（値は表示しない）\n${USAGE}`);
  }
}

const isEnv = (v: string): v is Env => (ENVS as readonly string[]).includes(v);

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const values = parseCliArgs(argv);
  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (values.env === undefined) throw new EmptyError(`--env が無い\n${USAGE}`);
  if (!isEnv(values.env)) throw new EmptyError(`未知の env（${EMPTYABLE_ENVS.join(" / ")} だけを受け付ける。値は表示しない）`);
  const env = values.env;
  if (!EMPTYABLE_ENVS.includes(env)) {
    throw new EmptyError(`--env ${env} は受け付けない（オブジェクトを消すのは ${EMPTYABLE_ENVS.join(" / ")} だけ）。何も読まずに止める`);
  }
  const dryRun = values["dry-run"] === true;

  let text: string;
  try {
    text = readFileSync(join(io.root, BUCKET_CONFIG), "utf8");
  } catch {
    throw new EmptyError(`${BUCKET_CONFIG} が読めない`);
  }
  const buckets = readBuckets(text, env);
  const credentials = readCredentials(io.env);

  io.out(
    `empty-buckets: env=${env} の R2 バケット（${buckets.map((b) => b.binding).join("・")}）の` +
      (dryRun ? "オブジェクトを数える（--dry-run。消さない）" : "オブジェクトを全部消す。キーは表示しない"),
  );
  let total = 0;
  for (const bucket of buckets) total += await emptyBucket(io, credentials, bucket, dryRun);
  io.out(
    dryRun
      ? `empty-buckets: OK  --dry-run なので何も消していない`
      : `empty-buckets: OK  env=${env} の R2 バケット ${buckets.length} つが空になった（消した ${total} 件）`,
  );
  return EXIT_OK;
}

interface ApiResponse {
  readonly status: number;
  /** JSON として読めなければ undefined（DELETE は本文が空のことがある） */
  readonly body: unknown;
}

async function callApi(io: CliIo, credentials: Credentials, method: "GET" | "DELETE", path: string, what: string): Promise<ApiResponse> {
  let res: Response;
  try {
    res = await io.fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${credentials.token}` },
      signal: AbortSignal.timeout(io.requestTimeoutMs),
    });
  } catch (e) {
    // 例外の文言は URL（Account ID・バケット・キー）を含み得る。種別だけを出す
    const cause = (e as { cause?: unknown }).cause;
    const code = isRecord(cause) ? cause["code"] : (e as { code?: unknown }).code;
    const kind = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : e instanceof Error && /^\w+$/.test(e.name) ? e.name : typeof e;
    throw new EmptyError(`${what}: Cloudflare の API に届かない（${kind}）`);
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

/** 2xx でなければ（404 を許すときは 404 も除く）止める。 */
function ensureOk(res: ApiResponse, what: string, credentials: Credentials): void {
  if (res.status === 401 || res.status === 403) {
    throw new EmptyError(
      `${what}: 権限が無い（HTTP ${res.status}${describeErrors(res.body, credentials)}）。` +
        "CLOUDFLARE_API_TOKEN に Workers R2 Storage: Edit が要る（トークンを作り直さずに止める）",
    );
  }
  if (res.status === 429) {
    throw new EmptyError(`${what}: Cloudflare の API のレート制限に掛かった。5 分以上空けて、もう一度動かす（残りから消す）`);
  }
  if (res.status < 200 || res.status > 299 || (isRecord(res.body) && res.body["success"] === false)) {
    throw new EmptyError(`${what}: HTTP ${res.status}${describeErrors(res.body, credentials)}`);
  }
}

/** 1つのバケットを空にする（dryRun なら数えるだけ）。消した件数を返す。 */
async function emptyBucket(io: CliIo, credentials: Credentials, bucket: Bucket, dryRun: boolean): Promise<number> {
  const label = `${bucket.binding}（${bucket.name}）`;
  const deleted = new Set<string>();
  for (let round = 1; ; round++) {
    const listed = await callApi(io, credentials, "GET", listPath(credentials.accountId, bucket.name), `${label} の一覧を読む`);
    if (listed.status === 404) {
      io.out(`  ${label}: バケットが無い（HTTP 404${describeErrors(listed.body, credentials)}）。${deleted.size === 0 ? "消すものは無い" : `消した ${deleted.size} 件`}`);
      return deleted.size;
    }
    ensureOk(listed, `${label} の一覧を読む`, credentials);
    const page = parsePage(listed.body);

    if (dryRun) {
      io.out(`  ${label}: ${page.keys.length} 件${page.truncated ? " 以上（続きのページがある）" : ""}`);
      return 0;
    }
    if (page.keys.length === 0) {
      io.out(`  ${label}: 空（消した ${deleted.size} 件）`);
      return deleted.size;
    }
    const again = page.keys.filter((key) => deleted.has(key)).length;
    if (again > 0) {
      throw new EmptyError(
        `${label}: 消したはずのオブジェクトが ${again} 件、また一覧に並んだ（消えていないか、消している間に書かれた。dev の /healthz を叩いていないか）。止める`,
      );
    }
    if (deleted.size + page.keys.length > MAX_DELETIONS) {
      throw new EmptyError(
        `${label}: 消すオブジェクトが ${MAX_DELETIONS} 件を超える。dev に想定外の量が溜まっている。消した ${deleted.size} 件で止めて人に返す`,
      );
    }
    for (const key of page.keys) {
      const path = objectPath(credentials.accountId, bucket.name, key);
      const what = `${label} のオブジェクトを消す（${deleted.size + 1} 件目）`;
      const res = await callApi(io, credentials, "DELETE", path, what);
      // 404 は既に無い（次の一覧で、本当に消えたかを確かめる）
      if (res.status !== 404) ensureOk(res, what, credentials);
      deleted.add(key);
    }
    io.out(`  ${label}: ${round} 巡目で ${page.keys.length} 件消した（計 ${deleted.size} 件）。一覧を読み直す`);
  }
}

const defaultIo: CliIo = {
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (input, init) => fetch(input, init),
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
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
