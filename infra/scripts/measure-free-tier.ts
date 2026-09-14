// measure-free-tier — Free の枠に対する余裕を、staging の host で実測する（Issue #25。06 §7 の要確認 1・2・4）。
//
//   pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts [--pages <m>] [--healthz <n>] [--cpu-limit-ms <ms>]
//   pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts --pages-window <since>/<until> --healthz-window <since>/<until> [--pages <m>] [--healthz <n>]
//
// 1つ目の形は、staging の host に GET を送り、Workers Analytics（GraphQL）に反映されるのを待って読み、判定する。
// 2つ目の形は GET を送らない。前に送った窓（1つ目の形が出力する）を Analytics から読み直すだけである。
// 資格情報は環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID（手元の .env の CI 用トークン。アカウント①）。
//
// ── なぜ Worker の中で測らないか ──────────────────────────────────────────────
//
// Workers の時計（performance.now・Date.now）は I/O のときにしか進まない。応答に「処理時間」を載せても CPU 時間にはならない。
// だから CPU 時間の正は Workers Analytics の invocation の cpuTime である（03 §5「無償枠の実測」）。
// Analytics は数分遅れて反映されるので、デプロイ直後の貫通スモーク（smoke.ts）には入れない（deploy-staging の 10分の線を削る）。
// 宛先はスモークと同じ staging の host で、スモークとは別に手元から回す。
//
// ── 何を送り、何を読むか ──────────────────────────────────────────────────────
//
//   ① Cloudflare の API で workers.dev のサブドメインを読み、host のオリジンを組み立てる（表示もファイルへの書き込みもしない）
//   ② ページ：/ と深いリンクを各 m 回。ブラウザのページ遷移と同じヘッダ（sec-fetch-mode: navigate）を付ける
//      PHASE_GAP を空けて、
//      /healthz を n 回。どちらも1回ずつ順に送り、SPAシェル（200 text/html）／全層 ok でなければその場で止める
//      合計は MAX_REQUESTS（50）以内。超える指定は1回も送らずに落とす
//   ③ Analytics を読む。2つの窓（ページ／healthz）を別々に集計し、2回続けて同じ値になったら反映済みとみなす
//        workersInvocationsAdaptive          … Worker（scriptName）ごとの sum.requests・sum.cpuTimeUs・max.cpuTime・
//                                              quantiles.cpuTimeP50/P99（cpuTime の単位はマイクロ秒）
//        workersAssetsRequestsAdaptiveGroups … Static Assets が返したリクエスト。hostname（host の workers.dev）で絞る
//   ④ 判定する
//        要確認 4 … ページの窓で Worker の起動が 0 で、assets の requests が送った数くらい → Static Assets は 100k/日 を消費しない
//        要確認 2 … healthz の窓で gateway・data-api の requests も送った数くらい → Service Binding の先も別の requests に数えられる
//        CPU     … Worker ごとの max の和（同じリクエストで3つとも max だった場合の上界）を上限と比べる。
//                   host の1回あたりの cpuTime が gateway・data-api の和より小さければ、host の値は下流を含まない（要確認 1）
//
// 窓は応答の Date ヘッダ（Cloudflare の時計）から作り、前後に WINDOW_PAD を足す。手元の時計のずれで窓がずれないようにするためである。
// ページの窓と healthz の窓が重なったら読まずに落とす（どちらのリクエストか区別できない）。
//
// ── サンプリング ────────────────────────────────────────────────────────────────
//
// Adaptive のデータセットは少ない数でも揺れる。2026-09-14 の実測では、20 回の起動が sampleInterval 1.5 の重みで 27 回・26 回と出たり、
// 重み 1 のまま 17 回と出たりした（ページ 20 回の assets は 22 回と 11 回）。だから回数を「送った数とぴったり」では比べない。
// 問いは「0 か、送った数くらいか」なので、半分から倍までを同じくらいとみなす（aboutSent）。
// CPU 時間の max と分位はサンプルから計算されるので、サンプリングがあれば取りこぼし得ると出力に書く。
//
// ── Worker 名が __unknown__ で返るとき ──────────────────────────────────────────
//
// 2026-09-14 の実測：その日の 08:01 UTC ごろに作られた staging の3つの Worker は、少なくとも 09:14 までの読み取りで scriptName（と scriptTag・
// environmentName）が __unknown__ で返り、09:33 には名前が入った。同じトークン・同じデータセットで、以前からある Worker の名前は読めた。
// だから権限でもデータセットや欄の選び方でもなく、新しい Worker の名前が Analytics に反映されるまでの遅れである（06 §7.1）。
// 名前の無い起動がある窓は判定しない（どの Worker か決められない）。時間を空けて、窓を指定して読み直す。
//
// ── Node の fetch を使わない GET ──────────────────────────────────────────────
//
// ページの GET は、ブラウザのページ遷移と同じヘッダ（sec-fetch-mode: navigate）で送る。Static Assets は、run_worker_first を配列で書かない
// 構成ではこのヘッダでナビゲーションを見分けて Worker を起動しない（一次情報：Static Assets の SPA のルーティング）。host は配列で書いているので
// ヘッダによらないはずだが、ブラウザと違う形で測ると、ルーティングの設定を変えたときに結論が黙って変わる。
// Node の fetch（undici）は sec-fetch-mode を cors に書き換えるので、host への GET は node:http(s) で送る。
//
// ── 安全面（CLAUDE.md「このリポジトリは public である」）────────────────────────────
//
// **出すのは回数・ミリ秒・判定・窓の時刻だけ。** URL・ホスト名・サブドメイン・Account ID・スクリプトの ID・トークンを出さない
// （スクリプトの ID は読みもしない）。API のエラーの文言は、それらを伏せ、長さを切ってから出す。
//   - 実環境への操作は読み取りだけ：サブドメインの GET、GraphQL の読み取り、staging の host への GET。書き込みの API を呼ばない
//   - production（アカウント②）には届かない：宛先は staging の Worker 名に固定し、CLOUDFLARE_ACCOUNT_ID が
//     CLOUDFLARE_ACCOUNT_ID_PROD と同じなら1回も送らずに落とす
//   - 権限が足りない（401・403・GraphQL の認可エラー）ときは、トークンを作らずに止める
//
// ── 終了コード ──────────────────────────────────────────────────────────────
//
//   0 … 反映を確かめ、3つとも判定でき、設計の前提（Static Assets は Worker を起動しない・チェーン合計が上限内）が成り立った
//   1 … 引数・資格情報・GET・API の失敗。または前提が崩れた（Worker が起動した・CPU が上限を超え得る）
//   2 … 判定できない（反映を待ちきれない・他のリクエストが混ざった・名前がまだ入っていない）。窓を指定して読み直す
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HEALTHZ_PATH, judge as judgeHealthz } from "./smoke.ts";
import type { Env } from "./sync-bindings.ts";

/** 測る環境。production は別アカウントで、詳細を隠す healthz なので測らない。dev は常設していない。 */
export const TARGET_ENV = "staging" as const satisfies Env;

/** 経路の順（host → gateway → data-api。03 §1）。 */
export const WORKERS = ["host", "gateway", "data-api"] as const;
export type Worker = (typeof WORKERS)[number];

/** Worker 名。正本は各 wrangler.jsonc の env.staging.name（食い違えば measure-free-tier.test.ts が落とす）。 */
export const scriptName = (worker: Worker): string => `musubi-${TARGET_ENV}-${worker}`;

/** Analytics が Worker の名前を決められないときの値。 */
export const UNKNOWN_SCRIPT = "__unknown__";

export const ROOT_PATH = "/";
/** SPA のルーティングに任せる深いリンク。host の受入試験（apps/host/src/worker/index.test.ts）と同じパス。 */
export const DEEP_LINK_PATH = "/communities/c1/apps";

/** ブラウザのページ遷移が付けるヘッダ。Static Assets はこれでナビゲーションを見分ける。 */
export const NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
  accept: "text/html",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
const HEALTHZ_HEADERS: Readonly<Record<string, string>> = { accept: "application/json" };

/** 1回の実測で host に送る GET の上限（Issue #25 で承認された枠）。 */
export const MAX_REQUESTS = 50;

/** Free の CPU 時間の上限（ミリ秒）。一次情報 https://developers.cloudflare.com/workers/platform/limits/#cpu-time（2026-09-14 に確認）。変わったら --cpu-limit-ms で与える。 */
export const FREE_CPU_LIMIT_MS = 10;

export interface Plan {
  /** / と深いリンクを、それぞれ何回送るか */
  readonly pages: number;
  /** /healthz を何回送るか */
  readonly healthz: number;
}

/** 既定は合計 40 回（上限 50 に 10 回の余裕）。 */
export const DEFAULT_PLAN: Plan = { pages: 10, healthz: 20 };

export const requestCount = (plan: Plan): number => plan.pages * 2 + plan.healthz;

export interface MeasurePolicy {
  /** 1回の GET（本文の読み取りまで）の上限 */
  readonly requestTimeoutMs: number;
  /** ページの GET と /healthz の GET の間を空ける時間。窓を分けるため */
  readonly phaseGapMs: number;
  /** 送り終えてから、最初に Analytics を読むまでの待ち */
  readonly firstReadDelayMs: number;
  /** Analytics を読み直す間隔 */
  readonly pollIntervalMs: number;
  /** 最初に読んでから、反映を待つ時間の上限 */
  readonly maxWaitMs: number;
}

/** GraphQL は1分に2回しか読まない（上限は 5 分に 300 回）。最悪でも 31 回・送り終えてから 16 分で終わる。 */
export const MEASURE_POLICY: MeasurePolicy = {
  requestTimeoutMs: 10_000,
  phaseGapMs: 8_000,
  firstReadDelayMs: 60_000,
  pollIntervalMs: 30_000,
  maxWaitMs: 15 * 60_000,
};

/** 窓の前後に足す幅。Date ヘッダは秒で切り捨てられ、Analytics の datetime はリクエストの始まりの秒なので。 */
export const WINDOW_PAD_MS = 2_000;

export const EXIT_OK = 0;
export const EXIT_NG = 1;
export const EXIT_UNDETERMINED = 2;

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class MeasureError extends Error {
  override name = "MeasureError";
}

// ── 資格情報と宛先 ──────────────────────────────────────────────────────────────

export interface Credentials {
  readonly token: string;
  readonly accountId: string;
}

/** CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を読む。値はエラーにも出さない。 */
export function readCredentials(env: Readonly<Record<string, string | undefined>>): Credentials {
  const token = env["CLOUDFLARE_API_TOKEN"];
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"];
  if (token === undefined || token === "" || accountId === undefined || accountId === "") {
    throw new MeasureError(
      "環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る（手元の .env の CI 用トークン。--env-file=.env で渡す）",
    );
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new MeasureError("CLOUDFLARE_API_TOKEN にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）");
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new MeasureError("CLOUDFLARE_ACCOUNT_ID が Account ID の形（32 桁の 16 進）でない（値は表示しない）");
  }
  const production = env["CLOUDFLARE_ACCOUNT_ID_PROD"];
  if (production !== undefined && production.toLowerCase() === accountId.toLowerCase()) {
    throw new MeasureError(
      "CLOUDFLARE_ACCOUNT_ID が production のアカウント（CLOUDFLARE_ACCOUNT_ID_PROD）を指している。staging（アカウント①）でしか測らない",
    );
  }
  return { token, accountId };
}

/** workers.dev のサブドメインとして読める形か（DNS のラベル）。 */
const isSubdomain = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);

/** host のホスト名。表示しない。 */
export const hostHostname = (subdomain: string): string => `${scriptName("host")}.${subdomain}.workers.dev`;

// ── 出力を伏せる ───────────────────────────────────────────────────────────────

/** API のエラーの文言を出せる形にする。秘密の値・32 桁の 16 進・UUID・workers.dev のホスト名を伏せ、長さを切る。 */
export function sanitize(message: string, secrets: readonly string[]): string {
  let text = message;
  for (const secret of secrets) if (secret !== "") text = text.split(secret).join("<伏せた>");
  text = text
    .replace(/[\w.-]+\.workers\.dev/gi, "<伏せた>.workers.dev")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<伏せた>")
    .replace(/\b[0-9a-f]{32}\b/gi, "<伏せた>");
  return JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
}

// ── host への GET ──────────────────────────────────────────────────────────────

export interface HttpResponse {
  readonly status: number;
  readonly contentType: string | null;
  /** Date ヘッダ（Cloudflare の時計） */
  readonly date: string | null;
  readonly text: string;
}

/** 1回の GET。失敗は例外にする（文言はホスト名を含み得るので、呼び出し側は種別だけを使う）。 */
export type HttpGet = (url: URL, headers: Readonly<Record<string, string>>, timeoutMs: number) => Promise<HttpResponse>;

const MAX_BODY_BYTES = 1024 * 1024;

const firstHeader = (value: IncomingHttpHeaders[string]): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

/**
 * node:http(s) で GET を1回送る。Node の fetch は sec-fetch-mode を書き換えるので使わない（冒頭「Node の fetch を使わない GET」）。
 * リダイレクトは辿らない。
 */
export const nodeGet: HttpGet = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const fail = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: "GET", headers: { ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(Object.assign(new Error("body too large"), { name: "BodyTooLarge" }));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode ?? 0,
          contentType: firstHeader(res.headers["content-type"]),
          date: firstHeader(res.headers.date),
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", fail);
    });
    timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs);
    req.on("error", fail);
    req.end();
  });

/** GET の例外を、値を含まない種別にする。 */
function describeGetError(e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return "タイムアウト";
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return e instanceof Error && /^\w+$/.test(e.name) ? e.name : typeof e;
}

/** content-type の media type だけ。読めないものは出さない。 */
function mediaType(contentType: string | null): string {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "不明";
}

/** ページの応答が SPAシェルか。Worker が受けていれば JSON（host の Worker は /healthz 以外に JSON の 404 を返す）になる。 */
export function checkPage(res: HttpResponse): string | undefined {
  if (res.status !== 200) return `HTTP ${res.status}（SPAシェルなら 200）`;
  const type = mediaType(res.contentType);
  if (type !== "text/html") return `content-type が ${type}（SPAシェルなら text/html。Worker が受けた疑い）`;
  return undefined;
}

/** /healthz の応答が全層 ok か。判定は貫通スモークと同じ（smoke.ts の judge）。 */
export function checkHealthz(res: HttpResponse): string | undefined {
  const verdict = judgeHealthz(
    { kind: "response", status: res.status, contentType: res.contentType, text: res.text },
    { env: TARGET_ENV, sha: undefined },
  );
  return verdict.ok ? undefined : `[${verdict.layers.join(", ")}] ${verdict.reason}`;
}

// ── 窓 ────────────────────────────────────────────────────────────────────────

/** Analytics を読む時間の窓（両端を含む。秒の精度の ISO 8601・UTC）。 */
export interface Window {
  readonly since: string;
  readonly until: string;
}

export interface PhaseRecord {
  readonly window: Window;
  /** 送ったリクエストの数（全部 ok だったもの） */
  readonly sent: number;
}

export interface DriveRecord {
  readonly pages: PhaseRecord;
  readonly healthz: PhaseRecord;
}

const toSecond = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** 観測した時刻の範囲から窓を作る。前後に WINDOW_PAD を足し、秒に丸める。 */
export function windowOf(firstMs: number, lastMs: number): Window {
  return {
    since: toSecond(Math.floor((firstMs - WINDOW_PAD_MS) / 1000) * 1000),
    until: toSecond(Math.ceil((lastMs + WINDOW_PAD_MS) / 1000) * 1000),
  };
}

/** `<since>/<until>` を読む。 */
export function parseWindow(raw: string, option: string): Window {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(raw);
  const since = match?.[1];
  const until = match?.[2];
  if (since === undefined || until === undefined || Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
    throw new MeasureError(`${option} は <since>/<until>（例 2026-09-14T09:00:00Z/2026-09-14T09:00:30Z）で書く`);
  }
  if (Date.parse(since) >= Date.parse(until)) throw new MeasureError(`${option} の since が until より後ろ`);
  return { since, until };
}

/** ページの窓が healthz の窓より前にあり、重ならないか。 */
function assertSeparated(record: DriveRecord): void {
  if (Date.parse(record.pages.window.until) >= Date.parse(record.healthz.window.since)) {
    throw new MeasureError("ページの窓と /healthz の窓が重なる。どちらのリクエストか区別できないので読まない");
  }
}

export const formatWindows = (record: DriveRecord, plan: Plan): string =>
  `--pages-window ${record.pages.window.since}/${record.pages.window.until} ` +
  `--healthz-window ${record.healthz.window.since}/${record.healthz.window.until} ` +
  `--pages ${plan.pages} --healthz ${plan.healthz}`;

// ── Analytics（GraphQL）────────────────────────────────────────────────────────

/**
 * 2つの窓を1回で読む。データセットと欄は一次情報とスキーマで確かめた（06 §7.1 の出典）。
 *   workersInvocationsAdaptive          … Worker（scriptName）ごとの起動の回数・cpuTime の和・max・分位
 *   workersAssetsRequestsAdaptiveGroups … Static Assets が返したリクエスト
 * scriptName_in に __unknown__ も入れる：名前がまだ入っていない起動を数え落とさない（冒頭「Worker 名が __unknown__ で返るとき」）。
 * workersAssetsRequestsAdaptiveGroups は statusCode を選ぶ。2026-09-14 の実測で、dimensions を選ばずに hostname で絞った集計は
 * 送ってから約 9 分空のままだった（statusCode を選ぶと、2回目の実測では約 1.5 分で読めた）。hostname は選ばない（応答にサブドメインを載せない）。
 */
const INVOCATION_FIELDS = `
        sum { requests errors cpuTimeUs }
        avg { sampleInterval }
        max { cpuTime }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { scriptName }`;

export const ANALYTICS_QUERY = `query MeasureFreeTier($accountTag: string!, $scripts: [string!]!, $hostname: string!, $pagesSince: Time!, $pagesUntil: Time!, $healthzSince: Time!, $healthzUntil: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      pagesInvocations: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $pagesSince, datetime_leq: $pagesUntil, scriptName_in: $scripts }) {${INVOCATION_FIELDS}
      }
      pagesAssets: workersAssetsRequestsAdaptiveGroups(limit: 100, filter: { datetime_geq: $pagesSince, datetime_leq: $pagesUntil, hostname: $hostname }) {
        sum { requests }
        dimensions { statusCode }
      }
      healthzInvocations: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $healthzSince, datetime_leq: $healthzUntil, scriptName_in: $scripts }) {${INVOCATION_FIELDS}
      }
    }
  }
}`;

export function analyticsVariables(accountId: string, hostname: string, record: DriveRecord): Record<string, unknown> {
  return {
    accountTag: accountId,
    scripts: [...WORKERS.map(scriptName), UNKNOWN_SCRIPT],
    hostname,
    pagesSince: record.pages.window.since,
    pagesUntil: record.pages.window.until,
    healthzSince: record.healthz.window.since,
    healthzUntil: record.healthz.window.until,
  };
}

/** workersInvocationsAdaptive の1行（scriptName ごと）。時間はマイクロ秒。 */
export interface InvocationRow {
  readonly scriptName: string;
  /** sum.requests。サンプリングされていれば重みを掛けた推定値 */
  readonly requests: number;
  readonly errors: number;
  readonly cpuTimeUs: number;
  readonly cpuMaxUs: number;
  readonly cpuP50Us: number;
  readonly cpuP99Us: number;
  readonly sampleInterval: number;
}

export interface Snapshot {
  readonly pages: { readonly invocations: readonly InvocationRow[]; readonly assets: number };
  readonly healthz: { readonly invocations: readonly InvocationRow[] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `sum.requests` のような経路で数を読む。 */
function readNumber(node: Record<string, unknown>, path: string): number {
  let value: unknown = node;
  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MeasureError(`Analytics の応答の形が違う: ${path} が数でない`);
  }
  return value;
}

function readRows(value: unknown, dataset: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new MeasureError(`Analytics の応答の形が違う: ${dataset} が行の配列でない`);
  }
  return value;
}

function readInvocations(value: unknown): InvocationRow[] {
  return readRows(value, "workersInvocationsAdaptive").map((node) => {
    const dimensions = node.dimensions;
    const name = isRecord(dimensions) ? dimensions.scriptName : undefined;
    if (typeof name !== "string") {
      throw new MeasureError("Analytics の応答の形が違う: workersInvocationsAdaptive の dimensions.scriptName が文字列でない");
    }
    return {
      scriptName: name,
      requests: readNumber(node, "sum.requests"),
      errors: readNumber(node, "sum.errors"),
      cpuTimeUs: readNumber(node, "sum.cpuTimeUs"),
      cpuMaxUs: readNumber(node, "max.cpuTime"),
      cpuP50Us: readNumber(node, "quantiles.cpuTimeP50"),
      cpuP99Us: readNumber(node, "quantiles.cpuTimeP99"),
      sampleInterval: readNumber(node, "avg.sampleInterval"),
    };
  });
}

/** GraphQL の認可エラーらしい文言か。 */
const AUTHZ_ERROR = /not authori[sz]ed|unauthori[sz]ed|authentication|permission|access denied|forbidden/i;

/** 権限が足りないときの失敗。トークンを作らずに止める（Issue #25）。 */
const permissionError = (what: string): MeasureError =>
  new MeasureError(
    `${what}の権限が足りない。トークンを作らずに止める（CI 用トークンの権限を人が確かめる。Analytics は Account Analytics: Read）`,
  );

/** GraphQL の応答を読む。errors があれば、伏せた文言で落とす。 */
export function parseAnalytics(body: unknown, secrets: readonly string[]): Snapshot {
  if (!isRecord(body)) throw new MeasureError("Analytics の応答が JSON オブジェクトでない");
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : ""));
    if (messages.some((m) => AUTHZ_ERROR.test(m))) throw permissionError("Analytics（GraphQL）を読む");
    throw new MeasureError(`Analytics がエラーを返した: ${messages.map((m) => sanitize(m, secrets)).join(", ")}`);
  }
  const data = body.data;
  const viewer = isRecord(data) ? data.viewer : undefined;
  const accounts = isRecord(viewer) ? viewer.accounts : undefined;
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!isRecord(account)) {
    throw new MeasureError("Analytics の応答にアカウントが無い（CLOUDFLARE_ACCOUNT_ID とトークンの対象アカウントを確かめる）");
  }
  return {
    pages: {
      invocations: readInvocations(account.pagesInvocations),
      assets: readRows(account.pagesAssets, "workersAssetsRequestsAdaptiveGroups").reduce(
        (total, row) => total + readNumber(row, "sum.requests"),
        0,
      ),
    },
    healthz: { invocations: readInvocations(account.healthzInvocations) },
  };
}

/**
 * 送った回数と、Analytics の回数が「同じくらい」か。Adaptive のデータセットは少ない数でも揺れる
 * （2026-09-14 実測：20 回が、サンプリングの重みで 27 回・26 回、取りこぼしで 17 回、assets は 11 回と出た）。
 * 問いは「0 か、送った数くらいか」なので、半分から倍までを同じくらいとみなす。
 */
export const aboutSent = (value: number, sent: number): boolean => value >= sent / 2 && value <= sent * 2;

const totalRequests = (rows: readonly InvocationRow[]): number => rows.reduce((total, row) => total + row.requests, 0);

/** 送った分が Analytics に出揃ったように見えるか（/healthz の窓の起動・ページの窓の assets が、送った数の半分以上）。 */
export const reflected = (snapshot: Snapshot, record: DriveRecord): boolean =>
  totalRequests(snapshot.healthz.invocations) >= record.healthz.sent / 2 && snapshot.pages.assets >= record.pages.sent / 2;

const rowsKey = (rows: readonly InvocationRow[]): string =>
  rows
    .map((row) => JSON.stringify(row))
    .toSorted()
    .join("\n");

/** 2回の読み取りが同じ値か。 */
export const sameSnapshot = (a: Snapshot, b: Snapshot): boolean =>
  a.pages.assets === b.pages.assets &&
  rowsKey(a.pages.invocations) === rowsKey(b.pages.invocations) &&
  rowsKey(a.healthz.invocations) === rowsKey(b.healthz.invocations);

export interface WorkerCounts {
  /** Worker ごとの起動の回数。起動が無ければ 0 */
  readonly counts: Readonly<Record<Worker, number>>;
  /** 名前が __unknown__ の起動の回数 */
  readonly unknown: number;
}

export function countsOf(rows: readonly InvocationRow[]): WorkerCounts {
  const counts = Object.fromEntries(
    WORKERS.map((worker) => [worker, totalRequests(rows.filter((row) => row.scriptName === scriptName(worker)))]),
  ) as Record<Worker, number>;
  return { counts, unknown: totalRequests(rows.filter((row) => row.scriptName === UNKNOWN_SCRIPT)) };
}

const unknownReason = (unknown: number): string =>
  `名前が ${UNKNOWN_SCRIPT} の起動が ${unknown} 回あり、Worker に割り当てられない` +
  "（Worker を作ってから約 1.5 時間は名前が入らなかった。06 §7.1。時間を空けて読み直す）";

// ── 判定 ──────────────────────────────────────────────────────────────────────

/** 要確認 4：Static Assets へのリクエストは Worker を起動するか。 */
export interface AssetsFinding extends WorkerCounts {
  readonly outcome: "not-invoked" | "invoked" | "undetermined";
  readonly sent: number;
  readonly assets: number;
  readonly reason: string;
}

export function judgeAssets(pages: Snapshot["pages"], sent: number): AssetsFinding {
  const base = { ...countsOf(pages.invocations), sent, assets: pages.assets };
  const invoked = WORKERS.reduce((total, worker) => total + base.counts[worker], 0);
  if (invoked > 0) {
    return { ...base, outcome: "invoked", reason: `ページの GET で Worker が ${invoked} 回起動した（100k/日 を消費する）` };
  }
  if (base.unknown > 0) return { ...base, outcome: "undetermined", reason: unknownReason(base.unknown) };
  if (!aboutSent(pages.assets, sent)) {
    return {
      ...base,
      outcome: "undetermined",
      reason: `assets の requests（${pages.assets} 回）が送った数（${sent} 回）と合わない（反映待ちか、窓がずれたか、他のリクエストが混ざった）`,
    };
  }
  return { ...base, outcome: "not-invoked", reason: "Worker を起動しない（100k/日 を消費しない）" };
}

/** 要確認 2：Service Binding の呼び出しは、別の requests として数えられるか。 */
export interface ServiceBindingFinding extends WorkerCounts {
  readonly outcome: "separate" | "not-separate" | "undetermined";
  readonly sent: number;
  readonly sampled: boolean;
  readonly reason: string;
}

export function judgeServiceBinding(invocations: readonly InvocationRow[], sent: number): ServiceBindingFinding {
  const { counts, unknown } = countsOf(invocations);
  const base = { counts, unknown, sent, sampled: invocations.some((row) => row.sampleInterval !== 1) };
  if (unknown > 0) return { ...base, outcome: "undetermined", reason: unknownReason(unknown) };
  if (!aboutSent(counts.host, sent)) {
    return {
      ...base,
      outcome: "undetermined",
      reason: `host の起動（${counts.host} 回）が送った数（${sent} 回）と合わない（他のリクエストが混ざったか、反映が足りない）`,
    };
  }
  if (aboutSent(counts.gateway, sent) && aboutSent(counts["data-api"], sent)) {
    return { ...base, outcome: "separate", reason: `別に数える（host への 1 回が ${WORKERS.length} requests になる）` };
  }
  if (counts.gateway === 0 && counts["data-api"] === 0) {
    return { ...base, outcome: "not-separate", reason: "別に数えない（host への 1 回が 1 request のまま）" };
  }
  return { ...base, outcome: "undetermined", reason: "gateway・data-api の起動が送った数と合わず、0 でもない" };
}

export interface WorkerCpu {
  readonly worker: Worker;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  /** サンプリングされた（回数・和は推定値、max・分位は取りこぼし得る） */
  readonly sampled: boolean;
}

/** CPU 時間：Free の上限に対する余裕（要確認 1 を含む）。 */
export type CpuFinding =
  | { readonly outcome: "undetermined"; readonly reason: string }
  | {
      /** within: 合算しても上限内。over-if-summed: 単体では上限内だが合算すると超え得る。over: 単体で超えた */
      readonly outcome: "within" | "over-if-summed" | "over";
      readonly limitMs: number;
      /** 経路の順 */
      readonly workers: readonly WorkerCpu[];
      /** 3つの max の和。同じリクエストで3つとも max だった場合の上界 */
      readonly chainMaxMs: number;
      /** 3つの平均（cpuTimeUs ÷ requests）の和 */
      readonly chainMeanMs: number;
      readonly marginMs: number;
      readonly errors: number;
      /** host の cpuTime が下流の分を含まないと言えるか（host の平均 < gateway と data-api の平均の和） */
      readonly downstreamExcluded: boolean;
      readonly reason: string;
    };

const toMs = (us: number): number => us / 1000;

export function judgeCpu(invocations: readonly InvocationRow[], sent: number, limitMs: number): CpuFinding {
  const { unknown } = countsOf(invocations);
  if (unknown > 0) return { outcome: "undetermined", reason: unknownReason(unknown) };
  const workers: WorkerCpu[] = [];
  let errors = 0;
  for (const worker of WORKERS) {
    const rows = invocations.filter((row) => row.scriptName === scriptName(worker));
    const [row] = rows;
    if (rows.length !== 1 || row === undefined || !aboutSent(row.requests, sent)) {
      return {
        outcome: "undetermined",
        reason: `${worker} の起動（${totalRequests(rows)} 回・${rows.length} 行）が送った数（${sent} 回）と合わない`,
      };
    }
    errors += row.errors;
    workers.push({
      worker,
      p50Ms: toMs(row.cpuP50Us),
      p99Ms: toMs(row.cpuP99Us),
      maxMs: toMs(row.cpuMaxUs),
      // requests と cpuTimeUs は同じ重みの推定値なので、サンプリングされていても割ってよい
      meanMs: toMs(row.cpuTimeUs / row.requests),
      sampled: row.sampleInterval !== 1,
    });
  }
  const [host, gateway, dataApi] = workers;
  if (host === undefined || gateway === undefined || dataApi === undefined) {
    return { outcome: "undetermined", reason: "Worker が3つ揃わない" };
  }
  const chainMaxMs = workers.reduce((total, w) => total + w.maxMs, 0);
  const base = {
    limitMs,
    workers,
    chainMaxMs,
    chainMeanMs: workers.reduce((total, w) => total + w.meanMs, 0),
    marginMs: limitMs - chainMaxMs,
    errors,
    downstreamExcluded: host.meanMs < gateway.meanMs + dataApi.meanMs,
  };
  const over = workers.filter((w) => w.maxMs > limitMs);
  if (over.length > 0) {
    return { ...base, outcome: "over", reason: `${over.map((w) => w.worker).join("・")} が単体で上限（${limitMs} ms）を超えた` };
  }
  if (chainMaxMs > limitMs) {
    return {
      ...base,
      outcome: "over-if-summed",
      reason: `単体では上限内だが、チェーンで合算すると上限（${limitMs} ms）を超え得る（06 §4.1 の退路：Workers Paid）`,
    };
  }
  return { ...base, outcome: "within", reason: `合算しても上限（${limitMs} ms）に収まる` };
}

// ── 出力 ──────────────────────────────────────────────────────────────────────

const fmtMs = (value: number): string => `${value.toFixed(2)} ms`;

/** 表の1列。 */
const col = (text: string): string => text.padStart(10);

const SAMPLED_NOTE = "サンプリングあり（回数・和は推定値、max・分位は取りこぼし得る）";

export function formatAssets(finding: AssetsFinding): string[] {
  return [
    `── 要確認 4：Static Assets へのリクエストは Worker を起動するか（/ と深いリンク 計 ${finding.sent} 回）`,
    ...WORKERS.map((worker) => `  ${worker.padEnd(9)} ${finding.counts[worker]} 回の起動（workersInvocationsAdaptive）`),
    ...(finding.unknown > 0 ? [`  ${UNKNOWN_SCRIPT} ${finding.unknown} 回の起動`] : []),
    `  assets    ${finding.assets} 回（workersAssetsRequestsAdaptiveGroups）`,
    `  判定: ${finding.reason}`,
  ];
}

export function formatServiceBinding(finding: ServiceBindingFinding): string[] {
  return [
    `── 要確認 2：Service Binding の呼び出しは別の requests として数えられるか（/healthz ${finding.sent} 回）`,
    ...WORKERS.map((worker) => `  ${worker.padEnd(9)} ${finding.counts[worker]} 回（workersInvocationsAdaptive の sum.requests）`),
    ...(finding.unknown > 0 ? [`  ${UNKNOWN_SCRIPT} ${finding.unknown} 回`] : []),
    ...(finding.sampled ? [`  注: ${SAMPLED_NOTE}`] : []),
    `  判定: ${finding.reason}`,
  ];
}

export function formatCpu(finding: CpuFinding, sent: number, limitMs: number): string[] {
  const head = `── CPU 時間（/healthz ${sent} 回。上限 ${limitMs} ms）`;
  if (finding.outcome === "undetermined") return [head, `  判定: 判定できない — ${finding.reason}`];
  return [
    head,
    `  ${"".padEnd(9)} ${col("p50")} ${col("p99")} ${col("max")} ${col("平均")}`,
    ...finding.workers.map(
      (w) =>
        `  ${w.worker.padEnd(9)} ${col(fmtMs(w.p50Ms))} ${col(fmtMs(w.p99Ms))} ${col(fmtMs(w.maxMs))} ${col(fmtMs(w.meanMs))}` +
        (w.sampled ? `  ${SAMPLED_NOTE}` : ""),
    ),
    `  チェーン合計の上界（max の和）  ${fmtMs(finding.chainMaxMs)}（余裕 ${fmtMs(finding.marginMs)}）`,
    `  チェーン合計の平均             ${fmtMs(finding.chainMeanMs)}`,
    ...(finding.errors > 0 ? [`  errors ${finding.errors} 回`] : []),
    finding.downstreamExcluded
      ? "  要確認 1: host の cpuTime は gateway・data-api の分を含まない（host の平均 < 下流の平均の和）。Worker ごとに別に記録されている"
      : "  要確認 1: host の平均が下流の平均の和以上なので、host の cpuTime が下流を含むかは言えない",
    `  判定: ${finding.reason}`,
  ];
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export interface CliIo {
  /** 環境変数。CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID（・CLOUDFLARE_ACCOUNT_ID_PROD）を読む */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Cloudflare の API（サブドメイン・GraphQL）を呼ぶ */
  fetch: typeof fetch;
  /** host への GET */
  get: HttpGet;
  /** 壁時計（エポックからのミリ秒） */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  policy: MeasurePolicy;
}

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const USAGE = `usage: pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts [--pages <m>] [--healthz <n>] [--cpu-limit-ms <ms>]
       pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts --pages-window <since>/<until> --healthz-window <since>/<until> [--pages <m>] [--healthz <n>]

  --pages <m>             / と深いリンクを、それぞれ m 回送る（既定 ${DEFAULT_PLAN.pages}）
  --healthz <n>           /healthz を n 回送る（既定 ${DEFAULT_PLAN.healthz}）。2m + n は ${MAX_REQUESTS} 以下
  --cpu-limit-ms <ms>     CPU 時間の上限（既定 ${FREE_CPU_LIMIT_MS}。一次情報が変わったら与える）
  --pages-window, --healthz-window
                          GET を送らず、前に送った窓を Analytics から読み直す（1つ目の形が出力する値をそのまま渡す）

宛先は ${TARGET_ENV} の host（Worker 名 ${scriptName("host")}）。URL は Cloudflare の API から組み立て、表示しない。
資格情報は環境変数 CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID（アカウント①の CI 用トークン）。
出すのは回数・ミリ秒・判定・窓の時刻だけ。
exit ${EXIT_OK}: 判定できて前提が成り立った／${EXIT_NG}: 失敗か前提が崩れた／${EXIT_UNDETERMINED}: 判定できない（窓を指定して読み直す）`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof MeasureError) {
      io.err(`measure: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない（URL・ID を含み得る）。種別だけ出す。
      io.err(`measure: 予期しない失敗（${e instanceof Error ? e.name : typeof e}）`);
    }
    return EXIT_NG;
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        pages: { type: "string" },
        healthz: { type: "string" },
        "cpu-limit-ms": { type: "string" },
        "pages-window": { type: "string" },
        "healthz-window": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    // parseArgs の文言は引数をそのまま含む。値を出さない。
    throw new MeasureError(`引数が不正（値は表示しない）\n${USAGE}`);
  }
}

function positiveInteger(raw: string | undefined, option: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d{0,3}$/.test(raw)) throw new MeasureError(`${option} は 1 以上の整数`);
  return Number(raw);
}

async function callApi(io: CliIo, credentials: Credentials, path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await io.fetch(`${CLOUDFLARE_API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(io.policy.requestTimeoutMs),
    });
  } catch (e) {
    throw new MeasureError(`Cloudflare の API に届かない（${describeGetError(e)}）`);
  }
  if (res.status === 401 || res.status === 403) {
    throw permissionError(path === "/graphql" ? "Analytics（GraphQL）を読む" : "Workers のサブドメインを読む");
  }
  if (res.status === 429) throw new MeasureError("Cloudflare の API のレート制限に掛かった。5 分以上空けて読み直す");
  try {
    return await res.json();
  } catch {
    throw new MeasureError(`Cloudflare の API の応答が JSON でない（HTTP ${res.status}）`);
  }
}

async function readSubdomain(io: CliIo, credentials: Credentials): Promise<string> {
  const body = await callApi(io, credentials, `/accounts/${credentials.accountId}/workers/subdomain`);
  const result = isRecord(body) ? body.result : undefined;
  const subdomain = isRecord(result) ? result.subdomain : undefined;
  if (!isRecord(body) || body.success !== true || !isSubdomain(subdomain)) {
    throw new MeasureError("Workers のサブドメインが読めない（workers.dev のサブドメインが無いか、応答の形が違う）");
  }
  return subdomain;
}

/** 1つの段（ページ／healthz）を順に送る。1回でも ok でなければその場で止める。 */
async function sendPhase(
  io: CliIo,
  origin: URL,
  paths: readonly string[],
  headers: Readonly<Record<string, string>>,
  check: (res: HttpResponse) => string | undefined,
  label: string,
): Promise<PhaseRecord> {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const [i, path] of paths.entries()) {
    const startedAt = io.now();
    let res: HttpResponse;
    try {
      res = await io.get(new URL(path, origin), headers, io.policy.requestTimeoutMs);
    } catch (e) {
      throw new MeasureError(`${label} の ${i + 1} 回目（${path}）が届かない（${describeGetError(e)}）。ここで止める`);
    }
    const problem = check(res);
    if (problem !== undefined) throw new MeasureError(`${label} の ${i + 1} 回目（${path}）: ${problem}。ここで止める`);
    // Cloudflare の時計を使う。Date ヘッダが無ければ手元の時計（送る前と受けた後）
    const served = res.date === null ? Number.NaN : Date.parse(res.date);
    first = Math.min(first, Number.isNaN(served) ? startedAt : served);
    last = Math.max(last, Number.isNaN(served) ? io.now() : served);
  }
  return { window: windowOf(first, last), sent: paths.length };
}

async function drive(io: CliIo, origin: URL, plan: Plan): Promise<DriveRecord> {
  const pagePaths = Array.from({ length: plan.pages }, () => [ROOT_PATH, DEEP_LINK_PATH]).flat();
  const pages = await sendPhase(io, origin, pagePaths, NAVIGATION_HEADERS, checkPage, "ページ");
  io.out(`measure: ページ ${pages.sent}/${pages.sent} 回が SPAシェル（200 text/html）`);
  await io.sleep(io.policy.phaseGapMs);
  const healthzPaths = Array.from({ length: plan.healthz }, () => HEALTHZ_PATH);
  const healthz = await sendPhase(io, origin, healthzPaths, HEALTHZ_HEADERS, checkHealthz, HEALTHZ_PATH);
  io.out(`measure: ${HEALTHZ_PATH} ${healthz.sent}/${healthz.sent} 回が全層 ok`);
  return { pages, healthz };
}

interface Reading {
  readonly snapshot: Snapshot;
  readonly settled: boolean;
}

/** 反映を待って読む。2回続けて同じ値で、送った分が出揃っていれば反映済み。上限を超えて待たない。 */
async function readUntilSettled(read: () => Promise<Snapshot>, record: DriveRecord, io: CliIo): Promise<Reading> {
  const { policy } = io;
  const startedAt = io.now();
  let previous: Snapshot | undefined;
  for (let attempt = 1; ; attempt++) {
    const snapshot = await read();
    if (previous !== undefined && reflected(snapshot, record) && sameSnapshot(previous, snapshot)) {
      io.out(`measure: 反映を確かめた（2 回続けて同じ値。読んだ回数 ${attempt}）`);
      return { snapshot, settled: true };
    }
    previous = snapshot;
    if (io.now() - startedAt + policy.pollIntervalMs > policy.maxWaitMs) {
      io.out(`measure: 反映を待ちきれなかった（${policy.maxWaitMs / 60_000} 分・読んだ回数 ${attempt}）。最後に読んだ値で判定する`);
      return { snapshot, settled: false };
    }
    io.out(
      `measure: 反映待ち（${attempt} 回目: ${HEALTHZ_PATH} の窓の起動 ${totalRequests(snapshot.healthz.invocations)} 回・` +
        `ページの窓の assets ${snapshot.pages.assets} 回）… ${policy.pollIntervalMs / 1000} 秒後に読み直す`,
    );
    await io.sleep(policy.pollIntervalMs);
  }
}

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const values = parseCliArgs(argv);
  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }
  const plan: Plan = {
    pages: positiveInteger(values.pages, "--pages", DEFAULT_PLAN.pages),
    healthz: positiveInteger(values.healthz, "--healthz", DEFAULT_PLAN.healthz),
  };
  const limitRaw = values["cpu-limit-ms"];
  const limitMs = limitRaw === undefined ? FREE_CPU_LIMIT_MS : Number(limitRaw);
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new MeasureError("--cpu-limit-ms は正の数");
  const pagesWindow = values["pages-window"];
  const healthzWindow = values["healthz-window"];
  if ((pagesWindow === undefined) !== (healthzWindow === undefined)) {
    throw new MeasureError("--pages-window と --healthz-window は両方渡す（読み直すとき）か、両方渡さない（送るとき）");
  }
  const replay: DriveRecord | undefined =
    pagesWindow === undefined || healthzWindow === undefined
      ? undefined
      : {
          pages: { window: parseWindow(pagesWindow, "--pages-window"), sent: plan.pages * 2 },
          healthz: { window: parseWindow(healthzWindow, "--healthz-window"), sent: plan.healthz },
        };
  if (replay === undefined && requestCount(plan) > MAX_REQUESTS) {
    throw new MeasureError(`送る回数が ${requestCount(plan)} 回（2 × --pages + --healthz）。1回の実測は ${MAX_REQUESTS} 回まで。1回も送らずに止める`);
  }
  if (replay !== undefined) assertSeparated(replay);

  const credentials = readCredentials(io.env);
  const subdomain = await readSubdomain(io, credentials);
  const hostname = hostHostname(subdomain);
  const secrets = [credentials.token, credentials.accountId, subdomain, hostname];

  let record: DriveRecord;
  if (replay === undefined) {
    io.out(
      `measure: ${TARGET_ENV} の host に GET を送る（${ROOT_PATH} と深いリンクを各 ${plan.pages} 回・${HEALTHZ_PATH} を ${plan.healthz} 回。` +
        `合計 ${requestCount(plan)} 回 ≤ ${MAX_REQUESTS}）`,
    );
    record = await drive(io, new URL(`https://${hostname}`), plan);
    assertSeparated(record);
    io.out(`measure: 読み直すとき: ${formatWindows(record, plan)}`);
    io.out(
      `measure: ${io.policy.firstReadDelayMs / 1000} 秒待ってから Analytics を読む` +
        `（${io.policy.pollIntervalMs / 1000} 秒ごと・最大 ${io.policy.maxWaitMs / 60_000} 分）`,
    );
    await io.sleep(io.policy.firstReadDelayMs);
  } else {
    record = replay;
    io.out(`measure: GET を送らず、窓を Analytics から読み直す（${formatWindows(record, plan)}）`);
  }

  const read = async (): Promise<Snapshot> =>
    parseAnalytics(
      await callApi(io, credentials, "/graphql", {
        method: "POST",
        body: JSON.stringify({ query: ANALYTICS_QUERY, variables: analyticsVariables(credentials.accountId, hostname, record) }),
      }),
      secrets,
    );
  const { snapshot, settled } = await readUntilSettled(read, record, io);

  const assets = judgeAssets(snapshot.pages, record.pages.sent);
  const serviceBinding = judgeServiceBinding(snapshot.healthz.invocations, record.healthz.sent);
  const cpu = judgeCpu(snapshot.healthz.invocations, record.healthz.sent, limitMs);
  io.out("");
  for (const line of formatAssets(assets)) io.out(line);
  io.out("");
  for (const line of formatServiceBinding(serviceBinding)) io.out(line);
  io.out("");
  for (const line of formatCpu(cpu, record.healthz.sent, limitMs)) io.out(line);
  io.out("");

  if (assets.outcome === "invoked" || cpu.outcome === "over" || cpu.outcome === "over-if-summed") {
    io.out("measure: NG 設計の前提が崩れた（06 §5 の昇格トリガーを確かめる）");
    return EXIT_NG;
  }
  if (!settled || assets.outcome === "undetermined" || serviceBinding.outcome === "undetermined" || cpu.outcome === "undetermined") {
    io.out(`measure: 判定できない項目がある。時間を空けて読み直す: ${formatWindows(record, plan)}`);
    return EXIT_UNDETERMINED;
  }
  io.out("measure: OK 判定できた（結果は 06 §7 の表に日付・回数と一緒に書く）");
  return EXIT_OK;
}

const defaultIo: CliIo = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (input, init) => fetch(input, init),
  get: nodeGet,
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  policy: MEASURE_POLICY,
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
