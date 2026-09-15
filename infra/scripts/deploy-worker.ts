// deploy-worker — CD（deploy-staging / deploy-production）が wrangler で D1 マイグレーションと Worker の配備を行う入口（04 §4）。
// rollback.yml がコードを巻き戻す入口でもある（04 §6.1・docs/runbook/rollback.md）。
// dev へ配るのも同じ入口で、並びは infra/scripts/reproduce-dev.sh が持つ（試験A。05 §1）。
//
//   pnpm exec tsx infra/scripts/deploy-worker.ts --env <dev|staging|production> --target <migrate|data-api|gateway|host> [--sha <sha>] [--log-dir <dir>]
//   pnpm exec tsx infra/scripts/deploy-worker.ts --env <dev|staging|production> --rollback-to <sha> [--log-dir <dir>]
//   pnpm exec tsx infra/scripts/deploy-worker.ts --env dev --smoke [--sha <sha>]
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
//   - メールアドレスの形。版とデプロイの記録は author_email を持つ（巻き戻しで読む）
//   - ANSI エスケープは伏せる前に取り除く。色の切り替えがホスト名の途中に入ると一致しなくなり、OSC 8 のリンクは URL を運ぶ
// 行頭（空白の後を含む）の `::` は崩す。GitHub Actions のワークフローコマンドとして解釈させない。
//
// ── Worker の secret（production の host と gateway の MUSUNEST_PROBE_TOKEN）──────────────────────
//
// production の host と gateway は、X-Musunest-Probe が secret MUSUNEST_PROBE_TOKEN と一致したときだけ /healthz の詳細を返す
// （03 §5「セキュリティ上の注意」）。secret の無い production の host は常に {"ok": false}（503）になり、貫通スモークが通らない。
// だから **詳細を隠す env（smoke.ts の PROBE_REQUIRED_ENVS）の gateway と host を配るときは、毎回 secret を一緒に載せる**
// （2026-09-14・Issue #16 の決定。手で wrangler secret put をしない）。
//   - 値は同じ名前の環境変数から読む。CI では **production 環境の Secret** MUSUNEST_PROBE_TOKEN を、そのステップの env にだけ渡す
//   - 無ければ wrangler を起動せずに exit 1（secret の無い production を配らない）。ヘッダに載らない文字（smoke.ts と同じ規則）と、
//     短すぎる値（PROBE_TOKEN_MIN_LENGTH 未満）も弾く。値はエラーにも出さない
//   - 値は一時ディレクトリ（0700）の中のファイル（0600）に JSON で書き、wrangler deploy --secrets-file に渡し、
//     wrangler が終わったらすぐに消す（成功しても失敗しても）。ログに出すのは secret の名前だけ
//   - wrangler の子プロセスには、この環境変数を渡さない（ファイルで渡す）
//   - wrangler は secret の値を "(hidden)" と表示するが、伏せる側でも値を持って伏せる（上の Account ID と同じ）
//   - --secrets-file は足し算で、ファイルに無い secret を消さない（wrangler 4.131.1 の deploy --help）
//
// ── 巻き戻し（--rollback-to <sha>）──────────────────────────────────────────────
//
// 3つの Worker を、**配備済みの版のうち GIT_SHA（deploy の --var）が <sha> のもの**へ wrangler rollback で切り替える
// （2026-09-14・Issue #17 の決定：コードの一次手段）。build も D1 マイグレーションもしない。secret も載せない
// （版は配った時点のコード・Static Assets・binding・secret を持っている）。古い版へ戻すのにも、新しい版へ戻す（復帰）のにも使う。
//
//   1. 読む（書かない）… Worker ごとに deployments status → 今の版、versions view → その GIT_SHA。
//                        今の版が <sha> でなければ versions list（直近 VERSIONS_LISTED 版）の版を全部 view する
//   2. 決める          … 切り替え先は GIT_SHA が <sha> の版のうち、いちばん新しいもの。見つからない Worker が1つでもあれば、
//                        何も切り替えずに exit 1（二次手段：古い v タグで deploy-production を手動実行）。既に <sha> の Worker は飛ばす。
//                        向きは「その commit が最初に配られた時刻」を今の commit と比べて決める（planRollback）。
//                        残りが全部「古い版へ」なら SWITCH_ORDER.back、全部「新しい版へ」なら forward。混ざっていれば切り替えずに exit 1
//   3. 切り替える      … 決めた順に wrangler rollback <版> --yes。1つずつ deployments status で 100% がその版になったことを確かめる。
//                        途中で落ちたら止める。同じ <sha> でもう一度動かせば、切り替え済みの Worker を飛ばして続きから切り替える
//
// 版を読む wrangler の出力（--json）は author_email を含むので、**JSON はファイルに受けて解釈し、版の ID・作成時刻・GIT_SHA だけを出す。**
// rollback の出力は deploy と同じく許した行だけを伏せて出す。伏せるものにメールアドレスの形を足してある。
// wrangler は設定の無い空の一時ディレクトリで動かし、Worker は --name で指す（wrangler.jsonc の env.<env>.name）。
// wrangler は cwd の .env を読むので、リポジトリ直下で動かすと手元の .env の資格情報が黙って使われる。空のディレクトリならそれが起きない。
//
// ── dev の貫通スモーク（--smoke）──────────────────────────────────────────────
//
// staging・production の貫通スモークの宛先は、CI の環境の Secret SMOKE_BASE_URL から pnpm smoke に渡す（CLAUDE.md「資格情報の置き場所」）。
// dev には CD も Secret も無い。だから --smoke は、宛先を **その場で組み立てて smoke.ts に渡す**（2026-09-15・Issue #67）。
//   1. Cloudflare の API（GET /accounts/<id>/workers/subdomain。読み取りだけ）で、アカウントの workers.dev のサブドメインを読む
//      （資格情報は CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID。measure-free-tier.ts と同じ読み方）
//   2. host の Worker 名（apps/host/wrangler.jsonc の env.dev.name）と合わせて https://<name>.<サブドメイン>.workers.dev を作る
//   3. smoke.ts の runCli を同じプロセスで呼び、環境変数 SMOKE_BASE_URL として渡す。--sha は --expect-sha になる
// 宛先は表示しない。ファイルにも、コマンド行にも、シェルの変数にも出さない。smoke の出力も伏せてから出す。
// smoke には SMOKE_BASE_URL だけを渡す。手元のシェルに SMOKE_PROBE_TOKEN（production の値）があっても dev の host には送らない。
// dev だけに限る：staging・production の宛先の置き場所を二重にしない。CLOUDFLARE_ACCOUNT_ID が production のアカウントなら止める。
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "jsonc-parser";
import { PROBE_REQUIRED_ENVS, RETRY_POLICY, runCli as runSmoke, type CliIo as SmokeIo } from "./smoke.ts";
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

/** X-Musunest-Probe と照合する Worker の secret。apps/host/src/worker/contract.ts・apps/gateway/src/contract.ts の PROBE_TOKEN_SECRET と同じ。 */
export const PROBE_TOKEN_SECRET = "MUSUNEST_PROBE_TOKEN";

/** /healthz の詳細を隠す Worker（wrangler.jsonc に vars.HEALTHZ_DETAIL を持つもの）。詳細を隠す env ではこれらに secret を載せる。 */
export const PROBE_TARGETS: readonly WorkerTarget[] = ["gateway", "host"];

/** MUSUNEST_PROBE_TOKEN の長さの下限。短い値は総当たりで当たる（例：`openssl rand -hex 32` は 64 文字） */
export const PROBE_TOKEN_MIN_LENGTH = 32;

export const EXIT_OK = 0;
export const EXIT_NG = 1;

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class DeployError extends Error {
  override name = "DeployError";
}

export interface WranglerCall {
  /** read は版を読む --json の呼び出し。出力は要約せず、JSON として解釈する */
  readonly kind: "migrate" | "deploy" | "rollback" | "read";
  /** wrangler を動かすディレクトリ（リポジトリルートからの相対パス。"." は直下）。null は設定も .env も無い空の一時ディレクトリ */
  readonly cwd: string | null;
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
    // X-Musunest-Probe に載せる値。smoke.ts の SMOKE_PROBE_TOKEN と同じく、空白を含まない表示可能な ASCII だけ
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

// ── 巻き戻し：読む・決める ─────────────────────────────────────────────────────

export type Direction = "back" | "forward";

/**
 * 切り替える Worker の順。forward は配る順（呼ばれる側を先に置く）、back はその逆（呼ぶ側を先に戻す）。
 * どちらも途中の瞬間は「呼ぶ側が古く、呼ばれる側が新しい」になり、配っている途中と同じ組み合わせしか生まれない。
 */
export const SWITCH_ORDER: Readonly<Record<Direction, readonly WorkerTarget[]>> = {
  forward: ["data-api", "gateway", "host"],
  back: ["host", "gateway", "data-api"],
};

/** wrangler versions list が返す版の数（wrangler 4.131.1 の VERSION_LIST_LIMIT）。これより前の版は探さない */
export const VERSIONS_LISTED = 10;

/** rollback の --message の頭。版の履歴（dashboard・deployments list）に残る */
export const ROLLBACK_MESSAGE = "deploy-worker --rollback-to";

const VERSION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface VersionInfo {
  readonly id: string;
  /** metadata.created_on（ISO 8601） */
  readonly createdOn: string;
}

export interface VersionDetail extends VersionInfo {
  /** binding GIT_SHA（plain_text）の値。無ければ undefined（--var GIT_SHA を付けずに配った版） */
  readonly gitSha: string | undefined;
}

/** Worker の名前（wrangler.jsonc の env.<env>.name）。版を読む・切り替える wrangler には設定を読ませず、--name で指す。 */
export function workerName(root: string, target: WorkerTarget, env: Env): string {
  const file = `${WORKER_DIRS[target]}/wrangler.jsonc`;
  const config = parse(readFileSync(join(root, file), "utf8")) as { env?: Record<string, { name?: unknown } | undefined> } | undefined;
  const name = config?.env?.[env]?.name;
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new DeployError(`${file} に env.${env}.name が無い`);
  return name;
}

/** 純粋関数。版を読む wrangler の呼び方（--json。空の一時ディレクトリで動かす）。 */
export const readCall = {
  status: (name: string): WranglerCall => ({ kind: "read", cwd: null, args: ["deployments", "status", "--name", name, "--json"], secrets: [] }),
  list: (name: string): WranglerCall => ({ kind: "read", cwd: null, args: ["versions", "list", "--name", name, "--json"], secrets: [] }),
  view: (name: string, versionId: string): WranglerCall => ({
    kind: "read",
    cwd: null,
    args: ["versions", "view", versionId, "--name", name, "--json"],
    secrets: [],
  }),
};

/** 純粋関数。版を切り替える wrangler の呼び方。--yes と、stdin を渡さないこと（非対話）で確認を既定値のまま進める。 */
export function rollbackCall(name: string, versionId: string, sha: string): WranglerCall {
  if (!VERSION_ID.test(versionId)) throw new DeployError("版の ID の形でない（値は表示しない）");
  return {
    kind: "rollback",
    cwd: null,
    args: ["rollback", versionId, "--name", name, "--message", `${ROLLBACK_MESSAGE} ${sha}`, "--yes"],
    secrets: [],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// JSON.parse の例外文言は入力の断片（author_email を含みうる）を含むので捨てる
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DeployError(`${what} の出力が JSON として読めない（中身は表示しない）`);
  }
}

function versionInfo(raw: unknown, what: string): VersionInfo {
  const id = isRecord(raw) ? raw["id"] : undefined;
  const createdOn = isRecord(raw) && isRecord(raw["metadata"]) ? raw["metadata"]["created_on"] : undefined;
  if (typeof id !== "string" || !VERSION_ID.test(id) || typeof createdOn !== "string" || Number.isNaN(Date.parse(createdOn))) {
    throw new DeployError(`${what} の形が想定と違う（id と metadata.created_on）`);
  }
  return { id, createdOn };
}

/** wrangler deployments status --json から、今のデプロイが 100% を向けている版の ID を読む。 */
export function parseCurrentVersion(text: string): string {
  const what = "wrangler deployments status --json";
  const raw = parseJson(text, what);
  const versions = isRecord(raw) ? raw["versions"] : undefined;
  if (!Array.isArray(versions)) throw new DeployError(`${what} の形が想定と違う（versions が無い）`);
  const [only] = versions;
  if (versions.length !== 1 || !isRecord(only) || only["percentage"] !== 100) {
    throw new DeployError("今のデプロイが1つの版に 100% を向けていない（段階的デプロイの途中）。切り替えずに止める（docs/runbook/rollback.md）");
  }
  const id = only["version_id"];
  if (typeof id !== "string" || !VERSION_ID.test(id)) throw new DeployError(`${what} の形が想定と違う（version_id）`);
  return id;
}

/** wrangler versions list --json を、新しい版から並べて返す。 */
export function parseVersionList(text: string): VersionInfo[] {
  const what = "wrangler versions list --json";
  const raw = parseJson(text, what);
  if (!Array.isArray(raw)) throw new DeployError(`${what} の形が想定と違う（配列でない）`);
  return raw.map((v) => versionInfo(v, what)).toSorted((a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn));
}

/** wrangler versions view --json から、版の ID・作成時刻・GIT_SHA を読む。 */
export function parseVersionDetail(text: string): VersionDetail {
  const what = "wrangler versions view --json";
  const raw = parseJson(text, what);
  const bindings = isRecord(raw) && isRecord(raw["resources"]) ? raw["resources"]["bindings"] : undefined;
  if (!Array.isArray(bindings)) throw new DeployError(`${what} の形が想定と違う（resources.bindings が無い）`);
  const git = bindings.find((b) => isRecord(b) && b["name"] === "GIT_SHA" && b["type"] === "plain_text");
  const value = isRecord(git) ? git["text"] : undefined;
  return { ...versionInfo(raw, what), gitSha: typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : undefined };
}

/** 版の GIT_SHA が、切り替え先の commit（7〜40 桁の先頭）と一致するか。 */
export function matchesSha(gitSha: string | undefined, sha: string): boolean {
  return gitSha !== undefined && gitSha.startsWith(sha.toLowerCase());
}

export interface WorkerVersions {
  readonly target: WorkerTarget;
  readonly name: string;
  readonly current: VersionDetail;
  /** 読んだ版（今の版を含む）。今の版が切り替え先の commit なら今の版だけでよい */
  readonly versions: readonly VersionDetail[];
}

export interface Switch {
  readonly target: WorkerTarget;
  readonly name: string;
  readonly from: VersionDetail;
  readonly to: VersionDetail;
}

export interface RollbackPlan {
  /** 切り替えるものが無ければ undefined */
  readonly direction: Direction | undefined;
  /** 切り替える順に並べたもの */
  readonly switches: readonly Switch[];
  /** 既に切り替え先の版で動いている Worker */
  readonly unchanged: readonly WorkerTarget[];
}

/** その commit が最初に配られた時刻（読んだ版のうち、いちばん古いもの）。二次手段で古い commit を配り直しても、コードの新旧はこれで決まる */
function firstDeployed(versions: readonly VersionDetail[], matches: (v: VersionDetail) => boolean): number {
  return Math.min(...versions.filter(matches).map((v) => Date.parse(v.createdOn)));
}

/**
 * 純粋関数。読んだ版から、どの Worker をどの版へどの順で切り替えるかを決める。決められなければ DeployError（何も切り替えない）。
 *   切り替え先 … GIT_SHA が一致する版のうち、いちばん新しいもの（今の版が一致すれば今の版）
 *   向き       … 切り替え先の commit と今の commit の、それぞれが最初に配られた時刻で比べる。版の作成時刻そのものでは比べない
 *                （古いタグで deploy-production を回し直すと、古いコードの版のほうが新しくなる）
 */
export function planRollback(workers: readonly WorkerVersions[], sha: string): RollbackPlan {
  const wanted = new Map<WorkerTarget, VersionDetail>();
  for (const w of workers) {
    const found = matchesSha(w.current.gitSha, sha)
      ? w.current
      : w.versions.filter((v) => matchesSha(v.gitSha, sha)).toSorted((a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn))[0];
    if (found !== undefined) wanted.set(w.target, found);
  }
  const missing = workers.filter((w) => !wanted.has(w.target)).map((w) => w.target);
  if (missing.length > 0) {
    throw new DeployError(
      `GIT_SHA が ${sha} の版が見つからない：${missing.join(", ")}（直近 ${VERSIONS_LISTED} 版まで探した）。何も切り替えない。` +
        "二次手段：その commit の v タグで deploy-production を手動実行する（docs/runbook/rollback.md）",
    );
  }
  const switches: Switch[] = [];
  const unchanged: WorkerTarget[] = [];
  const directions = new Map<Direction, WorkerTarget[]>();
  for (const w of workers) {
    const to = wanted.get(w.target);
    if (to === undefined) continue;
    if (to.id === w.current.id) {
      unchanged.push(w.target);
      continue;
    }
    switches.push({ target: w.target, name: w.name, from: w.current, to });
    const all = [w.current, ...w.versions];
    const target = firstDeployed(all, (v) => matchesSha(v.gitSha, sha));
    // GIT_SHA の無い今の版は、その版の作成時刻で比べる
    const current = w.current.gitSha === undefined ? Date.parse(w.current.createdOn) : firstDeployed(all, (v) => v.gitSha === w.current.gitSha);
    const direction: Direction = target < current ? "back" : "forward";
    directions.set(direction, [...(directions.get(direction) ?? []), w.target]);
  }
  const [direction, ...others] = [...directions.keys()];
  if (others.length > 0) {
    throw new DeployError(
      `古い版へ戻す Worker（${directions.get("back")?.join(", ")}）と新しい版へ進める Worker（${directions.get("forward")?.join(", ")}）が混ざっている。` +
        "どちらの順でも途中の組み合わせを保証できないので、何も切り替えない（docs/runbook/rollback.md）",
    );
  }
  const ordered = direction === undefined ? [] : SWITCH_ORDER[direction].flatMap((t) => switches.filter((s) => s.target === t));
  return { direction, switches: ordered, unchanged };
}

// ── dev の貫通スモーク：宛先を組み立てる ───────────────────────────────────────────

/** --smoke で宛先を組み立ててよい env。staging・production の宛先は CI の環境の Secret SMOKE_BASE_URL にだけ置く */
export const SMOKE_ENVS: readonly Env[] = ["dev"];

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Cloudflare の API の1回の呼び出しの上限 */
export const API_TIMEOUT_MS = 30_000;

export interface ApiCredentials {
  readonly token: string;
  readonly accountId: string;
}

/** CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を読む。production のアカウントなら止める。値はエラーにも出さない。 */
export function readApiCredentials(env: Readonly<Record<string, string | undefined>>): ApiCredentials {
  const token = env["CLOUDFLARE_API_TOKEN"];
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"];
  if (token === undefined || token === "" || accountId === undefined || accountId === "") {
    throw new DeployError("--smoke には環境変数 CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る（アカウント①の CI 用トークン。workers.dev のサブドメインを読む）");
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new DeployError("CLOUDFLARE_API_TOKEN にヘッダに載せられない文字（空白・改行・非 ASCII）がある（値は表示しない）");
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new DeployError("CLOUDFLARE_ACCOUNT_ID が Account ID の形（32 桁の 16 進）でない（値は表示しない）");
  }
  const production = env["CLOUDFLARE_ACCOUNT_ID_PROD"];
  if (production !== undefined && production.toLowerCase() === accountId.toLowerCase()) {
    throw new DeployError("CLOUDFLARE_ACCOUNT_ID が production のアカウント（CLOUDFLARE_ACCOUNT_ID_PROD）を指している。--smoke は dev（アカウント①）だけ");
  }
  return { token, accountId };
}

/** GET /accounts/<id>/workers/subdomain の応答から、workers.dev のサブドメイン（DNS のラベル）を読む。値はエラーに出さない。 */
export function parseSubdomain(body: unknown): string {
  const result = isRecord(body) ? body["result"] : undefined;
  const subdomain = isRecord(result) ? result["subdomain"] : undefined;
  if (!isRecord(body) || body["success"] !== true || typeof subdomain !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(subdomain)) {
    throw new DeployError("Workers のサブドメインが読めない（workers.dev のサブドメインが無いか、応答の形が違う。値は表示しない）");
  }
  return subdomain.toLowerCase();
}

/** 純粋関数。host の workers.dev のオリジン。**表示しない**（smoke.ts に SMOKE_BASE_URL として渡すだけ）。 */
export const hostOrigin = (hostName: string, subdomain: string): string => `https://${hostName}.${subdomain}.workers.dev`;

// ── 伏せる ─────────────────────────────────────────────────────────────────

// CSI（色・カーソル）、OSC（リンク。BEL か ST で終わる）、それ以外の2文字のエスケープ
// oxlint-disable-next-line no-control-regex -- ANSI エスケープを取り除くための意図した制御文字
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** workers.dev のホスト名（サブドメインの段を全部含む）。 */
export const WORKERS_DEV_HOST = /(?:[a-z0-9_-]+\.)+workers\.dev(?![a-z0-9_-])/gi;
const ACCOUNT_ID_SHAPE = /\b[0-9a-f]{32}\b/gi;
/** メールアドレスの形。版とデプロイの記録（author_email）に載る */
const EMAIL_SHAPE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

export const REDACTED_HOST = "<伏せた>.workers.dev";
export const REDACTED_ACCOUNT = "<伏せた:account>";
export const REDACTED_SECRET = "<伏せた:secret>";
export const REDACTED_EMAIL = "<伏せた:email>";

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
  return out.replace(ACCOUNT_ID_SHAPE, REDACTED_ACCOUNT).replace(WORKERS_DEV_HOST, REDACTED_HOST).replace(EMAIL_SHAPE, REDACTED_EMAIL);
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
  // wrangler 4.131.1 の versions/rollback のソースから。行頭に枠の文字（├ │ ╰）と細い空白が付く
  rollback: [
    { line: /Your current deployment has \d+ version\(s\):/ },
    { line: /\(\d+%\) [0-9a-f-]{36}\s*$/ },
    { line: /Created:\s+\d{4}-/ },
    { line: /Using (?:default|fallback) value in non-interactive context:/ }, // message と確認を CI で既定値のまま進めたこと
    { line: /WARNING\s+You are about to rollback to Worker Version / },
    // secret が変わった版へ戻すとき。続く字下げの行が secret の名前（値ではない）。非対話では確かめずに進む
    { line: /The following secrets have changed since version /, continuation: true },
    { line: /^Performing rollback\.\.\./ },
    { line: /Aborting rollback/ },
    { line: /Worker Version \S+ has been deployed to 100% of traffic\./ },
    { line: /^Current Version ID: / },
    { line: /^▲ \[WARNING\] / },
  ],
  // 出力は JSON としてファイルに受けて解釈する。ログには出さない
  read: [],
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
   * 載せる Worker の secret（MUSUNEST_PROBE_TOKEN。子プロセスには渡さない）もここから読む
   */
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** wrangler を起動するコマンド（実行ファイルと、その前に置く引数） */
  wrangler: readonly string[];
  /** --smoke：Cloudflare の API（workers.dev のサブドメイン）と host の /healthz を叩く。省略すれば Node の fetch */
  fetch?: typeof fetch;
  /** --smoke：smoke の時計・待ち・再試行の方針。省略すれば smoke.ts の既定（RETRY_POLICY） */
  smoke?: Pick<SmokeIo, "now" | "sleep" | "policy">;
}

const USAGE = `usage: pnpm exec tsx infra/scripts/deploy-worker.ts --env <${ENVS.join("|")}> --target <${TARGETS.join("|")}> [--sha <sha>] [--log-dir <dir>]
       pnpm exec tsx infra/scripts/deploy-worker.ts --env <${ENVS.join("|")}> --rollback-to <sha> [--log-dir <dir>]
       pnpm exec tsx infra/scripts/deploy-worker.ts --env <${SMOKE_ENVS.join("|")}> --smoke [--sha <sha>]

  --env <env>          配る先の環境。wrangler の --env に渡す
  --target <target>    migrate … D1 マイグレーション（${MIGRATION_CONFIG} の ${MIGRATION_DATABASE} に --remote で当てる）
                       ${Object.entries(WORKER_DIRS)
                         .map(([name, dir]) => `${name} … ${dir} で wrangler deploy`)
                         .join("\n                       ")}
  --sha <sha>          deploy に必須。--var GIT_SHA:<sha> で渡す（7〜40 桁の 16 進）
  --rollback-to <sha>  3つの Worker を、配備済みの版のうち GIT_SHA が <sha> のものへ wrangler rollback で切り替える。
                       build も D1 マイグレーションもしない。古い版へは ${SWITCH_ORDER.back.join(" → ")}、新しい版へは ${SWITCH_ORDER.forward.join(" → ")} の順。
                       --target・--sha と一緒に使わない
  --smoke              ${SMOKE_ENVS.join(" / ")} だけ。host の workers.dev のオリジンを Cloudflare の API のサブドメインから組み立て（表示しない）、
                       SMOKE_BASE_URL として pnpm smoke と同じ判定に渡す。--sha は --expect-sha になる。
                       資格情報は CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID。--target・--rollback-to と一緒に使わない
  --log-dir <dir>      wrangler の出力を受けるファイルの置き場。既定は $RUNNER_TEMP、無ければ OS の一時ディレクトリ

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
        "rollback-to": { type: "string" },
        smoke: { type: "boolean" },
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
  if (values.smoke === true) {
    if (values.target !== undefined || values["rollback-to"] !== undefined) {
      throw new DeployError(`--smoke は --target・--rollback-to と一緒に使わない\n${USAGE}`);
    }
    if (values.sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(values.sha)) {
      throw new DeployError("--sha は 7〜40 桁の 16 進（commit の SHA）を渡す（値は表示しない）");
    }
    return await runSmokeCheck(values.env, values.sha?.toLowerCase(), io);
  }
  const tempBase = resolve(io.env["RUNNER_TEMP"] ?? tmpdir());
  const logDir = resolve(values["log-dir"] ?? tempBase);
  const rollbackTo = values["rollback-to"];
  if (rollbackTo !== undefined) {
    if (values.target !== undefined || values.sha !== undefined) throw new DeployError(`--rollback-to は --target・--sha と一緒に使わない\n${USAGE}`);
    if (!/^[0-9a-f]{7,40}$/i.test(rollbackTo)) {
      throw new DeployError("--rollback-to は 7〜40 桁の 16 進（commit の SHA）を渡す（値は表示しない）");
    }
    return await runRollback(values.env, rollbackTo.toLowerCase(), io, logDir, tempBase);
  }
  if (values.target === undefined) throw new DeployError(`--target が無い（または --rollback-to・--smoke）\n${USAGE}`);
  if (!isTarget(values.target)) throw new DeployError(`未知の target（${TARGETS.join(" / ")} のいずれか。値は表示しない）`);
  const sha = values.sha;
  if (sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new DeployError("--sha は 7〜40 桁の 16 進（commit の SHA）を渡す（値は表示しない）");
  }
  const env = values.env;
  const target = values.target;
  const call = wranglerCall(target, env, sha);
  const secrets = readSecrets(call.secrets, io.env);

  const logPath = join(logDir, `deploy-worker-${env}-${target}.log`);
  const accountId = io.env["CLOUDFLARE_ACCOUNT_ID"];
  const secretValues = Object.values(secrets);
  const label = `${target}（env=${env}）`;

  // 一時ファイルのパスは毎回変わるので、載せる secret の名前だけを出す
  const shownArgs = [...call.args, ...(call.secrets.length === 0 ? [] : ["--secrets-file", `<一時ファイル: ${call.secrets.join(", ")}>`])];
  io.out(`deploy-worker: ${label}: wrangler ${shownArgs.join(" ")}（${call.cwd ?? "一時ディレクトリ"}）`);
  const code = await runWrangler(io, call, { logPath, secrets, tempBase });
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

/** 版の見せ方。ID・GIT_SHA の先頭・作成時刻だけ（author_email などは出さない） */
const showVersion = (v: VersionDetail): string => `${v.id}（GIT_SHA ${v.gitSha?.slice(0, 12) ?? "なし"}・${v.createdOn}）`;

/**
 * --rollback-to：3つの Worker の版を読み、切り替える順を決め、wrangler rollback で1つずつ切り替える（冒頭「巻き戻し」）。
 * 読んでいる途中・決められないときは何も切り替えずに DeployError。切り替えの途中で落ちたら、どこまで切り替えたかを出して exit 1。
 */
async function runRollback(env: Env, sha: string, io: CliIo, logDir: string, tempBase: string): Promise<number> {
  const accountId = io.env["CLOUDFLARE_ACCOUNT_ID"];
  const label = `rollback（env=${env}）`;
  // 設定も .env も無い空のディレクトリで wrangler を動かす（冒頭「巻き戻し」）
  mkdirSync(tempBase, { recursive: true });
  const emptyDir = mkdtempSync(join(tempBase, "deploy-worker-rollback-"));
  let seq = 0;

  /** wrangler を1回動かす。exit 0 以外は伏せた全文を出して DeployError。read は標準出力（JSON）を、rollback は要約を返す */
  const invoke = async (call: WranglerCall, what: string): Promise<{ stdout: string; summary: string[] }> => {
    const base = join(logDir, `deploy-worker-${env}-rollback-${String(++seq).padStart(2, "0")}`);
    const logPath = `${base}.log`;
    const stdoutPath = call.kind === "read" ? `${base}.json` : undefined;
    const code = await runWrangler(io, call, { logPath, stdoutPath, secrets: {}, tempBase, emptyDir });
    const text = readFileSync(logPath, "utf8");
    if (code !== 0) {
      io.out(`deploy-worker: ${what}: wrangler が exit ${code} で終わった。出力（${logPath}）の全文を伏せて出す`);
      for (const line of failureLines(text, accountId)) io.out(`  ${line}`);
      throw new DeployError(`${what} に失敗した（上の出力）`);
    }
    return {
      stdout: stdoutPath === undefined ? "" : readFileSync(stdoutPath, "utf8"),
      summary: call.kind === "read" ? [] : summarize(call.kind, text, accountId),
    };
  };
  const currentVersionId = async (name: string): Promise<string> =>
    parseCurrentVersion((await invoke(readCall.status(name), `${name} の今のデプロイを読む`)).stdout);
  const versionDetail = async (name: string, id: string): Promise<VersionDetail> =>
    parseVersionDetail((await invoke(readCall.view(name, id), `${name} の版 ${id} を読む`)).stdout);

  try {
    io.out(`deploy-worker: ${label}: 3つの Worker を GIT_SHA が ${sha} の版へ切り替える。build も D1 マイグレーションもしない`);
    io.out(`deploy-worker: wrangler の出力は ${join(logDir, `deploy-worker-${env}-rollback-*`)} に受けた。ここには版の ID・作成時刻・GIT_SHA と、伏せた要約だけを出す`);

    // 1. 読む（書かない）。今の版が切り替え先の commit でなければ、直近の版を全部読む（向きを決めるのに、各 commit が最初に配られた時刻が要る）
    const workers: WorkerVersions[] = [];
    for (const target of SWITCH_ORDER.forward) {
      const name = workerName(io.root, target, env);
      const current = await versionDetail(name, await currentVersionId(name));
      const versions: VersionDetail[] = [current];
      if (!matchesSha(current.gitSha, sha)) {
        const listed = parseVersionList((await invoke(readCall.list(name), `${name} の版の一覧を読む`)).stdout);
        for (const version of listed.filter((v) => v.id !== current.id)) versions.push(await versionDetail(name, version.id));
      }
      workers.push({ target, name, current, versions });
      io.out(`  ${target}（${name}）: 今 ${showVersion(current)}。読んだ版 ${versions.length}`);
    }

    // 2. 決める
    const plan = planRollback(workers, sha);
    if (plan.direction === undefined) {
      io.out(`deploy-worker: OK  ${label}: 3つとも既に GIT_SHA ${sha} の版で動いている。切り替えるものは無い`);
      return EXIT_OK;
    }
    for (const s of plan.switches) io.out(`  ${s.target}: ${showVersion(s.from)} → ${showVersion(s.to)}`);
    const order = plan.switches.map((s) => s.target);
    io.out(
      `deploy-worker: ${plan.direction === "back" ? "古い版へ戻す" : "新しい版へ進める"}。順は ${order.join(" → ")}` +
        (plan.unchanged.length === 0 ? "" : `（${plan.unchanged.join(", ")} は既に切り替え先の版なので飛ばす）`),
    );

    // 3. 切り替える
    const started = Date.now();
    const done: WorkerTarget[] = [];
    try {
      for (const s of plan.switches) {
        const call = rollbackCall(s.name, s.to.id, sha);
        io.out(`deploy-worker: ${s.target}: wrangler ${call.args.join(" ")}`);
        const { summary } = await invoke(call, `${s.target} の rollback`);
        if (summary.length === 0) io.out("  （要約に当たる行が無い。wrangler の出力の形が変わった可能性がある）");
        for (const line of summary) io.out(`  ${line}`);
        const now = await currentVersionId(s.name);
        if (now !== s.to.id) throw new DeployError(`${s.target}: rollback の後も、今のデプロイが切り替え先の版を向いていない（今 ${now}）`);
        io.out(`deploy-worker: ${s.target}: 今のデプロイが ${s.to.id} を 100% で向いていることを確かめた`);
        done.push(s.target);
      }
    } catch (e) {
      const rest = order.filter((t) => !done.includes(t));
      io.out(
        `deploy-worker: 切り替え済み：${done.length === 0 ? "なし" : done.join(", ")}。未切り替え：${rest.join(", ")}。` +
          "途中の組み合わせは配っている途中と同じ（呼ぶ側が古く、呼ばれる側が新しい）。同じ --rollback-to でもう一度動かすと、続きから切り替える",
      );
      throw e;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    io.out(`deploy-worker: OK  ${label}: 3つの Worker が GIT_SHA ${sha} の版で動いている（切り替え ${seconds} 秒）`);
    return EXIT_OK;
  } catch (e) {
    if (e instanceof DeployError) io.out(`deploy-worker: NG  ${label}`);
    throw e;
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

/**
 * --smoke：host の workers.dev のオリジンを組み立て、smoke.ts の判定に SMOKE_BASE_URL として渡す（冒頭「dev の貫通スモーク」）。
 * 宛先は表示しない。smoke の exit code（全層 ok なら 0）をそのまま返す。
 */
async function runSmokeCheck(env: Env, sha: string | undefined, io: CliIo): Promise<number> {
  if (!SMOKE_ENVS.includes(env)) {
    throw new DeployError(
      `--smoke は ${SMOKE_ENVS.join(" / ")} だけ。${env} の宛先は CI の ${env} 環境の Secret SMOKE_BASE_URL から pnpm smoke に渡す（CLAUDE.md「資格情報の置き場所」）`,
    );
  }
  const credentials = readApiCredentials(io.env);
  const name = workerName(io.root, "host", env);
  const label = `smoke（env=${env}）`;
  const fetchImpl = io.fetch ?? ((input, init) => fetch(input, init));
  io.out(`deploy-worker: ${label}: 宛先は host（${name}）の workers.dev のオリジン。Cloudflare の API で読んだサブドメインから組み立て、表示しない`);

  const subdomain = parseSubdomain(await callSubdomainApi(fetchImpl, credentials));
  // smoke は URL を出さないが、応答から持ち出す文字列もあるので、伏せてから出す
  const shown = (line: string): string => neutralize(redact(line, credentials.accountId, [credentials.token, subdomain]));
  const code = await runSmoke(["--env", env, ...(sha === undefined ? [] : ["--expect-sha", sha])], {
    // 宛先だけを渡す。SMOKE_PROBE_TOKEN（production の値）は dev の host に送らない
    env: { SMOKE_BASE_URL: hostOrigin(name, subdomain) },
    out: (line) => io.out(shown(line)),
    err: (line) => io.err(shown(line)),
    fetch: fetchImpl,
    now: io.smoke?.now ?? (() => performance.now()),
    sleep: io.smoke?.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    policy: io.smoke?.policy ?? RETRY_POLICY,
  });
  io.out(`deploy-worker: ${code === 0 ? "OK" : "NG"}  ${label}`);
  return code === 0 ? EXIT_OK : EXIT_NG;
}

/** GET /accounts/<id>/workers/subdomain（読み取りだけ）。応答の本文を返す。失敗の文言には URL も値も入れない。 */
async function callSubdomainApi(fetchImpl: typeof fetch, credentials: ApiCredentials): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${CLOUDFLARE_API}/accounts/${credentials.accountId}/workers/subdomain`, {
      method: "GET",
      headers: { authorization: `Bearer ${credentials.token}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    // 例外の文言は URL（Account ID）を含み得る。種別だけを出す
    const cause = (e as { cause?: unknown }).cause;
    const code = isRecord(cause) ? cause["code"] : (e as { code?: unknown }).code;
    const kind = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : e instanceof Error && /^\w+$/.test(e.name) ? e.name : typeof e;
    throw new DeployError(`Cloudflare の API に届かない（${kind}）`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new DeployError(`Workers のサブドメインを読む権限が無い（HTTP ${res.status}）。CLOUDFLARE_API_TOKEN はアカウント①の CI 用トークンを渡す`);
  }
  try {
    return await res.json();
  } catch {
    throw new DeployError(`Workers のサブドメインの応答が JSON でない（HTTP ${res.status}）`);
  }
}

interface RunOptions {
  /** 標準エラー（stdoutPath が無ければ標準出力も）を受けるファイル */
  readonly logPath: string;
  /** 標準出力だけを分けて受けるファイル（--json の出力） */
  readonly stdoutPath?: string | undefined;
  readonly secrets: Readonly<Record<string, string>>;
  /** secret の一時ファイルの置き場 */
  readonly tempBase: string;
  /** call.cwd が null のときに動かすディレクトリ */
  readonly emptyDir?: string | undefined;
}

/**
 * wrangler を1回動かし、標準出力と標準エラーをファイルに受ける。exit code を返す（シグナルで終われば 1）。
 * secrets があれば tempBase の下の一時ディレクトリにファイルで書いて --secrets-file で渡し、wrangler が終わったら消す。
 */
async function runWrangler(io: CliIo, call: WranglerCall, options: RunOptions): Promise<number> {
  const { logPath, stdoutPath, secrets, tempBase, emptyDir } = options;
  const [command, ...prefix] = io.wrangler;
  if (command === undefined) throw new DeployError("wrangler を起動するコマンドが無い");
  const cwd = call.cwd === null ? emptyDir : join(io.root, call.cwd);
  if (cwd === undefined) throw new DeployError("wrangler を動かす空のディレクトリが無い");
  // 載せる secret の環境変数は子プロセスに渡さない（ファイルで渡す）
  const childEnv: Record<string, string | undefined> = { ...io.env, FORCE_COLOR: "0" };
  delete childEnv[PROBE_TOKEN_SECRET];
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  const outFd = stdoutPath === undefined ? fd : openSync(stdoutPath, "w");
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
        cwd,
        // 色を切る（伏せる前に ANSI も落とすが、出さないに越したことはない）。stdin を渡さない：確認は非対話の既定値で進む
        env: childEnv,
        stdio: ["ignore", outFd, fd],
      });
      child.on("error", (e) => {
        const code = (e as { code?: unknown }).code;
        fail(new DeployError(`wrangler を起動できない（${typeof code === "string" ? code : e.name}）`));
      });
      child.on("close", (exit) => done(exit ?? 1));
    });
  } finally {
    closeSync(fd);
    if (outFd !== fd) closeSync(outFd);
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
