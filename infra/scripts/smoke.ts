// pnpm smoke — デプロイ後に1回だけ host の /healthz を叩き、host → gateway → data-api → {D1, R2, DO} の貫通を判定する（03 §5）。
//
//   pnpm smoke --env <dev|staging|production> [--expect-sha <sha>] [--base-url <url>]
//
// 宛先は環境変数 SMOKE_BASE_URL（host の workers.dev のオリジン）。--base-url は手元用で、あれば SMOKE_BASE_URL より優先する。
// 環境変数 SMOKE_PROBE_TOKEN があれば X-Musunest-Probe ヘッダに載せる。**--env production では必須**（下の「production」）。
// 全層 ok なら exit 0、それ以外は exit 1（引数の誤りも 1）。
//
// ── 判定（上から順に見て、最初に当たったものを `smoke: NG [<層>] …` の1行で出す）──────────
//
//   [host]     届かない（接続失敗・タイムアウト）
//   [host]     想定外の HTTP ステータス（healthz は 200 か 503 しか返さない。リダイレクトは辿らない）
//   [host]     応答が JSON でない。HTML なら SPA シェル＝ /healthz が Worker に届いていない（assets.run_worker_first の設定漏れ）
//   [host]     詳細が隠された応答（{"ok": …} だけ）。X-Musunest-Probe が受け付けられていない
//   [host]     host の healthz の形でない（service・キー・値・HTTP ステータスとの整合）
//   [host]     env が --env と一致しない／version が --expect-sha と一致しない
//   [<check>]  checks のうち、手前の層は ok なのに ok でない層。gateway → data_api → d1 / r2 / do の順に辿る。
//              d1 / r2 / do は兄弟なので、切れた層が複数あれば並べる。切れた層より先は「未確認」として扱う
//
// 応答の形の正本は host の Worker の contract（apps/host/src/worker/contract.ts）。
// infra/scripts は workspace の外で host に依存しないので、checks のキーはここに書き写す（host が gateway の形を写すのと同じ）。
// 並びが食い違えば smoke.test.ts が落とす。
//
// ── production（詳細を隠す env）────────────────────────────────────────────
//
// production の host は、X-Musunest-Probe が secret MUSUNEST_PROBE_TOKEN と一致したときだけ詳細を返し、それ以外は
// {"ok": true|false} だけを返す（03 §5「セキュリティ上の注意」）。{"ok": true} からは env も version も層ごとの結果も読めない。
// だから --env production では SMOKE_PROBE_TOKEN を必須にし、無ければ1回も叩かずに exit 1 にする（--expect-sha を確かめられない緑を出さない）。
// どの env が隠すかは PROBE_REQUIRED_ENVS に書き写す（正本は host / gateway の wrangler.jsonc の vars.HEALTHZ_DETAIL。食い違えば smoke.test.ts が落とす）。
//   - CI では **production 環境の Secret** から渡す（v* タグ・承認必須のジョブだけが読める。CLAUDE.md「資格情報の置き場所」）
//   - 引数では受け取らない（pnpm がコマンド行をログに出す）。値は出力にもエラーにも出さない
//   - ヘッダに載らない文字（空白・改行・非 ASCII）は叩く前に弾く。Node の fetch はその値を含む文言で落ちる
//   - 平文の http の宛先には載せない。loopback（localhost・127.0.0.1・[::1]）だけは手元と試験のために許す
//
// ── 1回だけ・上限つき ──────────────────────────────────────────────────────
//
// **定期ポーリングしない**（06 §6：CI が無償枠を食う）。ok になった時点で終わる。
// 再試行するのはデプロイ直後の伝播待ちで直り得る失敗（届かない・想定外のステータス・version の不一致・checks の ng）だけで、
// 回数と総時間に上限を置く（RETRY_POLICY）。設定の誤り（JSON でない・形・env）は待っても直らないので、1回で落とす。
// 上限は初回デプロイの待ちに合わせてある（2026-09-14・Issue #16）。新しい Worker の workers.dev の経路が有効になるまで
// 404 が続く（staging の初回デプロイでは 4回続けて 404、5回目・約22秒後に成功）。production も初回デプロイなので、その5倍まで待つ。
//
// ── 安全面 ──────────────────────────────────────────────────────────────
//
// **宛先の URL を出力に出さない。** workers.dev のサブドメインが公開の CI ログに載ると、無償枠（100k req/日）を
// 他人に消費させる入口になる。出すのはパスと各層の判定だけ。
//   - fetch の例外文言はホスト名を含む。捨ててコード（ECONNREFUSED など）だけを出す
//   - URL として読めない値・引数の誤りも、値を表示しない（parseArgs の文言は位置引数をそのまま含む）
//   - CI では SMOKE_BASE_URL を **Secret** から渡す。Variable はステップの env 表示に平文で出る
//   - CI で --base-url を使わない。pnpm が実行するコマンド行を引数ごとログに出す
// 応答から持ち出す値（env・version・checks の文言）は JSON 文字列として出す。改行で行頭を偽装させない。
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ENVS, type Env } from "./sync-bindings.ts";

export const HEALTHZ_PATH = "/healthz";

/** 詳細版の healthz を求めるヘッダ。apps/host/src/worker/contract.ts の PROBE_HEADER と同じ。 */
export const PROBE_HEADER = "X-Musunest-Probe";

/** X-Musunest-Probe に載せる値を渡す環境変数。 */
export const PROBE_TOKEN_ENV = "SMOKE_PROBE_TOKEN";

/**
 * X-Musunest-Probe が無いと詳細を返さない env。host / gateway の wrangler.jsonc で vars.HEALTHZ_DETAIL が public でない env と同じ。
 * ここでは SMOKE_PROBE_TOKEN を必須にする。
 */
export const PROBE_REQUIRED_ENVS: readonly Env[] = ["production"];

/** host の healthz が返す checks のキー。apps/host/src/worker/contract.ts の HOST_HEALTHZ_CHECKS と同じ並び。 */
export const HOST_HEALTHZ_CHECKS = ["gateway", "data_api", "d1", "r2", "do"] as const;
export type Check = (typeof HOST_HEALTHZ_CHECKS)[number];
export type Layer = "host" | Check;

/** 各層の1つ手前の層（03 §1 のトポロジ）。手前が ok でない層は確かめられていない。 */
const UPSTREAM: Readonly<Record<Check, Layer>> = {
  gateway: "host",
  data_api: "gateway",
  d1: "data_api",
  r2: "data_api",
  do: "data_api",
};

export const EXIT_OK = 0;
export const EXIT_NG = 1;

export interface RetryPolicy {
  /** 試行の回数の上限（1回目を含む） */
  readonly maxAttempts: number;
  /** 失敗してから次の試行までの待ち */
  readonly retryIntervalMs: number;
  /** 1回の GET（本文の読み取りまで）の上限 */
  readonly requestTimeoutMs: number;
  /** 1回目の試行を始めてからの総時間の上限。これを超えて待たない・叩かない */
  readonly deadlineMs: number;
}

/**
 * 最悪でも 12 リクエスト・150 秒で終わる。
 *   - 待てる幅：試行の間の待ちが 11回 × 10 秒 = 110 秒。staging の初回デプロイで経路ができるまでの待ち（約22秒）の5倍
 *     （smoke.test.ts が偽の時計で確かめる）
 *   - 上限：deploy-staging の「merge → smoke green ≤ 10分」（04 §4）を、失敗したときでも 2分半しか削らない
 * 定期ポーリングではない。ok になった時点で終わるので、平常のデプロイは1リクエストのまま。
 */
export const RETRY_POLICY: RetryPolicy = {
  maxAttempts: 12,
  retryIntervalMs: 10_000,
  requestTimeoutMs: 10_000,
  deadlineMs: 150_000,
};

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class SmokeError extends Error {
  override name = "SmokeError";
}

/** host の healthz の応答（apps/host/src/worker/contract.ts の HostHealthzBody）。 */
export interface HostHealthz {
  readonly service: "host";
  readonly env: string;
  readonly version: string;
  readonly checks: Readonly<Record<Check, string>>;
  readonly elapsed_ms: number;
}

/** GET /healthz を1回行って観測したもの。 */
export type Observation =
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "response"; readonly status: number; readonly contentType: string | null; readonly text: string };

export interface Expectation {
  readonly env: Env;
  /** --expect-sha。与えなければ version を照合しない */
  readonly sha: string | undefined;
  /** X-Musunest-Probe を載せたか。詳細が隠された応答の理由を言い分けるのに使う */
  readonly probe?: boolean;
}

export type Verdict =
  | { readonly ok: true; readonly status: number; readonly body: HostHealthz }
  | {
      readonly ok: false;
      /** 切れた層。host 以外は checks から読んだ層で、兄弟（d1 / r2 / do）なら複数になる */
      readonly layers: readonly Layer[];
      readonly reason: string;
      /** デプロイの伝播待ちで直り得るか */
      readonly retryable: boolean;
      /** checks まで読めたとき（host の層は通った）だけある */
      readonly body?: HostHealthz;
      readonly status?: number;
    };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isCheck = (v: string): v is Check => (HOST_HEALTHZ_CHECKS as readonly string[]).includes(v);

const isEnv = (v: unknown): v is Env => typeof v === "string" && (ENVS as readonly string[]).includes(v);

/** 応答から持ち出した文字列を出すときの形。長さを切り、JSON 文字列にして改行・制御文字をエスケープする。 */
const show = (value: string): string => JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);

const seconds = (ms: number): string => `${ms / 1000} 秒`;

const ng = (layer: Layer, reason: string, retryable: boolean): Verdict => ({
  ok: false,
  layers: [layer],
  reason,
  retryable,
});

/** 純粋関数。1回の観測を判定する。 */
export function judge(observation: Observation, expected: Expectation): Verdict {
  if (observation.kind === "unreachable") return ng("host", observation.reason, true);

  const { status } = observation;
  if (status !== 200 && status !== 503) {
    const redirect = status >= 300 && status < 400 ? "。リダイレクトは辿らない" : "";
    return ng("host", `想定外の HTTP ステータス ${status}（healthz は 200 か 503${redirect}）`, true);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(observation.text);
  } catch {
    // 例外文言は本文の断片を含む。捨てる。
    if (isHtml(observation)) {
      return ng(
        "host",
        "応答が JSON でない: HTML が返った" +
          "（SPA シェルなら /healthz が Worker に届いていない。assets.run_worker_first を確かめる）",
        false,
      );
    }
    return ng("host", `応答が JSON でない（content-type: ${mediaType(observation.contentType)}）`, false);
  }

  if (isHiddenBody(raw)) {
    // secret の置き忘れ・値の食い違いは、待っても直らない
    const shown = JSON.stringify({ ok: raw.ok });
    return ng(
      "host",
      expected.probe === true
        ? `詳細が隠された応答（${shown} だけ）: X-Musunest-Probe が受け付けられなかった` +
            `（${PROBE_TOKEN_ENV} と host の secret MUSUNEST_PROBE_TOKEN が一致しているかを確かめる）`
        : `詳細が隠された応答（${shown} だけ）: この host は X-Musunest-Probe が無いと詳細を返さない` +
            `（${PROBE_TOKEN_ENV} を渡すか、host の vars.HEALTHZ_DETAIL を確かめる）`,
      false,
    );
  }

  const body = readBody(raw);
  if (typeof body === "string") return ng("host", `host の healthz の形でない: ${body}`, false);

  const allOk = HOST_HEALTHZ_CHECKS.every((check) => body.checks[check] === "ok");
  if (allOk !== (status === 200)) {
    return ng("host", `HTTP ${status} と checks が食い違う（全部 ok なら 200、1つでも ng なら 503 のはず）`, false);
  }

  if (body.env !== expected.env) {
    return ng(
      "host",
      `env が一致しない（期待 ${expected.env}、応答 ${show(body.env)}。宛先が別の環境の host を指していないか）`,
      false,
    );
  }
  if (expected.sha !== undefined && !body.version.toLowerCase().startsWith(expected.sha.toLowerCase())) {
    return ng(
      "host",
      `version が --expect-sha と一致しない（期待 ${expected.sha}、応答 ${show(body.version)}。デプロイが反映されていない）`,
      true,
    );
  }

  if (allOk) return { ok: true, status, body };

  const broken = HOST_HEALTHZ_CHECKS.filter((check) => body.checks[check] !== "ok" && reached(body, UPSTREAM[check]));
  const first = broken[0];
  if (first === undefined) {
    // 手前が全部 ok でない層は必ず1つある（gateway の手前は host で、host はここまでで ok）。型のための分岐。
    return ng("host", "checks から切れた層を決められない", false);
  }
  const values = broken.map((check) => (broken.length === 1 ? show(body.checks[check]) : `${check}=${show(body.checks[check])}`));
  return {
    ok: false,
    layers: broken,
    reason: `${values.join(", ")}（${pathTo(UPSTREAM[first]).join(" → ")} までは届いた）`,
    retryable: true,
    body,
    status,
  };
}

/** layer とその手前が全部 ok か。 */
function reached(body: HostHealthz, layer: Layer): boolean {
  return layer === "host" || (body.checks[layer] === "ok" && reached(body, UPSTREAM[layer]));
}

/** host から layer までの経路。 */
function pathTo(layer: Layer): Layer[] {
  return layer === "host" ? ["host"] : [...pathTo(UPSTREAM[layer]), layer];
}

/** 詳細を隠した healthz の応答（{"ok": true|false} だけ）か。 */
function isHiddenBody(raw: unknown): raw is { readonly ok: boolean } {
  return isRecord(raw) && typeof raw.ok === "boolean" && Object.keys(raw).length === 1;
}

function isHtml(observation: { readonly contentType: string | null; readonly text: string }): boolean {
  return mediaType(observation.contentType) === "text/html" || /^\s*</.test(observation.text);
}

/** content-type の media type だけを取り出す。パラメータと、トークンとして読めないものは出さない。 */
function mediaType(contentType: string | null): string {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "不明";
}

/** host の healthz の応答として読めれば返す。読めなければ理由（値を含まない。応答の文字列は show を通す）を返す。 */
function readBody(raw: unknown): HostHealthz | string {
  if (!isRecord(raw)) return "JSON オブジェクトではない";
  if (raw.service !== "host") {
    return typeof raw.service === "string"
      ? `service が ${show(raw.service)}（host ではない Worker に届いた。宛先は host のオリジン）`
      : "service が無い";
  }
  if (typeof raw.env !== "string") return "env が文字列ではない";
  if (typeof raw.version !== "string") return "version が文字列ではない";
  if (typeof raw.elapsed_ms !== "number") return "elapsed_ms が数ではない";

  const checks = raw.checks;
  if (!isRecord(checks)) return "checks がオブジェクトではない";
  const missing = HOST_HEALTHZ_CHECKS.filter((check) => !Object.hasOwn(checks, check));
  if (missing.length > 0) return `checks に ${missing.join(", ")} が無い`;
  const unknown = Object.keys(checks).filter((key) => !isCheck(key));
  if (unknown.length > 0) return `checks に契約に無いキーがある（${unknown.map(show).join(", ")}）`;
  const invalid = HOST_HEALTHZ_CHECKS.filter((check) => {
    const value = checks[check];
    return value !== "ok" && !(typeof value === "string" && value.startsWith("ng: "));
  });
  if (invalid.length > 0) return `checks の ${invalid.join(", ")} が "ok" でも "ng: …" でもない`;

  return raw as unknown as HostHealthz;
}

/** GET /healthz を1回行う。例外は文言を捨て、種別だけを残す。token があれば X-Musunest-Probe に載せる。 */
export async function observe(
  url: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  token?: string,
): Promise<Observation> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...(token === undefined ? {} : { [PROBE_HEADER]: token }) },
      // 3xx は healthz の応答ではない。辿らずに判定する（Location も出さない）
      redirect: "manual",
      // 本文の読み取りまで含めて打ち切る
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { kind: "response", status: res.status, contentType: res.headers.get("content-type"), text };
  } catch (e) {
    return { kind: "unreachable", reason: describeFetchError(e, timeoutMs) };
  }
}

function describeFetchError(e: unknown, timeoutMs: number): string {
  if (e instanceof Error && e.name === "TimeoutError") return `届かない: タイムアウト（${seconds(timeoutMs)}）`;
  // Node の fetch は TypeError("fetch failed") の cause に接続エラーを載せる。cause.message はホスト名とポートを含むので使わない。
  const cause = (e as { cause?: unknown }).cause;
  const code = isRecord(cause) ? cause.code : (e as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return `届かない（${code}）`;
  const kind = e instanceof Error && /^\w+$/.test(e.name) ? e.name : typeof e;
  return `届かない（${kind}）`;
}

/** 判定の1行。`smoke: ` の後に続ける。 */
export function formatVerdict(verdict: Verdict): string {
  if (verdict.ok) {
    const { env, version, elapsed_ms } = verdict.body;
    return `OK  host → gateway → data_api → d1 / r2 / do（env=${env}, version=${show(version)}, elapsed_ms=${elapsed_ms}）`;
  }
  return `NG [${verdict.layers.join(", ")}] ${verdict.reason}`;
}

/** host の層を通ったときの層ごとの表。切れた層より先は値ではなく「未確認」を出す。 */
export function formatLayers(status: number, body: HostHealthz): string[] {
  const lines = [`  OK  ${"host".padEnd(8)}  HTTP ${status}`];
  for (const check of HOST_HEALTHZ_CHECKS) {
    const name = check.padEnd(8);
    const value = body.checks[check];
    if (!reached(body, UPSTREAM[check])) lines.push(`  --  ${name}  未確認`);
    else if (value === "ok") lines.push(`  OK  ${check}`);
    else lines.push(`  NG  ${name}  ${show(value)}`);
  }
  return lines;
}

export interface CliIo {
  /** 環境変数。SMOKE_BASE_URL と SMOKE_PROBE_TOKEN を読む */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  policy: RetryPolicy;
}

const USAGE = `usage: pnpm smoke --env <${ENVS.join("|")}> [--expect-sha <sha>] [--base-url <url>]

  --env <env>         宛先の host が名乗るべき環境。応答の env と照合する
  --expect-sha <sha>  応答の version（deploy の --var GIT_SHA）と照合する。先頭 7 桁以上
  --base-url <url>    host のオリジン。手元用。CI では使わない（pnpm がコマンド行をログに出す）

宛先の既定は環境変数 SMOKE_BASE_URL（CI では Secret から渡す）。URL は一切表示しない。
環境変数 ${PROBE_TOKEN_ENV} があれば ${PROBE_HEADER} ヘッダに載せる。--env ${PROBE_REQUIRED_ENVS.join(" / ")} では必須
（その host はこれが無いと詳細を返さない。CI では production 環境の Secret から渡す）。値は一切表示しない。
GET ${HEALTHZ_PATH} をデプロイ後に1回だけ叩く（定期ポーリングしない）。
伝播待ちの再試行は最大 ${RETRY_POLICY.maxAttempts} 回・${seconds(RETRY_POLICY.deadlineMs)}まで。
全層 ok なら exit ${EXIT_OK}、それ以外は exit ${EXIT_NG}。`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof SmokeError) {
      io.err(`smoke: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない（URL を含み得る）。種別だけ出す。
      io.err(`smoke: 予期しない失敗（${e instanceof Error ? e.name : typeof e}）`);
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
        "expect-sha": { type: "string" },
        "base-url": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    // parseArgs の文言は引数をそのまま含む（URL を位置引数で渡した誤りなど）。コードだけで言い分ける。
    const code = (e as { code?: unknown }).code;
    const what =
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? "知らないオプションがある"
        : code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
          ? "位置引数は取らない"
          : code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
            ? "オプションの値が無い"
            : "読めない";
    throw new SmokeError(`引数が不正: ${what}（値は表示しない）\n${USAGE}`);
  }
}

/** 宛先のオリジンから /healthz の URL を作る。値はエラーにも出さない。 */
export function healthzUrl(raw: string | undefined, source: string): URL {
  if (raw === undefined || raw === "") {
    throw new SmokeError(`宛先が無い: 環境変数 SMOKE_BASE_URL（または --base-url）に host のオリジンを渡す\n${USAGE}`);
  }
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    // TypeError の input に値がそのまま入る。捨てる。
    throw new SmokeError(`${source} が URL として読めない（値は表示しない）`);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new SmokeError(`${source} は http(s) の URL を書く（値は表示しない）`);
  }
  if (base.username !== "" || base.password !== "" || base.pathname !== "/" || base.search !== "" || base.hash !== "") {
    throw new SmokeError(`${source} はオリジンだけを書く。パス・クエリ・資格情報を含めない（値は表示しない）`);
  }
  return new URL(HEALTHZ_PATH, base);
}

/** ループバックの宛先か。X-Musunest-Probe を http で載せてよいのはここだけ（手元の wrangler dev と試験）。 */
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/**
 * SMOKE_PROBE_TOKEN を読む。未設定と空（GitHub Actions は無い Secret を空文字にする）は undefined。
 * 値はエラーにも出さない。
 */
export function probeToken(raw: string | undefined, env: Env): string | undefined {
  if (raw === undefined || raw === "") {
    if (PROBE_REQUIRED_ENVS.includes(env)) {
      throw new SmokeError(
        `--env ${env} では環境変数 ${PROBE_TOKEN_ENV} が要る（この host は ${PROBE_HEADER} が無いと詳細を返さず、` +
          "env も version も確かめられない。CI では production 環境の Secret から渡す）。1回も叩かずに止める",
      );
    }
    return undefined;
  }
  // ヘッダの値として送れるのは、空白を含まない表示可能な ASCII だけにする（前後の空白は fetch が黙って削り、照合が食い違う）
  if (!/^[\x21-\x7e]+$/.test(raw)) {
    throw new SmokeError(`${PROBE_TOKEN_ENV} にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）`);
  }
  return raw;
}

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const values = parseCliArgs(argv);
  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (values.env === undefined) throw new SmokeError(`--env が無い\n${USAGE}`);
  const env = values.env;
  if (!isEnv(env)) throw new SmokeError(`未知の env（${ENVS.join(" / ")} のいずれか。値は表示しない）`);
  const sha = values["expect-sha"];
  if (sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new SmokeError("--expect-sha は 7〜40 桁の 16 進（commit の SHA）を渡す（値は表示しない）");
  }
  const token = probeToken(io.env[PROBE_TOKEN_ENV], env);
  const url =
    values["base-url"] !== undefined
      ? healthzUrl(values["base-url"], "--base-url")
      : healthzUrl(io.env["SMOKE_BASE_URL"], "SMOKE_BASE_URL");
  if (token !== undefined && url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new SmokeError(
      `${PROBE_TOKEN_ENV} を平文の http の宛先に載せない。宛先は https のオリジンにする（localhost・127.0.0.1・[::1] は除く。値は表示しない）`,
    );
  }
  const expected: Expectation = { env, sha, probe: token !== undefined };
  const { policy } = io;

  const shown = [
    `env=${env}`,
    ...(sha === undefined ? [] : [`expect-sha=${sha}`]),
    // 値は出さない。付けたことだけを出す
    ...(token === undefined ? [] : [`${PROBE_HEADER} 付き`]),
  ];
  io.out(`smoke: GET ${HEALTHZ_PATH}（${shown.join(", ")}）`);

  const startedAt = io.now();
  for (let attempt = 1; ; attempt++) {
    const remaining = policy.deadlineMs - (io.now() - startedAt);
    const timeoutMs = Math.max(1, Math.min(policy.requestTimeoutMs, remaining));
    const verdict = judge(await observe(url, io.fetch, timeoutMs, token), expected);

    if (verdict.ok) {
      for (const line of formatLayers(verdict.status, verdict.body)) io.out(line);
      io.out(`smoke: ${formatVerdict(verdict)}`);
      return EXIT_OK;
    }

    // 待った後に1回叩ける時間が残っているときだけ再試行する。総時間の上限を超えて待たない。
    const left = policy.deadlineMs - (io.now() - startedAt);
    if (verdict.retryable && attempt < policy.maxAttempts && left > policy.retryIntervalMs) {
      const wait = seconds(policy.retryIntervalMs);
      io.out(`smoke: 試行 ${attempt}/${policy.maxAttempts} ${formatVerdict(verdict)} … ${wait}後に再試行`);
      await io.sleep(policy.retryIntervalMs);
      continue;
    }

    if (verdict.body !== undefined && verdict.status !== undefined) {
      for (const line of formatLayers(verdict.status, verdict.body)) io.out(line);
    }
    if (!verdict.retryable) {
      if (attempt > 1) io.out("smoke: 待っても直らない失敗なので、再試行を止めた");
    } else if (attempt >= policy.maxAttempts) {
      io.out(`smoke: 試行 ${attempt}/${policy.maxAttempts} 回で打ち切った`);
    } else {
      io.out(`smoke: 総時間の上限（${seconds(policy.deadlineMs)}）に達するので打ち切った（試行 ${attempt} 回）`);
    }
    io.out(`smoke: ${formatVerdict(verdict)}`);
    return EXIT_NG;
  }
}

const defaultIo: CliIo = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (input, init) => fetch(input, init),
  now: () => performance.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  policy: RETRY_POLICY,
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
