// free-tier-report — Free の枠の使用量を、アカウント①・②の Workers Analytics から読み取りだけで集計する（Issue #26。06 §5・§5.1・§8）。
//
//   pnpm exec tsx --env-file=.env infra/scripts/free-tier-report.ts [--account 1] [--account 2] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>]
//
// 既定は両方のアカウントの、今日（UTC）までの 7 日。週次チェック（06 §5.1 の 2〜5）と、M0 の清算（06 §8）に同じものを使う。
// 資格情報は環境変数（手元の .env の CI 用トークン）：
//   アカウント①（dev + staging） … CLOUDFLARE_API_TOKEN      ・CLOUDFLARE_ACCOUNT_ID
//   アカウント②（production）    … CLOUDFLARE_API_TOKEN_PROD ・CLOUDFLARE_ACCOUNT_ID_PROD
//
// ── 何を読み、何を判定するか ──────────────────────────────────────────────────
//
// 1つのアカウントにつき GraphQL を1回だけ読む（データセットと欄は GraphQL のスキーマで確かめた。06 §8 の出典）。
//   workersInvocationsAdaptive      … 日（date）× Worker（scriptName）× status ごとの sum.requests・errors・subrequests・cpuTimeUs、
//                                     max.cpuTime（マイクロ秒）、avg.sampleInterval
//   durableObjectsSqlStorageGroups  … 日 × namespace ごとの max.storedBytes（SQLite 型 DO。Free で使えるのはこちら）
//   durableObjectsStorageGroups     … 同じく KV 型 DO。Free では作れないが、在れば足す（保守側）
//   d1AnalyticsAdaptiveGroups       … 日ごとの sum.rowsRead・rowsWritten
//
// 判定するのは 06 §5 の昇格トリガーのうち、数字で決まる4つ：
//   P-1 … CPU 超過。status が exceeded で始まる起動（exceededResources）の回数が MUSUNEST の Worker で 1 回でもあれば触れた。
//         exceededResources は CPU 時間のほか起動時間・Free の上限でも付く（一次情報）ので、CPU 超過の上界として数える
//   P-2 … 日次リクエスト（アカウントの全 Worker の合計）が 50,000 を超えた日が 3 日続けば触れた
//   P-3 … DO の保存容量（アカウントの合計）が 2.5 GB を超えれば触れた
//   P-4 … D1 の日次の読み取り行・書き込み行（アカウントの合計）が上限の 50% を超えれば触れた
// P-5（M4 の着手）と P-6（ログの保持期間で調査が詰まった）は人が決める。出力にはそう書くだけ。
//
// 日次リクエスト・DO の容量・D1 の行はアカウント単位の上限なので、MUSUNEST 以外の Worker も合計に含める（アカウント①には以前からの Worker がある）。
// CPU 時間は1回の起動ごとの上限なので、MUSUNEST の Worker だけを見る。MUSUNEST 以外の Worker の名前は出さない（本数だけ）。
// Service Binding の先の起動も requests に数える（06 §4.2：Free の 100k/日 がどちらで数えるか一次情報に無いので、保守側に数える）。
//
// CPU 時間は、環境ごとに host・gateway・data-api の期間中の max を足した値（チェーン合計の上界）を上限と比べて余裕を出す。
// 上限の判定が Worker ごとかチェーンの合算かは一次情報に無い（06 §7 #1）ので、合算の上界で見る。
// 余裕が 3 ms 未満か、Worker 単体の max が上限を超えていれば、最後に注意を出す（05 §3.5 の「F-1 が合算だった場合の処置」の線）。
// 上限を超えてもエラーにならないことがある（上限未満の余りを繰り越す仕組み。一次情報）ので、P-1 はエラーの件数で見る。
// 注意は昇格トリガーではないので終了コードに入れない。昇格するかは人が決める（2026-09-14 の production がこれに当たった。06 §7.2）。
//
// ── サンプリング ────────────────────────────────────────────────────────────────
//
// Adaptive のデータセットは少ない数でも揺れる（06 §7.1：20 回が 27 回・17 回と出た）。回数は推定値で、max は取りこぼし得る。
// 閾値（5 万回・2.5 GB など）から桁で離れている間は判定に影響しない。近づいたら、ダッシュボードと一次情報を引き直す。
//
// ── 安全面（CLAUDE.md「このリポジトリは public である」）────────────────────────────
//
// **実環境への操作は GraphQL の読み取りだけ。Worker へのリクエストは送らない。** 書き込みの API を呼ばない。
// 出すのは日付・回数・ミリ秒・バイト数・判定だけ。Account ID・トークン・DO の namespace の ID・D1 の database の ID・
// MUSUNEST 以外の Worker の名前を出さない。API のエラーの文言は伏せ、長さを切ってから出す（measure-free-tier.ts の sanitize）。
// 権限が足りない（401・403・GraphQL の認可エラー）ときは、トークンを作らずに止める。
// 課金額は API で読めない。所有者がダッシュボードで確かめる（06 §8）。
//
// ── 終了コード ──────────────────────────────────────────────────────────────
//
//   0 … 読めて、P-1〜P-4 のどれにも触れていない
//   1 … 引数・資格情報・API の失敗
//   2 … P-1〜P-4 のどれかに触れた。**議論せず即上げる**（06 §5。H-13 で承認済み）
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FREE_CPU_LIMIT_MS, sanitize, UNKNOWN_SCRIPT, WORKERS, type Worker } from "./measure-free-tier.ts";
import { ENVS, type Env } from "./sync-bindings.ts";

// ── アカウント ──────────────────────────────────────────────────────────────────

export const ACCOUNTS = ["1", "2"] as const;
export type AccountKey = (typeof ACCOUNTS)[number];

export interface AccountSpec {
  readonly label: string;
  readonly tokenVar: string;
  readonly accountIdVar: string;
  /** このアカウントに置いてある MUSUNEST の環境（06 §4.3 案A） */
  readonly envs: readonly Env[];
}

export const ACCOUNT_SPECS: Readonly<Record<AccountKey, AccountSpec>> = {
  "1": {
    label: "アカウント①（dev + staging）",
    tokenVar: "CLOUDFLARE_API_TOKEN",
    accountIdVar: "CLOUDFLARE_ACCOUNT_ID",
    envs: ["dev", "staging"],
  },
  "2": {
    label: "アカウント②（production）",
    tokenVar: "CLOUDFLARE_API_TOKEN_PROD",
    accountIdVar: "CLOUDFLARE_ACCOUNT_ID_PROD",
    envs: ["production"],
  },
};

/** Worker 名。正本は各 wrangler.jsonc の env.<env>.name（食い違えば free-tier-report.test.ts が落とす）。 */
export const musunestScript = (env: Env, worker: Worker): string => `musunest-${env}-${worker}`;

const MUSUNEST_SCRIPTS: ReadonlySet<string> = new Set(ENVS.flatMap((env) => WORKERS.map((worker) => musunestScript(env, worker))));

export const isMusunest = (name: string): boolean => MUSUNEST_SCRIPTS.has(name);

// ── 上限と昇格トリガー ──────────────────────────────────────────────────────────

/** GB は 10^9 バイトで数える（2^30 より小さいので、閾値が厳しい側に倒れる）。 */
const GB = 1_000_000_000;

/**
 * Free の上限。一次情報（2026-09-14 に確認）。変わったらここを直す。
 *   dailyRequests … https://developers.cloudflare.com/workers/platform/limits/#daily-requests
 *   cpuMs         … https://developers.cloudflare.com/workers/platform/limits/#cpu-time
 *   doStoredBytes … https://developers.cloudflare.com/durable-objects/platform/pricing/#sqlite-storage-backend（アカウント合計）
 *   d1Rows*       … https://developers.cloudflare.com/d1/platform/pricing/#billing-metrics（アカウント合計・00:00 UTC にリセット）
 */
export const FREE_LIMITS = {
  dailyRequests: 100_000,
  cpuMs: FREE_CPU_LIMIT_MS,
  doStoredBytes: 5 * GB,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
} as const;

/** 昇格トリガー（06 §5。2026-09-12 に H-13 で承認）。上限の 50%。 */
export const TRIGGERS = {
  p2DailyRequests: FREE_LIMITS.dailyRequests / 2,
  p2ConsecutiveDays: 3,
  p3DoStoredBytes: FREE_LIMITS.doStoredBytes / 2,
  p4RowsReadPerDay: FREE_LIMITS.d1RowsReadPerDay / 2,
  p4RowsWrittenPerDay: FREE_LIMITS.d1RowsWrittenPerDay / 2,
} as const;

/** チェーン合計の上界に対する余裕がこれ未満なら注意を出す（05 §3.5「F-1 が合算だった場合の処置」）。 */
export const CHAIN_MARGIN_FLOOR_MS = 3;

export const EXIT_OK = 0;
export const EXIT_NG = 1;
export const EXIT_TOUCHED = 2;

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class ReportError extends Error {
  override name = "ReportError";
}

// ── 期間 ──────────────────────────────────────────────────────────────────────

/** UTC の日付（YYYY-MM-DD）。両端を含む。 */
export interface Period {
  readonly since: string;
  readonly until: string;
}

export const DEFAULT_DAYS = 7;
/** 1回に読む日数の上限。GraphQL の settings.maxDuration は 2,764,800 秒（32 日。2026-09-14 にアカウント①で読んだ）。 */
export const MAX_DAYS = 31;
/** どこまで遡れるか。settings.notOlderThan は 7,776,000 秒（90 日）。 */
export const MAX_AGE_DAYS = 89;

const DAY_MS = 86_400_000;
const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayOf = (date: string): number => Date.parse(`${date}T00:00:00Z`);

function readDate(raw: string, option: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(dayOf(raw)) || toDate(dayOf(raw)) !== raw) {
    throw new ReportError(`${option} は YYYY-MM-DD（UTC の日付。例 2026-09-14）で書く`);
  }
  return raw;
}

/** 引数から期間を作る。既定は今日（UTC）までの DEFAULT_DAYS 日。 */
export function parsePeriod(raw: { readonly since?: string | undefined; readonly until?: string | undefined }, nowMs: number): Period {
  const today = toDate(nowMs);
  const until = raw.until === undefined ? today : readDate(raw.until, "--until");
  const since =
    raw.since === undefined ? toDate(dayOf(until) - (DEFAULT_DAYS - 1) * DAY_MS) : readDate(raw.since, "--since");
  if (dayOf(until) > dayOf(today)) throw new ReportError(`--until が今日（UTC の ${today}）より後ろ`);
  if (dayOf(since) > dayOf(until)) throw new ReportError("--since が --until より後ろ");
  if (daysOf({ since, until }) > MAX_DAYS) throw new ReportError(`期間は ${MAX_DAYS} 日まで（Analytics が一度に読める幅）`);
  if ((dayOf(today) - dayOf(since)) / DAY_MS > MAX_AGE_DAYS) {
    throw new ReportError(`--since は今日から ${MAX_AGE_DAYS} 日前まで（Analytics が遡れる幅）`);
  }
  return { since, until };
}

export const daysOf = (period: Period): number => (dayOf(period.until) - dayOf(period.since)) / DAY_MS + 1;

/** 期間の日付を古い順に。 */
export const datesOf = (period: Period): string[] =>
  Array.from({ length: daysOf(period) }, (_, i) => toDate(dayOf(period.since) + i * DAY_MS));

// ── 資格情報 ──────────────────────────────────────────────────────────────────

export interface Credentials {
  readonly token: string;
  readonly accountId: string;
}

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;

/** 選んだアカウントの資格情報を読む。値はエラーにも出さない。 */
export function readCredentials(
  env: Readonly<Record<string, string | undefined>>,
  accounts: readonly AccountKey[],
): ReadonlyMap<AccountKey, Credentials> {
  const result = new Map<AccountKey, Credentials>();
  for (const key of accounts) {
    const spec = ACCOUNT_SPECS[key];
    const token = env[spec.tokenVar];
    const accountId = env[spec.accountIdVar];
    if (token === undefined || token === "" || accountId === undefined || accountId === "") {
      throw new ReportError(
        `${spec.label} を読むには環境変数 ${spec.tokenVar} と ${spec.accountIdVar} が要る（手元の .env。--env-file=.env で渡す）`,
      );
    }
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new ReportError(`${spec.tokenVar} にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）`);
    }
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new ReportError(`${spec.accountIdVar} が Account ID の形（32 桁の 16 進）でない（値は表示しない）`);
    }
    result.set(key, { token, accountId });
  }
  // ①と②が同じアカウントを指していたら、分離（06 §4.3）が崩れているか、書き違いである。同じ数字を2回数えないように止める
  const first = env[ACCOUNT_SPECS["1"].accountIdVar];
  const second = env[ACCOUNT_SPECS["2"].accountIdVar];
  if (first !== undefined && second !== undefined && first !== "" && first.toLowerCase() === second.toLowerCase()) {
    throw new ReportError(
      `${ACCOUNT_SPECS["1"].accountIdVar} と ${ACCOUNT_SPECS["2"].accountIdVar} が同じアカウントを指している（値は表示しない）`,
    );
  }
  return result;
}

// ── Analytics（GraphQL）────────────────────────────────────────────────────────

/** 1つのデータセットから受け取る行の上限（settings.maxPageSize）。ここまで返ってきたら切れているとみなす。 */
export const ROW_LIMIT = 10_000;

export const REPORT_QUERY = `query FreeTierReport($accountTag: string!, $since: Date!, $until: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      invocations: workersInvocationsAdaptive(limit: ${ROW_LIMIT}, filter: { date_geq: $since, date_leq: $until }) {
        sum { requests errors subrequests cpuTimeUs }
        max { cpuTime }
        avg { sampleInterval }
        dimensions { date scriptName status }
      }
      doSqlStorage: durableObjectsSqlStorageGroups(limit: ${ROW_LIMIT}, filter: { date_geq: $since, date_leq: $until }) {
        max { storedBytes }
        dimensions { date namespaceId }
      }
      doKvStorage: durableObjectsStorageGroups(limit: ${ROW_LIMIT}, filter: { date_geq: $since, date_leq: $until }) {
        max { storedBytes }
        dimensions { date namespaceIds }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: ${ROW_LIMIT}, filter: { date_geq: $since, date_leq: $until }) {
        sum { rowsRead rowsWritten }
        dimensions { date }
      }
    }
  }
}`;

export const reportVariables = (accountId: string, period: Period): Record<string, unknown> => ({
  accountTag: accountId,
  since: period.since,
  until: period.until,
});

/** workersInvocationsAdaptive の1行（日 × Worker × status）。時間はマイクロ秒。 */
export interface InvocationRow {
  readonly date: string;
  readonly scriptName: string;
  readonly status: string;
  /** サンプリングされていれば重みを掛けた推定値 */
  readonly requests: number;
  readonly errors: number;
  readonly subrequests: number;
  readonly cpuTimeUs: number;
  readonly cpuMaxUs: number;
  readonly sampleInterval: number;
}

/** DO の保存容量の1行（日 × namespace）。namespace の ID は持たない（出さない）。 */
export interface StorageRow {
  readonly date: string;
  readonly storedBytes: number;
}

export interface D1Row {
  readonly date: string;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface AccountData {
  readonly invocations: readonly InvocationRow[];
  readonly doStorage: readonly StorageRow[];
  readonly d1: readonly D1Row[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readValue(node: Record<string, unknown>, path: string): unknown {
  let value: unknown = node;
  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;
  return value;
}

function readNumber(node: Record<string, unknown>, path: string, dataset: string): number {
  const value = readValue(node, path);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ReportError(`Analytics の応答の形が違う: ${dataset} の ${path} が数でない`);
  }
  return value;
}

function readString(node: Record<string, unknown>, path: string, dataset: string): string {
  const value = readValue(node, path);
  if (typeof value !== "string") throw new ReportError(`Analytics の応答の形が違う: ${dataset} の ${path} が文字列でない`);
  return value;
}

function readRows(value: unknown, dataset: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new ReportError(`Analytics の応答の形が違う: ${dataset} が行の配列でない`);
  }
  if (value.length >= ROW_LIMIT) {
    throw new ReportError(`${dataset} の行が上限（${ROW_LIMIT}）に達した。切れているかもしれないので、期間を短くして読む`);
  }
  return value;
}

/** GraphQL の認可エラーらしい文言か。 */
const AUTHZ_ERROR = /not authori[sz]ed|unauthori[sz]ed|authentication|permission|access denied|forbidden/i;

const permissionError = (label: string): ReportError =>
  new ReportError(
    `${label} の Analytics（GraphQL）を読む権限が足りない。トークンを作らずに止める（CI 用トークンの権限を人が確かめる。Account Analytics: Read）`,
  );

/** GraphQL の応答を読む。errors があれば、伏せた文言で落とす。 */
export function parseReport(body: unknown, label: string, secrets: readonly string[]): AccountData {
  if (!isRecord(body)) throw new ReportError("Analytics の応答が JSON オブジェクトでない");
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : ""));
    if (messages.some((m) => AUTHZ_ERROR.test(m))) throw permissionError(label);
    throw new ReportError(`Analytics がエラーを返した: ${messages.map((m) => sanitize(m, secrets)).join(", ")}`);
  }
  const accounts = readValue(body, "data.viewer.accounts");
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!isRecord(account)) {
    throw new ReportError(`Analytics の応答に ${label} が無い（Account ID とトークンの対象アカウントを確かめる）`);
  }
  const invocations = readRows(account.invocations, "workersInvocationsAdaptive").map((node) => {
    const dataset = "workersInvocationsAdaptive";
    return {
      date: readString(node, "dimensions.date", dataset),
      scriptName: readString(node, "dimensions.scriptName", dataset),
      status: readString(node, "dimensions.status", dataset),
      requests: readNumber(node, "sum.requests", dataset),
      errors: readNumber(node, "sum.errors", dataset),
      subrequests: readNumber(node, "sum.subrequests", dataset),
      cpuTimeUs: readNumber(node, "sum.cpuTimeUs", dataset),
      cpuMaxUs: readNumber(node, "max.cpuTime", dataset),
      sampleInterval: readNumber(node, "avg.sampleInterval", dataset),
    };
  });
  const storage = (value: unknown, dataset: string): StorageRow[] =>
    readRows(value, dataset).map((node) => ({
      date: readString(node, "dimensions.date", dataset),
      storedBytes: readNumber(node, "max.storedBytes", dataset),
    }));
  const d1 = readRows(account.d1, "d1AnalyticsAdaptiveGroups").map((node) => {
    const dataset = "d1AnalyticsAdaptiveGroups";
    return {
      date: readString(node, "dimensions.date", dataset),
      rowsRead: readNumber(node, "sum.rowsRead", dataset),
      rowsWritten: readNumber(node, "sum.rowsWritten", dataset),
    };
  });
  return {
    invocations,
    doStorage: [
      ...storage(account.doSqlStorage, "durableObjectsSqlStorageGroups"),
      ...storage(account.doKvStorage, "durableObjectsStorageGroups"),
    ],
    d1,
  };
}

// ── 集計と判定 ──────────────────────────────────────────────────────────────────

const sumOf = <T>(rows: readonly T[], pick: (row: T) => number): number => rows.reduce((total, row) => total + pick(row), 0);

/** 日付ごとの値のうち最大のもの。同じ値なら古い日。 */
function maxDay<T extends { readonly date: string }>(days: readonly T[], pick: (day: T) => number): T {
  const [first, ...rest] = days;
  if (first === undefined) throw new ReportError("期間に日付が無い");
  return rest.reduce((best, day) => (pick(day) > pick(best) ? day : best), first);
}

export interface DailyRequests {
  readonly date: string;
  readonly total: number;
  readonly musunest: number;
  /** 名前が __unknown__ の起動（作ったばかりの Worker は名前が入るまで時間が掛かる。06 §7.1） */
  readonly unknown: number;
  readonly other: number;
}

/** P-2：日次リクエスト（アカウントの全 Worker の合計）。 */
export interface RequestsSummary {
  /** 期間の全日（起動が無い日は 0） */
  readonly days: readonly DailyRequests[];
  readonly max: DailyRequests;
  /** 閾値（50,000/日）を超えた日数 */
  readonly daysOver: number;
  /** 閾値を超えた日が続いた最長の日数 */
  readonly longestRunOver: number;
  /** 期間の最初の日が閾値を超えていた（期間の前から続いている連続を数え落とし得る） */
  readonly overAtStart: boolean;
  /** 起動があった MUSUNEST 以外の Worker（__unknown__ を除く）の本数 */
  readonly otherScripts: number;
  /** 期間中の、名前が __unknown__ の起動の回数 */
  readonly unknown: number;
  readonly sampled: boolean;
  readonly touched: boolean;
}

export function summarizeRequests(rows: readonly InvocationRow[], period: Period): RequestsSummary {
  const days = datesOf(period).map((date) => {
    const ofDay = rows.filter((row) => row.date === date);
    const total = sumOf(ofDay, (row) => row.requests);
    const musunest = sumOf(
      ofDay.filter((row) => isMusunest(row.scriptName)),
      (row) => row.requests,
    );
    const unknown = sumOf(
      ofDay.filter((row) => row.scriptName === UNKNOWN_SCRIPT),
      (row) => row.requests,
    );
    return { date, total, musunest, unknown, other: total - musunest - unknown };
  });
  let streak = 0;
  let longestRunOver = 0;
  let daysOver = 0;
  for (const day of days) {
    streak = day.total > TRIGGERS.p2DailyRequests ? streak + 1 : 0;
    if (streak > 0) daysOver++;
    longestRunOver = Math.max(longestRunOver, streak);
  }
  return {
    days,
    max: maxDay(days, (day) => day.total),
    daysOver,
    longestRunOver,
    overAtStart: (days[0]?.total ?? 0) > TRIGGERS.p2DailyRequests,
    otherScripts: new Set(
      rows.filter((row) => !isMusunest(row.scriptName) && row.scriptName !== UNKNOWN_SCRIPT).map((row) => row.scriptName),
    ).size,
    unknown: sumOf(days, (day) => day.unknown),
    sampled: rows.some((row) => row.sampleInterval !== 1),
    touched: longestRunOver >= TRIGGERS.p2ConsecutiveDays,
  };
}

/** status が上限超過か（exceededResources。一次情報：Workers の invocation statuses）。 */
export const isExceeded = (status: string): boolean => /^exceeded/i.test(status);

/** P-1：上限超過の起動の回数。 */
export interface ExceededSummary {
  readonly musunest: number;
  /** 名前が __unknown__ の起動。作ったばかりの MUSUNEST の Worker かもしれないので、判定では MUSUNEST に数える */
  readonly unknown: number;
  /** MUSUNEST 以外の Worker（参考。判定に入れない） */
  readonly other: number;
  readonly touched: boolean;
}

export function summarizeExceeded(rows: readonly InvocationRow[]): ExceededSummary {
  const exceeded = rows.filter((row) => isExceeded(row.status));
  const musunest = sumOf(
    exceeded.filter((row) => isMusunest(row.scriptName)),
    (row) => row.requests,
  );
  const unknown = sumOf(
    exceeded.filter((row) => row.scriptName === UNKNOWN_SCRIPT),
    (row) => row.requests,
  );
  const other = sumOf(exceeded, (row) => row.requests) - musunest - unknown;
  return { musunest, unknown, other, touched: musunest + unknown > 0 };
}

export interface WorkerCpu {
  readonly worker: Worker;
  readonly requests: number;
  readonly errors: number;
  readonly cpuMaxMs: number;
  readonly cpuMeanMs: number;
  /** Analytics の sum.subrequests ÷ requests */
  readonly subrequestsPerRequest: number;
  readonly sampled: boolean;
}

/** 1つの環境の CPU 時間。 */
export interface EnvCpu {
  readonly env: Env;
  /** 経路の順（host → gateway → data-api） */
  readonly workers: readonly WorkerCpu[];
  /** 3つの max の和（チェーン合計の上界）。3つとも起動していなければ無い */
  readonly chainMaxMs: number | undefined;
  readonly marginMs: number | undefined;
}

const toMs = (us: number): number => us / 1000;

export function summarizeCpu(rows: readonly InvocationRow[], env: Env): EnvCpu {
  const workers = WORKERS.map((worker): WorkerCpu => {
    const own = rows.filter((row) => row.scriptName === musunestScript(env, worker));
    const requests = sumOf(own, (row) => row.requests);
    return {
      worker,
      requests,
      errors: sumOf(own, (row) => row.errors),
      cpuMaxMs: toMs(own.reduce((max, row) => Math.max(max, row.cpuMaxUs), 0)),
      // requests と cpuTimeUs・subrequests は同じ重みの推定値なので、サンプリングされていても割ってよい
      cpuMeanMs: requests > 0 ? toMs(sumOf(own, (row) => row.cpuTimeUs) / requests) : 0,
      subrequestsPerRequest: requests > 0 ? sumOf(own, (row) => row.subrequests) / requests : 0,
      sampled: own.some((row) => row.sampleInterval !== 1),
    };
  });
  const chainMaxMs = workers.every((w) => w.requests > 0) ? sumOf(workers, (w) => w.cpuMaxMs) : undefined;
  return { env, workers, chainMaxMs, marginMs: chainMaxMs === undefined ? undefined : FREE_LIMITS.cpuMs - chainMaxMs };
}

/** P-3：DO の保存容量（アカウントの合計）。日ごとに namespace の max を足し、その最大を取る。 */
export interface StorageSummary {
  readonly maxBytes: number;
  /** 記録が1行も無ければ無い */
  readonly maxDate: string | undefined;
  readonly touched: boolean;
}

export function summarizeStorage(rows: readonly StorageRow[], period: Period): StorageSummary {
  const days = datesOf(period).map((date) => ({
    date,
    bytes: sumOf(
      rows.filter((row) => row.date === date),
      (row) => row.storedBytes,
    ),
  }));
  const max = maxDay(days, (day) => day.bytes);
  return {
    maxBytes: max.bytes,
    maxDate: rows.length === 0 ? undefined : max.date,
    touched: max.bytes > TRIGGERS.p3DoStoredBytes,
  };
}

/** P-4：D1 の日次の読み取り行・書き込み行（アカウントの合計）。 */
export interface D1Summary {
  readonly maxRead: { readonly date: string; readonly rows: number };
  readonly maxWritten: { readonly date: string; readonly rows: number };
  readonly touched: boolean;
}

export function summarizeD1(rows: readonly D1Row[], period: Period): D1Summary {
  const days = datesOf(period).map((date) => {
    const ofDay = rows.filter((row) => row.date === date);
    return { date, read: sumOf(ofDay, (row) => row.rowsRead), written: sumOf(ofDay, (row) => row.rowsWritten) };
  });
  const read = maxDay(days, (day) => day.read);
  const written = maxDay(days, (day) => day.written);
  return {
    maxRead: { date: read.date, rows: read.read },
    maxWritten: { date: written.date, rows: written.written },
    touched: read.read > TRIGGERS.p4RowsReadPerDay || written.written > TRIGGERS.p4RowsWrittenPerDay,
  };
}

export interface AccountReport {
  readonly key: AccountKey;
  readonly requests: RequestsSummary;
  readonly exceeded: ExceededSummary;
  readonly cpu: readonly EnvCpu[];
  readonly storage: StorageSummary;
  readonly d1: D1Summary;
}

export function summarizeAccount(key: AccountKey, data: AccountData, period: Period): AccountReport {
  return {
    key,
    requests: summarizeRequests(data.invocations, period),
    exceeded: summarizeExceeded(data.invocations),
    cpu: ACCOUNT_SPECS[key].envs.map((env) => summarizeCpu(data.invocations, env)),
    storage: summarizeStorage(data.doStorage, period),
    d1: summarizeD1(data.d1, period),
  };
}

export type TriggerId = "P-1" | "P-2" | "P-3" | "P-4" | "P-5" | "P-6";

export interface TriggerVerdict {
  readonly id: TriggerId;
  /** touched: 触れた／clear: 触れていない／human: 数字では決まらない（人が決める） */
  readonly state: "touched" | "clear" | "human";
  readonly reason: string;
}

export function judgeTriggers(reports: readonly AccountReport[]): TriggerVerdict[] {
  const numeric = (id: TriggerId, touched: (report: AccountReport) => boolean, what: string): TriggerVerdict => {
    const hit = reports.filter(touched).map((report) => ACCOUNT_SPECS[report.key].label);
    return hit.length > 0
      ? { id, state: "touched", reason: `${what}（${hit.join("・")}）` }
      : { id, state: "clear", reason: "触れていない" };
  };
  return [
    numeric("P-1", (r) => r.exceeded.touched, "MUSUNEST の Worker に上限超過（exceededResources）の起動がある"),
    numeric(
      "P-2",
      (r) => r.requests.touched,
      `日次リクエストが ${fmtCount(TRIGGERS.p2DailyRequests)} を超えた日が ${TRIGGERS.p2ConsecutiveDays} 日続いた`,
    ),
    numeric("P-3", (r) => r.storage.touched, `DO の保存容量が ${fmtBytes(TRIGGERS.p3DoStoredBytes)} を超えた`),
    numeric("P-4", (r) => r.d1.touched, "D1 の日次の読み取り行か書き込み行が上限の 50% を超えた"),
    { id: "P-5", state: "human", reason: "数字では決まらない（M4 の着手が決まったか。人が決める）" },
    { id: "P-6", state: "human", reason: "数字では決まらない（Workers Logs の保持期間で障害調査が詰まったか。人が決める）" },
  ];
}

/**
 * CPU 時間の余裕が薄い環境。昇格トリガーではない（P-1 はエラーの件数で見る）が、05 §3.5 の処置の線なので最後にまとめて出す。
 *   - Worker 単体の max が上限を超えた（エラーにならなくても記録には残る。一次情報：上限未満の余りを繰り越す仕組み）
 *   - チェーン合計の上界に対する余裕が CHAIN_MARGIN_FLOOR_MS 未満
 */
export function cpuCautions(reports: readonly AccountReport[]): string[] {
  return reports.flatMap((report) =>
    report.cpu.flatMap((env) => {
      const over = env.workers.filter((w) => w.cpuMaxMs > FREE_LIMITS.cpuMs);
      const thin = env.marginMs !== undefined && env.marginMs < CHAIN_MARGIN_FLOOR_MS;
      if (over.length === 0 && !thin) return [];
      const parts = [
        ...over.map((w) => `${w.worker} が単体で上限を超えた記録（max ${fmtMs(w.cpuMaxMs)}）`),
        ...(thin && env.chainMaxMs !== undefined && env.marginMs !== undefined
          ? [`チェーン合計の上界 ${fmtMs(env.chainMaxMs)}（余裕 ${fmtMs(env.marginMs)}）`]
          : []),
      ];
      return [
        `${env.env} の CPU 時間: ${parts.join("・")}。余裕が ${CHAIN_MARGIN_FLOOR_MS} ms 未満（05 §3.5 の処置の線。昇格するかを人が決める）`,
      ];
    }),
  );
}

// ── 出力 ──────────────────────────────────────────────────────────────────────

const NUMBER = new Intl.NumberFormat("en-US");
export const fmtCount = (value: number): string => NUMBER.format(Math.round(value));
const fmtMs = (value: number): string => `${value.toFixed(2)} ms`;
export const fmtBytes = (bytes: number): string =>
  bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${(bytes / 1_000_000).toFixed(2)} MB`;

const SAMPLED_NOTE = "サンプリングあり（回数は推定値、max は取りこぼし得る）";
const state = (touched: boolean): string => (touched ? "触れた" : "触れていない");

const unknownNote = (count: number): string =>
  `名前が ${UNKNOWN_SCRIPT} の起動が ${fmtCount(count)} 回あり、どの Worker か決められないので CPU 時間に入れていない` +
  "（作ったばかりの Worker は名前が入るまで約 1.5 時間掛かった。06 §7.1。時間を空けて読み直す）";

export function formatAccount(report: AccountReport): string[] {
  const { requests, exceeded, storage, d1 } = report;
  const lines = [
    `══ ${ACCOUNT_SPECS[report.key].label}`,
    `── 日次リクエスト（workersInvocationsAdaptive の sum.requests。全 Worker の合計・Service Binding の先も数える。上限 ${fmtCount(FREE_LIMITS.dailyRequests)}/日）`,
    `  最大 ${fmtCount(requests.max.total)} req/日（${requests.max.date}。MUSUNEST ${fmtCount(requests.max.musunest)}・` +
      `名前なし ${fmtCount(requests.max.unknown)}・その他 ${fmtCount(requests.max.other)}）  その他の Worker ${requests.otherScripts} 本（名前は出さない）`,
    `  ${fmtCount(TRIGGERS.p2DailyRequests)}/日 を超えた日 ${requests.daysOver} 日（続いた最長 ${requests.longestRunOver} 日）`,
    ...(requests.overAtStart ? ["  注: 期間の最初の日から超えている。前の日から続いているかもしれないので、前にずらして読み直す"] : []),
    ...(requests.sampled ? [`  注: ${SAMPLED_NOTE}`] : []),
    `  P-2: ${state(requests.touched)}`,
    `── CPU 時間（MUSUNEST の Worker。上限 ${FREE_LIMITS.cpuMs} ms/起動）`,
    ...(requests.unknown > 0 ? [`  注: ${unknownNote(requests.unknown)}`] : []),
  ];
  for (const env of report.cpu) {
    if (env.workers.every((w) => w.requests === 0)) {
      lines.push(`  ${env.env}: 期間中の起動なし`);
      continue;
    }
    lines.push(`  ${env.env}:`);
    for (const w of env.workers) {
      lines.push(
        w.requests === 0
          ? `    ${w.worker.padEnd(9)} 起動なし`
          : `    ${w.worker.padEnd(9)} ${fmtCount(w.requests).padStart(7)} 回  max ${fmtMs(w.cpuMaxMs)}  平均 ${fmtMs(w.cpuMeanMs)}` +
              `  subrequests/回 ${w.subrequestsPerRequest.toFixed(2)}  errors ${fmtCount(w.errors)}` +
              (w.sampled ? `  ${SAMPLED_NOTE}` : "") +
              (w.cpuMaxMs > FREE_LIMITS.cpuMs ? "  単体で上限を超えた記録がある（エラーにならないこともある）" : ""),
      );
    }
    if (env.chainMaxMs === undefined || env.marginMs === undefined) {
      lines.push("    チェーン合計の上界: 3 つの Worker がそろって起動していないので出さない");
    } else {
      lines.push(`    チェーン合計の上界（期間中の max の和） ${fmtMs(env.chainMaxMs)}（余裕 ${fmtMs(env.marginMs)}）`);
      if (env.marginMs < CHAIN_MARGIN_FLOOR_MS) {
        lines.push(
          `    注意: 合算で判定されるなら余裕が ${CHAIN_MARGIN_FLOOR_MS} ms 未満（05 §3.5「F-1 が合算だった場合の処置」の線。昇格トリガーではない）`,
        );
      }
    }
  }
  lines.push(
    `  上限超過の起動（status が exceeded*）: MUSUNEST ${fmtCount(exceeded.musunest)} 回・名前なし ${fmtCount(exceeded.unknown)} 回` +
      `・その他の Worker ${fmtCount(exceeded.other)} 回（参考）`,
    `  P-1: ${state(exceeded.touched)}`,
    `── DO の保存容量（durableObjectsSqlStorageGroups ＋ durableObjectsStorageGroups の max.storedBytes。アカウント合計。上限 ${fmtBytes(FREE_LIMITS.doStoredBytes)}）`,
    storage.maxDate === undefined
      ? "  記録なし（0 bytes）"
      : `  最大 ${fmtBytes(storage.maxBytes)}（${fmtCount(storage.maxBytes)} bytes・${storage.maxDate}）`,
    `  P-3: ${state(storage.touched)}`,
    `── D1（d1AnalyticsAdaptiveGroups。アカウント合計。上限 読み取り ${fmtCount(FREE_LIMITS.d1RowsReadPerDay)} 行/日・書き込み ${fmtCount(FREE_LIMITS.d1RowsWrittenPerDay)} 行/日）`,
    `  読み取り 最大 ${fmtCount(d1.maxRead.rows)} 行/日（${d1.maxRead.date}）`,
    `  書き込み 最大 ${fmtCount(d1.maxWritten.rows)} 行/日（${d1.maxWritten.date}）`,
    `  P-4: ${state(d1.touched)}`,
  );
  return lines;
}

const VERDICT_LABEL: Readonly<Record<TriggerVerdict["state"], string>> = {
  touched: "触れた",
  clear: "触れていない",
  human: "人が決める",
};

export function formatTriggers(verdicts: readonly TriggerVerdict[], accounts: readonly AccountKey[]): string[] {
  return [
    `══ 昇格トリガー（06 §5。${accounts.map((key) => ACCOUNT_SPECS[key].label).join("・")}）`,
    ...verdicts.map((v) =>
      v.state === "clear" ? `  ${v.id}: ${VERDICT_LABEL[v.state]}` : `  ${v.id}: ${VERDICT_LABEL[v.state]} — ${v.reason}`,
    ),
  ];
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export interface CliIo {
  /** 環境変数。ACCOUNT_SPECS の tokenVar・accountIdVar を読む */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Cloudflare の API（GraphQL だけ）を呼ぶ */
  fetch: typeof fetch;
  /** 壁時計（エポックからのミリ秒）。既定の期間を決めるだけに使う */
  now: () => number;
  requestTimeoutMs: number;
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const USAGE = `usage: pnpm exec tsx --env-file=.env infra/scripts/free-tier-report.ts [--account 1] [--account 2] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>]

  --account <1|2>         読むアカウント。1 = ${ACCOUNT_SPECS["1"].label}、2 = ${ACCOUNT_SPECS["2"].label}。繰り返せる（既定は両方）
  --since <YYYY-MM-DD>    期間の始まり（UTC の日付・含む。既定は --until の ${DEFAULT_DAYS - 1} 日前）
  --until <YYYY-MM-DD>    期間の終わり（UTC の日付・含む。既定は今日）。期間は ${MAX_DAYS} 日まで

読むのは Workers Analytics（GraphQL）だけ。Worker へのリクエストは送らない。
資格情報は環境変数 ${ACCOUNT_SPECS["1"].tokenVar}・${ACCOUNT_SPECS["1"].accountIdVar}（①）、${ACCOUNT_SPECS["2"].tokenVar}・${ACCOUNT_SPECS["2"].accountIdVar}（②）。
出すのは日付・回数・ミリ秒・バイト数・判定だけ。
exit ${EXIT_OK}: P-1〜P-4 に触れていない／${EXIT_NG}: 失敗／${EXIT_TOUCHED}: P-1〜P-4 のどれかに触れた（06 §5：議論せず即上げる）`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof ReportError) {
      io.err(`free-tier-report: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない（ID を含み得る）。種別だけ出す。
      io.err(`free-tier-report: 予期しない失敗（${e instanceof Error ? e.name : typeof e}）`);
    }
    return EXIT_NG;
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        account: { type: "string", multiple: true },
        since: { type: "string" },
        until: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    // parseArgs の文言は引数をそのまま含む。値を出さない。
    throw new ReportError(`引数が不正（値は表示しない）\n${USAGE}`);
  }
}

const isAccountKey = (value: string): value is AccountKey => (ACCOUNTS as readonly string[]).includes(value);

function readAccounts(raw: readonly string[] | undefined): AccountKey[] {
  if (raw === undefined) return [...ACCOUNTS];
  const keys: AccountKey[] = [];
  for (const value of raw) {
    if (!isAccountKey(value)) throw new ReportError("--account は 1 か 2");
    if (!keys.includes(value)) keys.push(value);
  }
  return keys.toSorted();
}

function describeFetchError(e: unknown): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return "タイムアウト";
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  return e instanceof Error && /^\w+$/.test(e.name) ? e.name : typeof e;
}

async function readAccount(io: CliIo, key: AccountKey, credentials: Credentials, period: Period): Promise<AccountData> {
  const { label } = ACCOUNT_SPECS[key];
  let res: Response;
  try {
    res = await io.fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: REPORT_QUERY, variables: reportVariables(credentials.accountId, period) }),
      signal: AbortSignal.timeout(io.requestTimeoutMs),
    });
  } catch (e) {
    throw new ReportError(`Cloudflare の API に届かない（${describeFetchError(e)}）`);
  }
  if (res.status === 401 || res.status === 403) throw permissionError(label);
  if (res.status === 429) throw new ReportError("Cloudflare の API のレート制限に掛かった。5 分以上空けて読み直す");
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ReportError(`Cloudflare の API の応答が JSON でない（HTTP ${res.status}）`);
  }
  return parseReport(body, label, [credentials.token, credentials.accountId]);
}

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const values = parseCliArgs(argv);
  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }
  const accounts = readAccounts(values.account);
  const period = parsePeriod({ since: values.since, until: values.until }, io.now());
  const credentials = readCredentials(io.env, accounts);

  io.out(`free-tier-report: 期間 ${period.since}〜${period.until}（UTC の日付・両端を含む。${daysOf(period)} 日）`);
  io.out("free-tier-report: 読むのは Workers Analytics（GraphQL）だけ。Worker へのリクエストは送らない");
  if (daysOf(period) < DEFAULT_DAYS) io.out(`free-tier-report: 注: 期間が ${DEFAULT_DAYS} 日より短い（P-1 は 7 日間で見る）`);

  const reports: AccountReport[] = [];
  for (const key of accounts) {
    const own = credentials.get(key);
    if (own === undefined) throw new ReportError(`${ACCOUNT_SPECS[key].label} の資格情報が無い`);
    const report = summarizeAccount(key, await readAccount(io, key, own, period), period);
    reports.push(report);
    io.out("");
    for (const line of formatAccount(report)) io.out(line);
  }

  const verdicts = judgeTriggers(reports);
  io.out("");
  for (const line of formatTriggers(verdicts, accounts)) io.out(line);
  io.out("  課金額: API では読めない。所有者がダッシュボードの Billing で確かめる（06 §8）");
  io.out("");
  for (const caution of cpuCautions(reports)) io.out(`free-tier-report: 注意 ${caution}`);
  const touched = verdicts.filter((v) => v.state === "touched").map((v) => v.id);
  if (touched.length > 0) {
    io.out(`free-tier-report: NG ${touched.join("・")} に触れた。議論せず即上げる（06 §5。H-13 で承認済み）`);
    return EXIT_TOUCHED;
  }
  io.out("free-tier-report: OK P-1〜P-4 に触れていない（P-5・P-6 は人が決める）");
  return EXIT_OK;
}

const defaultIo: CliIo = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  requestTimeoutMs: 30_000,
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
