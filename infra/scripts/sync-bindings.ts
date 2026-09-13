// infra:sync — Terraform の `bindings` 出力を各 Worker の wrangler.jsonc へ冪等に書き戻す（03 §3）。
//
//   pnpm infra:sync --env <dev|staging|production> [--check] [--bindings <file|->]
//
// wrangler.jsonc は人間が読み書きする「サービス単位の正本」である。生成物にはしない。
// 機械が触るのは **Terraform 由来の欄だけ**で、コメントも書式もそのまま残す。
//
// ── 同期先の形（#6 / #8 / #9 が wrangler.jsonc を書くときの契約）──────────────────
//
//   対象ファイル … apps/<pkg>/wrangler.jsonc（apps/ 直下で package.json を持つもの全部）と
//                 packages/data-api/wrangler.jsonc。package.json の deploy:* の --filter と同じ集合で、
//                 「配備されるものは全部同期する」。1つでも欠けていれば失敗する。
//   対象ブロック … `env.<env>` だけ。トップレベルには触らない。
//                 deploy は必ず --env を付け、wrangler は env.* があるのに該当 env が無いと
//                 エラーにする（wrangler 4.131 で確認）。だから dev も `env.dev` に書く。
//   対象の欄    … binding 名で要素を特定し、下の表の欄の**値だけ**を差し替える。
//                 binding 名はサービス側の名前で、destroy → apply でも変わらない唯一の手がかり。
//                 欄を足す・消す・並べ替えることはしない（構造は人が書く）。だから欄は最初から書いておく。
//                 値は仮の文字列でよい（例 "database_id": "<TF_OUTPUT>"）。欄が無ければ失敗する。
//
//   | bindings のキー                      | wrangler.jsonc の欄                                   |
//   |--------------------------------------|-------------------------------------------------------|
//   | d1_control_id / d1_control_name      | d1_databases[CONTROL_DB].database_id / database_name  |
//   | r2_bundles_name                      | r2_buckets[BUNDLES].bucket_name                       |
//   | r2_uploads_name                      | r2_buckets[UPLOADS].bucket_name                       |
//   | queue_build_name                     | queues.producers[BUILD_QUEUE].queue                   |
//   | wfp_namespace_name（null 可）        | dispatch_namespaces[DISPATCHER].namespace             |
//   | account_id                           | **書かない**（public リポジトリに置かない）            |
//   | turnstile_sitekey（null）            | 置き場が未定。null 以外が来たら失敗する                 |
//   | env                                  | --env と一致するかの照合だけに使う                     |
//
// ── 失敗にするもの（黙って見逃すと乖離を検知できなくなるので）────────────────────
//
//   - d1_databases / r2_buckets / queues.producers / dispatch_namespaces に、上の表に無い binding がある
//     → これらはアカウント単位資源で Terraform が持つ（IaC二層）。bindings に対応しない binding は食い違い
//   - 値が null（資源が無い）の binding を wrangler が参照している
//   - kv_namespaces / queues.consumers がある
//     → KV の namespace id は bindings に出ていない。consumer は binding を持たず、どの Queue か決められない。
//       使うときは terraform output と SECTIONS を先に拡張する
//
// ── 安全面 ──────────────────────────────────────────────────────────────────
//
// bindings は `sensitive = true`（account_id を含む）。**値をログ・エラー・差分表示に一切出さない。**
// 出すのはファイル名・欄のパス・件数だけ。JSON.parse の例外文言は入力の断片を含むので捨てる。
// terraform の stderr も出さない（backend の endpoint URL がアカウント ID を含むため）。
// CI ログは公開される（CLAUDE.md「このリポジトリは public である」）。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Edit,
  type Node,
  type ParseError,
} from "jsonc-parser";

export const ENVS = ["dev", "staging", "production"] as const;
export type Env = (typeof ENVS)[number];

/** infra/terraform/modules/musubi-env/outputs.tf の `bindings`。キーを増やさない・減らさない・改名しない。 */
export interface Bindings {
  env: Env;
  account_id: string;
  d1_control_id: string;
  d1_control_name: string;
  r2_bundles_name: string;
  r2_uploads_name: string;
  queue_build_name: string;
  wfp_namespace_name: string | null;
  turnstile_sitekey: string | null;
}

const STRING_KEYS = [
  "account_id",
  "d1_control_id",
  "d1_control_name",
  "r2_bundles_name",
  "r2_uploads_name",
  "queue_build_name",
] as const;
const NULLABLE_KEYS = ["wfp_namespace_name", "turnstile_sitekey"] as const;
const BINDING_KEYS: readonly string[] = ["env", ...STRING_KEYS, ...NULLABLE_KEYS];

type SyncedKey = Exclude<keyof Bindings, "env" | "account_id" | "turnstile_sitekey">;

interface Section {
  /** env.<env> からの相対パス */
  path: readonly string[];
  /** binding 名 → { wrangler の欄: bindings のキー } */
  rules: Readonly<Record<string, Readonly<Record<string, SyncedKey>>>>;
}

// 同期の正本。表（ファイル冒頭）を変えるときはここを変える。
const SECTIONS: readonly Section[] = [
  {
    path: ["d1_databases"],
    rules: { CONTROL_DB: { database_id: "d1_control_id", database_name: "d1_control_name" } },
  },
  {
    path: ["r2_buckets"],
    rules: { BUNDLES: { bucket_name: "r2_bundles_name" }, UPLOADS: { bucket_name: "r2_uploads_name" } },
  },
  {
    path: ["queues", "producers"],
    rules: { BUILD_QUEUE: { queue: "queue_build_name" } },
  },
  {
    path: ["dispatch_namespaces"],
    rules: { DISPATCHER: { namespace: "wfp_namespace_name" } },
  },
];

const UNSUPPORTED: readonly { path: readonly string[]; reason: string }[] = [
  {
    path: ["kv_namespaces"],
    reason: "KV の namespace id は bindings に出ていない（terraform output と infra:sync を先に拡張する）",
  },
  {
    path: ["queues", "consumers"],
    reason: "consumer は binding を持たず、どの Queue か機械で決められない（infra:sync を先に拡張する）",
  },
];

/** 値を含まない、そのまま利用者へ見せてよい失敗。 */
export class SyncError extends Error {
  override name = "SyncError";
}

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_ERROR = 2;

const isEnv = (v: unknown): v is Env => typeof v === "string" && (ENVS as readonly string[]).includes(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `terraform output -json bindings` の出力を検証して読む。 */
export function parseBindings(text: string): Bindings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // 例外文言は入力の断片を含む。捨てる。
    throw new SyncError("bindings が読めない: JSON として解釈できない");
  }
  if (!isRecord(raw)) throw new SyncError("bindings が読めない: JSON オブジェクトではない");

  const missing = BINDING_KEYS.filter((k) => !Object.hasOwn(raw, k));
  if (missing.length > 0) throw new SyncError(`bindings が読めない: キーが足りない（${missing.join(", ")}）`);
  const unknown = Object.keys(raw).filter((k) => !BINDING_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new SyncError(`bindings が読めない: outputs.tf に無いキーがある（${unknown.join(", ")}）`);
  }

  if (!isEnv(raw["env"])) throw new SyncError(`bindings が読めない: env が ${ENVS.join(" / ")} のいずれでもない`);
  for (const k of STRING_KEYS) {
    const v = raw[k];
    if (typeof v !== "string" || v === "") throw new SyncError(`bindings が読めない: ${k} が空でない文字列ではない`);
  }
  for (const k of NULLABLE_KEYS) {
    const v = raw[k];
    if (v !== null && (typeof v !== "string" || v === "")) {
      throw new SyncError(`bindings が読めない: ${k} が null でも空でない文字列でもない`);
    }
  }
  return raw as unknown as Bindings;
}

export interface SyncResult {
  text: string;
  changed: boolean;
  /** 書き換えた（--check なら乖離している）欄のパス。値は含まない。 */
  updated: string[];
}

/**
 * 純粋関数。wrangler.jsonc のテキストの `env.<env>` を bindings に合わせたテキストを返す。
 * 一致していれば入力と同じテキストを返し、changed は false になる。
 */
export function syncBindings(bindings: Bindings, text: string, options: { env: Env }): SyncResult {
  const { env } = options;
  if (bindings.env !== env) {
    throw new SyncError(`bindings の env が --env ${env} と一致しない（別環境の terraform output を渡していないか）`);
  }
  if (bindings.turnstile_sitekey !== null) {
    throw new SyncError("turnstile_sitekey の同期先が決まっていない（置き場を決めて infra:sync を拡張する）");
  }

  const root = parseJsonc(text);
  const block = findNodeAtLocation(root, ["env", env]);
  if (block === undefined) throw new SyncError(`同期先が無い: env.${env} が無い`);
  if (block.type !== "object") throw new SyncError(`JSONC の形が不正: env.${env} がオブジェクトではない`);

  for (const { path, reason } of UNSUPPORTED) {
    const node = findNodeAtLocation(block, [...path]);
    if (node !== undefined && !(node.type === "array" && (node.children ?? []).length === 0)) {
      throw new SyncError(`env.${env}.${path.join(".")} は扱えない: ${reason}`);
    }
  }

  const edits: Edit[] = [];
  const updated: string[] = [];
  for (const section of SECTIONS) {
    const where = `env.${env}.${section.path.join(".")}`;
    const list = findNodeAtLocation(block, [...section.path]);
    if (list === undefined) continue;
    if (list.type !== "array") throw new SyncError(`JSONC の形が不正: ${where} が配列ではない`);

    (list.children ?? []).forEach((entry, index) => {
      const bindingNode = entry.type === "object" ? findNodeAtLocation(entry, ["binding"]) : undefined;
      const binding: unknown = bindingNode === undefined ? undefined : getNodeValue(bindingNode);
      if (typeof binding !== "string") {
        throw new SyncError(`JSONC の形が不正: ${where}[${index}] に文字列の binding が無い`);
      }
      const rule = Object.hasOwn(section.rules, binding) ? section.rules[binding] : undefined;
      if (rule === undefined) {
        throw new SyncError(`${where}[${binding}] は Terraform の bindings に対応しない binding である`);
      }
      for (const [field, key] of Object.entries(rule)) {
        const value = bindings[key];
        if (value === null) {
          throw new SyncError(`${where}[${binding}] が参照する資源が Terraform に無い（${key} が null）`);
        }
        const label = `${where}[${binding}].${field}`;
        const current = findNodeAtLocation(entry, [field]);
        if (current === undefined) {
          throw new SyncError(`同期先が無い: ${label} の欄が無い（値は仮の文字列でよい。infra:sync が書き戻す）`);
        }
        if (current.type === "string" && getNodeValue(current) === value) continue;
        // 値のトークンだけを置き換える。前後のコメント・空白・カンマには触れない。
        edits.push({ offset: current.offset, length: current.length, content: JSON.stringify(value) });
        updated.push(label);
      }
    });
  }

  // 各 edit は別々の値トークンを指すので重ならない。applyEdits は後ろから当てるので位置もずれない。
  const next = applyEdits(text, edits);
  return { text: next, changed: next !== text, updated };
}

function parseJsonc(text: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first !== undefined) {
    const line = text.slice(0, first.offset).split("\n").length;
    throw new SyncError(`JSONC が壊れている: ${line} 行目（${printParseErrorCode(first.error)}）`);
  }
  if (root === undefined || root.type !== "object") {
    throw new SyncError("JSONC が壊れている: トップレベルがオブジェクトではない");
  }
  return root;
}

/** 同期先（リポジトリルートからの相対パス）。package.json の deploy:* の --filter と同じ集合。 */
export function findTargets(root: string): string[] {
  const appsDir = join(root, "apps");
  const apps = existsSync(appsDir)
    ? readdirSync(appsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(appsDir, d.name, "package.json")))
        .map((d) => `apps/${d.name}/wrangler.jsonc`)
        .toSorted()
    : [];
  return [...apps, "packages/data-api/wrangler.jsonc"];
}

export interface CliIo {
  /** リポジトリルート */
  root: string;
  out: (line: string) => void;
  err: (line: string) => void;
  readStdin: () => string;
  /** `terraform output -json bindings` を cwd で実行し stdout を返す */
  terraformOutput: (cwd: string) => string;
}

const USAGE = `usage: pnpm infra:sync --env <${ENVS.join("|")}> [--check] [--bindings <file|->]

  --env <env>        同期する環境。wrangler.jsonc の env.<env> を書き換える
  --check            書き込まない。乖離が無ければ exit ${EXIT_OK}、あれば exit ${EXIT_DRIFT}
  --bindings <file>  terraform を呼ばず、bindings の JSON をファイルから読む（- なら stdin）

既定の入力は infra/terraform/envs/<env>/ での terraform output -json bindings。
失敗は exit ${EXIT_ERROR}。値は一切表示しない。`;

export function runCli(argv: readonly string[], io: CliIo): number {
  try {
    return run(argv, io);
  } catch (e) {
    if (e instanceof SyncError) {
      io.err(`infra:sync: ${e.message}`);
    } else {
      // 想定外の例外の文言には何が入るか保証できない。種別だけ出す。
      const kind = e instanceof Error ? e.name : typeof e;
      const code = (e as { code?: unknown }).code;
      io.err(`infra:sync: 予期しない失敗（${kind}${typeof code === "string" ? ` ${code}` : ""}）`);
    }
    return EXIT_ERROR;
  }
}

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        env: { type: "string" },
        check: { type: "boolean" },
        bindings: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    throw new SyncError(`引数が不正: ${(e as Error).message}\n${USAGE}`);
  }
}

function run(argv: readonly string[], io: CliIo): number {
  const values = parseCliArgs(argv);
  if (values.help === true) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (values.env === undefined) throw new SyncError(`--env が無い\n${USAGE}`);
  const env = values.env;
  if (!isEnv(env)) throw new SyncError(`未知の env: ${JSON.stringify(env)}（${ENVS.join(" / ")} のいずれか）`);
  const check = values.check === true;

  // terraform を呼ぶ前に同期先を確かめる。資格情報が無くても分かることを先に報せる。
  const targets = findTargets(io.root);
  const absent = targets.filter((t) => !existsSync(join(io.root, t)));
  if (absent.length > 0) throw new SyncError(`同期先が無い: ${absent.join(", ")}`);

  const bindings = parseBindings(readBindingsText(values.bindings, env, io));

  // 全ファイルを計算し終えてから書く。途中の1件が失敗しても、書きかけの状態を残さない。
  const results = targets.map((target) => {
    const text = readFileSync(join(io.root, target), "utf8");
    try {
      return { target, ...syncBindings(bindings, text, { env }) };
    } catch (e) {
      if (e instanceof SyncError) throw new SyncError(`${target}: ${e.message}`);
      throw e;
    }
  });
  const changed = results.filter((r) => r.changed);
  const keys = changed.reduce((n, r) => n + r.updated.length, 0);

  if (check) {
    if (changed.length === 0) {
      io.out(`OK  ${targets.length} ファイルが terraform output（env=${env}）と一致`);
      return EXIT_OK;
    }
    for (const r of changed) io.out(`NG  ${r.target}: ${r.updated.join(", ")}`);
    io.out(`乖離 ${keys} キー / ${changed.length} ファイル。pnpm infra:sync --env ${env} で書き戻す`);
    return EXIT_DRIFT;
  }

  for (const r of results) {
    if (r.changed) {
      writeFileSync(join(io.root, r.target), r.text);
      io.out(`更新      ${r.target}: ${r.updated.join(", ")}`);
    } else {
      io.out(`変更なし  ${r.target}`);
    }
  }
  io.out(`${keys} キー / ${changed.length} ファイルを書き戻した（env=${env}）`);
  return EXIT_OK;
}

function readBindingsText(source: string | undefined, env: Env, io: CliIo): string {
  if (source === "-") return io.readStdin();
  if (source !== undefined) {
    try {
      return readFileSync(resolve(source), "utf8");
    } catch {
      throw new SyncError("bindings が読めない: --bindings のファイルを開けない");
    }
  }
  const dir = `infra/terraform/envs/${env}`;
  const cwd = join(io.root, dir);
  if (!existsSync(cwd)) throw new SyncError(`bindings が読めない: ${dir} が無い`);
  try {
    return io.terraformOutput(cwd);
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") throw new SyncError("bindings が読めない: terraform が見つからない");
    // stderr は出さない（backend の endpoint URL がアカウント ID を含む）。
    throw new SyncError(
      `bindings が読めない: ${dir} で terraform output -json bindings が失敗した` +
        "（init 済みか・資格情報を読み込んだか。詳細はそのディレクトリで直接実行して確かめる）",
    );
  }
}

const defaultIo: CliIo = {
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  readStdin: () => readFileSync(0, "utf8"),
  terraformOutput: (cwd) =>
    execFileSync("terraform", ["output", "-json", "bindings"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
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
  process.exitCode = runCli(process.argv.slice(2), defaultIo);
}
