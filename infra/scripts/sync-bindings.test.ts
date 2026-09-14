// infra:sync の単体テスト。実 terraform には依存せず、fixture の bindings JSON を入力にする。
//
// fixture の値は全部作り物で、しかも他と衝突しない目印にしてある。
// 出力やエラー文言に目印が1つでも混ざったら「値を出した」と判定する（bindings は sensitive）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENVS,
  EXIT_DRIFT,
  EXIT_ERROR,
  EXIT_OK,
  findTargets,
  parseBindings,
  runCli,
  SyncError,
  syncBindings,
  type Bindings,
  type CliIo,
} from "./sync-bindings.ts";

const STAGING: Bindings = {
  env: "staging",
  account_id: "fixture-account-9d41c7",
  d1_control_id: "fixture-d1-id-5b2e80",
  d1_control_name: "fixture-d1-name-a17c3f",
  r2_bundles_name: "fixture-bundles-3e9d02",
  r2_uploads_name: "fixture-uploads-c4f615",
  queue_build_name: "fixture-queue-7a0b58",
  wfp_namespace_name: null,
  turnstile_sitekey: null,
};

const SECRET_MARKERS = [
  STAGING.account_id,
  STAGING.d1_control_id,
  STAGING.d1_control_name,
  STAGING.r2_bundles_name,
  STAGING.r2_uploads_name,
  STAGING.queue_build_name,
  "fixture-wfp-1f6e2d",
  "fixture-sitekey-0c8b47",
];

function expectNoValues(text: string): void {
  for (const marker of SECRET_MARKERS) expect(text).not.toContain(marker);
}

/** 投げられた SyncError の文言を返す。値が混ざっていないことも同時に確かめる。 */
function syncErrorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    const message = (e as Error).message;
    expectNoValues(message);
    return message;
  }
  throw new Error("SyncError が投げられなかった");
}

// data-api の形（03 §2）。env ごとに古い値を変えてあり、置換がどの env に効いたかを文字列で判定できる。
const DATA_API = `{
  // ★唯一の権限強制点。外部ルートを持たない
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "musubi-dev-data-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-11", // 着手時に固定
  "workers_dev": false,

  /* トップレベルは同期しない */
  "d1_databases": [{ "binding": "CONTROL_DB", "database_name": "top-name", "database_id": "top-id" }],

  "env": {
    "dev": {
      "name": "musubi-dev-data-api",
      "d1_databases": [
        { "binding": "CONTROL_DB", "database_name": "dev-old-name", "database_id": "dev-old-id" }
      ]
    },
    "staging": {
      "name": "musubi-staging-data-api",
      // D1 の database_id は destroy → apply で変わる。手で直さない
      "d1_databases": [
        {
          "binding": "CONTROL_DB",
          "database_name": "staging-old-name", // Terraform 由来
          "database_id": "<TF_OUTPUT>" /* 03 §3 */
        }
      ],
      "r2_buckets": [
        { "binding": "BUNDLES", "bucket_name": "staging-old-bundles" },
        { "binding": "UPLOADS", "bucket_name": "staging-old-uploads" },
      ],
      "queues": {
        "producers": [{ "binding": "BUILD_QUEUE", "queue": "staging-old-queue" }]
      },
      "durable_objects": { "bindings": [{ "name": "APP_DO", "class_name": "AppInstanceDO" }] }
    },
    "production": {
      "name": "musubi-production-data-api",
      "d1_databases": [
        { "binding": "CONTROL_DB", "database_name": "production-old-name", "database_id": "production-old-id" }
      ]
    }
  }
}
`;

const DATA_API_STAGING_SYNCED = DATA_API.replace('"staging-old-name"', `"${STAGING.d1_control_name}"`)
  .replace('"<TF_OUTPUT>"', `"${STAGING.d1_control_id}"`)
  .replace('"staging-old-bundles"', `"${STAGING.r2_bundles_name}"`)
  .replace('"staging-old-uploads"', `"${STAGING.r2_uploads_name}"`)
  .replace('"staging-old-queue"', `"${STAGING.queue_build_name}"`);

// gateway の形（03 §2）。Terraform 由来の欄を持たない。
const GATEWAY = `{
  "name": "musubi-dev-gateway",
  "main": "src/index.ts",
  "env": {
    "dev": { "services": [{ "binding": "DATA_API", "service": "musubi-dev-data-api" }] },
    "staging": { "services": [{ "binding": "DATA_API", "service": "musubi-staging-data-api" }] },
    "production": { "services": [{ "binding": "DATA_API", "service": "musubi-production-data-api" }] }
  }
}
`;

const stagingWith = (body: string): string => `{\n  "env": {\n    "staging": ${body}\n  }\n}\n`;

describe("parseBindings", () => {
  it("terraform output -json bindings の形を読む", () => {
    expect(parseBindings(JSON.stringify(STAGING))).toEqual(STAGING);
  });

  it("wfp_namespace_name / turnstile_sitekey は文字列も受け付ける", () => {
    const json = JSON.stringify({ ...STAGING, wfp_namespace_name: "fixture-wfp-1f6e2d", turnstile_sitekey: "fixture-sitekey-0c8b47" });
    expect(parseBindings(json).wfp_namespace_name).toBe("fixture-wfp-1f6e2d");
  });

  it("不正な JSON は失敗し、入力の断片を文言に出さない", () => {
    const broken = JSON.stringify(STAGING).slice(0, -12);
    expect(syncErrorOf(() => parseBindings(broken))).toContain("JSON として解釈できない");
  });

  it.each([
    ["配列", "[]"],
    ["null", "null"],
    ["文字列", JSON.stringify(STAGING.account_id)],
  ])("オブジェクトでない JSON（%s）は失敗する", (_, json) => {
    expect(syncErrorOf(() => parseBindings(json))).toContain("JSON オブジェクトではない");
  });

  it("キーが足りなければ、足りないキー名を示して失敗する", () => {
    const { d1_control_id: _, ...rest } = STAGING;
    expect(syncErrorOf(() => parseBindings(JSON.stringify(rest)))).toContain("d1_control_id");
  });

  it("outputs.tf に無いキーがあれば失敗する（terraform output -json 全体を渡した場合も）", () => {
    expect(syncErrorOf(() => parseBindings(JSON.stringify({ ...STAGING, kv_id: "x" })))).toContain("kv_id");
    const whole = JSON.stringify({ bindings: { sensitive: true, type: [], value: STAGING } });
    expect(syncErrorOf(() => parseBindings(whole))).toContain("キーが足りない");
  });

  it("未知の env は値を出さずに失敗する", () => {
    const json = JSON.stringify({ ...STAGING, env: "fixture-wfp-1f6e2d" });
    expect(syncErrorOf(() => parseBindings(json))).toContain("env が dev / staging / production のいずれでもない");
  });

  it.each([
    ["数値", 42],
    ["空文字", ""],
    ["null", null],
  ])("必須の値が %s なら失敗する", (_, value) => {
    const json = JSON.stringify({ ...STAGING, d1_control_id: value });
    expect(syncErrorOf(() => parseBindings(json))).toContain("d1_control_id");
  });

  it("null 可のキーに空文字が来たら失敗する", () => {
    const json = JSON.stringify({ ...STAGING, wfp_namespace_name: "" });
    expect(syncErrorOf(() => parseBindings(json))).toContain("wfp_namespace_name");
  });
});

describe("syncBindings", () => {
  it("該当 env の D1 / R2 / Queue の欄だけを書き換え、コメントと書式を保つ", () => {
    const result = syncBindings(STAGING, DATA_API, { env: "staging" });

    // 期待値は「元のテキストの該当トークンだけを置換したもの」。これと完全一致するので、
    // コメント・空行・字下げ・末尾カンマ・トップレベル・他 env は1文字も変わっていない。
    expect(result.text).toBe(DATA_API_STAGING_SYNCED);
    expect(result.changed).toBe(true);
    expect(result.updated).toEqual([
      "env.staging.d1_databases[CONTROL_DB].database_id",
      "env.staging.d1_databases[CONTROL_DB].database_name",
      "env.staging.r2_buckets[BUNDLES].bucket_name",
      "env.staging.r2_buckets[UPLOADS].bucket_name",
      "env.staging.queues.producers[BUILD_QUEUE].queue",
    ]);
  });

  it("2回続けて実行しても差分が出ない（冪等）", () => {
    const first = syncBindings(STAGING, DATA_API, { env: "staging" });
    const second = syncBindings(STAGING, first.text, { env: "staging" });
    expect(second).toEqual({ text: first.text, changed: false, updated: [] });
  });

  it("bindings を変えると、変えた値の欄だけが書き換わる", () => {
    const recreated: Bindings = { ...STAGING, d1_control_id: "fixture-d1-id-recreated" };
    const result = syncBindings(recreated, DATA_API_STAGING_SYNCED, { env: "staging" });
    expect(result.updated).toEqual(["env.staging.d1_databases[CONTROL_DB].database_id"]);
    expect(result.text).toBe(DATA_API_STAGING_SYNCED.replace(STAGING.d1_control_id, "fixture-d1-id-recreated"));
  });

  it("欄が無ければ足さずに失敗する（構造は人が書く。足すと周りの書式を崩す）", () => {
    const text = stagingWith(`{ "d1_databases": [{ "binding": "CONTROL_DB", "database_name": "x" }] }`);
    expect(syncErrorOf(() => syncBindings(STAGING, text, { env: "staging" }))).toContain(
      "同期先が無い: env.staging.d1_databases[CONTROL_DB].database_id の欄が無い",
    );
  });

  it("1行に詰めた要素でも、値のトークン以外は1文字も変えない", () => {
    const text = stagingWith(`{ "d1_databases": [{"binding":"CONTROL_DB","database_id":"old",/*x*/"database_name":"old"}] }`);
    const result = syncBindings(STAGING, text, { env: "staging" });
    expect(result.text).toBe(
      text.replace('"database_id":"old"', `"database_id":"${STAGING.d1_control_id}"`)
        .replace('"database_name":"old"', `"database_name":"${STAGING.d1_control_name}"`),
    );
    expect(parse(result.text).env.staging.d1_databases[0]).toEqual({
      binding: "CONTROL_DB",
      database_id: STAGING.d1_control_id,
      database_name: STAGING.d1_control_name,
    });
  });

  it("文字列でない値（数値など）も書き換える", () => {
    const text = stagingWith(`{ "r2_buckets": [{ "binding": "BUNDLES", "bucket_name": 1 }] }`);
    const result = syncBindings(STAGING, text, { env: "staging" });
    expect(result.updated).toEqual(["env.staging.r2_buckets[BUNDLES].bucket_name"]);
    expect(parse(result.text).env.staging.r2_buckets[0].bucket_name).toBe(STAGING.r2_bundles_name);
  });

  it("CRLF のファイルでも改行コードを変えない", () => {
    const text = DATA_API.replaceAll("\n", "\r\n");
    expect(syncBindings(STAGING, text, { env: "staging" }).text).toBe(DATA_API_STAGING_SYNCED.replaceAll("\n", "\r\n"));
  });

  it("既に一致していれば changed は false で、入力をそのまま返す", () => {
    const result = syncBindings(STAGING, DATA_API_STAGING_SYNCED, { env: "staging" });
    expect(result).toEqual({ text: DATA_API_STAGING_SYNCED, changed: false, updated: [] });
  });

  it("Terraform 由来の欄を持たない Worker（gateway）は変えない", () => {
    expect(syncBindings(STAGING, GATEWAY, { env: "staging" })).toEqual({ text: GATEWAY, changed: false, updated: [] });
  });

  it("wfp_namespace_name / turnstile_sitekey が null でも、参照が無ければ失敗しない", () => {
    expect(STAGING.wfp_namespace_name).toBeNull();
    expect(STAGING.turnstile_sitekey).toBeNull();
    expect(syncBindings(STAGING, DATA_API, { env: "staging" }).changed).toBe(true);
    const emptyDispatch = stagingWith(`{ "dispatch_namespaces": [] }`);
    expect(syncBindings(STAGING, emptyDispatch, { env: "staging" }).changed).toBe(false);
  });

  it("wfp_namespace_name が null なのに wrangler が参照していれば失敗する", () => {
    const text = stagingWith(`{ "dispatch_namespaces": [{ "binding": "DISPATCHER", "namespace": "x" }] }`);
    expect(syncErrorOf(() => syncBindings(STAGING, text, { env: "staging" }))).toContain(
      "資源が Terraform に無い（wfp_namespace_name が null）",
    );
  });

  it("wfp_namespace_name が入れば dispatch_namespaces に書き戻す", () => {
    const text = stagingWith(`{ "dispatch_namespaces": [{ "binding": "DISPATCHER", "namespace": "x" }] }`);
    const result = syncBindings({ ...STAGING, wfp_namespace_name: "fixture-wfp-1f6e2d" }, text, { env: "staging" });
    expect(result.updated).toEqual(["env.staging.dispatch_namespaces[DISPATCHER].namespace"]);
    expect(result.text).toContain('"namespace": "fixture-wfp-1f6e2d"');
  });

  it("turnstile_sitekey が null 以外なら、置き場が未定なので失敗する", () => {
    const bindings = { ...STAGING, turnstile_sitekey: "fixture-sitekey-0c8b47" };
    expect(syncErrorOf(() => syncBindings(bindings, DATA_API, { env: "staging" }))).toContain("turnstile_sitekey");
  });

  it("account_id はどこにも書かない", () => {
    expect(syncBindings(STAGING, DATA_API, { env: "staging" }).text).not.toContain(STAGING.account_id);
  });

  it("同期先の env ブロックが無ければ失敗する", () => {
    expect(syncErrorOf(() => syncBindings({ ...STAGING, env: "dev" }, stagingWith("{}"), { env: "dev" }))).toContain(
      "同期先が無い: env.dev が無い",
    );
  });

  it("bindings の env と --env が食い違えば失敗する", () => {
    expect(syncErrorOf(() => syncBindings(STAGING, DATA_API, { env: "production" }))).toContain("一致しない");
  });

  it("Terraform の bindings に対応しない binding があれば失敗する", () => {
    const text = stagingWith(`{ "r2_buckets": [{ "binding": "BUNDLE", "bucket_name": "x" }] }`);
    expect(syncErrorOf(() => syncBindings(STAGING, text, { env: "staging" }))).toContain(
      "env.staging.r2_buckets[BUNDLE] は Terraform の bindings に対応しない",
    );
  });

  it.each([
    ["kv_namespaces", `{ "kv_namespaces": [{ "binding": "KV", "id": "x" }] }`],
    ["queues.consumers", `{ "queues": { "consumers": [{ "queue": "x" }] } }`],
  ])("%s は同期できないので失敗する", (path, body) => {
    expect(syncErrorOf(() => syncBindings(STAGING, stagingWith(body), { env: "staging" }))).toContain(
      `env.staging.${path} は扱えない`,
    );
  });

  it.each([
    ["壊れた JSONC", `{ "env": { "staging": { "d1_databases": [ } } }`, "JSONC が壊れている"],
    ["トップレベルが配列", "[]", "トップレベルがオブジェクトではない"],
    ["env.staging が配列", `{ "env": { "staging": [] } }`, "env.staging がオブジェクトではない"],
    ["d1_databases が配列でない", stagingWith(`{ "d1_databases": {} }`), "d1_databases が配列ではない"],
    ["binding が無い要素", stagingWith(`{ "d1_databases": [{ "database_id": "x" }] }`), "文字列の binding が無い"],
    ["要素がオブジェクトでない", stagingWith(`{ "r2_buckets": ["BUNDLES"] }`), "r2_buckets[0] に文字列の binding が無い"],
  ])("%s は失敗する", (_, text, expected) => {
    expect(syncErrorOf(() => syncBindings(STAGING, text, { env: "staging" }))).toContain(expected);
  });
});

describe("packages/data-api/wrangler.jsonc（実物）", () => {
  // `--check` は binding の欠落を検出しない（gateway / host を正当に扱うための仕様）。
  // data-api が CONTROL_DB / BUNDLES / UPLOADS を書き忘れても infra:sync は黙って通るので、
  // 実物に fixture の bindings を当て、欄が全部書き換わること＝全部そこにあることをここで落とす（Issue #6）。
  const text = readFileSync(fileURLToPath(new URL("../../packages/data-api/wrangler.jsonc", import.meta.url)), "utf8");

  it.each(["dev", "staging", "production"] as const)("env.%s に Terraform 由来の binding が全部あり、同期できる", (env) => {
    const result = syncBindings({ ...STAGING, env }, text, { env });
    expect(result.updated).toEqual(
      expect.arrayContaining([
        `env.${env}.d1_databases[CONTROL_DB].database_id`,
        `env.${env}.d1_databases[CONTROL_DB].database_name`,
        `env.${env}.r2_buckets[BUNDLES].bucket_name`,
        `env.${env}.r2_buckets[UPLOADS].bucket_name`,
      ]),
    );
    // 書き換えたのはその env のブロックだけ。account_id はどこにも書かない。
    expect(result.text).not.toContain(STAGING.account_id);
    for (const other of ["dev", "staging", "production"].filter((e) => e !== env)) {
      expect(parse(result.text).env[other]).toEqual(parse(text).env[other]);
    }
  });
});

describe.each(["gateway", "host"])("apps/%s/wrangler.jsonc（実物）", (app) => {
  // gateway と host は Terraform 由来の binding を1つも持たない（Issue #8 / #9・CLAUDE.md 不変条件）。持つのは
  // Service Binding（gateway → data-api、host → gateway）だけで、それは Terraform の管理外。data-api と逆向きの穴——
  // D1 / R2 / Queue を書き足しても名前が表の binding と一致すれば infra:sync は黙って同期してしまう——を、
  // 実物に fixture の bindings を当てて塞ぐ。
  const text = readFileSync(fileURLToPath(new URL(`../../apps/${app}/wrangler.jsonc`, import.meta.url)), "utf8");

  it.each(ENVS)("env.%s があり、同期しても1文字も変わらない", (env) => {
    expect(syncBindings({ ...STAGING, env }, text, { env })).toEqual({ text, changed: false, updated: [] });
  });

  it("Terraform 由来の binding の欄を、トップレベルにもどの env にも持たない", () => {
    const config = parse(text);
    for (const [where, block] of [["トップレベル", config], ...ENVS.map((env) => [`env.${env}`, config.env[env]])]) {
      for (const key of ["d1_databases", "r2_buckets", "queues", "kv_namespaces", "dispatch_namespaces"]) {
        expect(block, `${where}.${key}`).not.toHaveProperty(key);
      }
    }
  });

  it("Account ID を書いていない（public リポジトリ）：account_id の欄も、32桁の16進も無い", () => {
    const config = parse(text);
    for (const block of [config, ...ENVS.map((env) => config.env[env])]) expect(block).not.toHaveProperty("account_id");
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/i);
  });
});

describe("runCli", () => {
  let root: string;
  let out: string[];
  let err: string[];
  let terraformCalls: string[];
  let io: CliIo;
  const PAST = new Date("2020-01-01T00:00:00Z");

  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    utimesSync(join(root, rel), PAST, PAST);
  };
  const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
  const untouched = (rel: string): boolean => statSync(join(root, rel)).mtimeMs === PAST.getTime();
  const printed = (): string => [...out, ...err].join("\n");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sync-bindings-"));
    write("apps/gateway/package.json", "{}");
    write("apps/gateway/wrangler.jsonc", GATEWAY);
    write("apps/host/package.json", "{}");
    write("apps/host/wrangler.jsonc", GATEWAY.replaceAll("gateway", "host"));
    mkdirSync(join(root, "apps/not-a-package"));
    write("packages/data-api/wrangler.jsonc", DATA_API);
    write("packages/app-do/wrangler.jsonc", "{ this is not a sync target }");
    write("bindings.json", JSON.stringify(STAGING));
    mkdirSync(join(root, "infra/terraform/envs/staging"), { recursive: true });

    out = [];
    err = [];
    terraformCalls = [];
    io = {
      root,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      readStdin: () => JSON.stringify(STAGING),
      terraformOutput: (cwd) => {
        terraformCalls.push(cwd);
        return JSON.stringify(STAGING);
      },
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("同期先は apps/ 直下のパッケージと data-api。app-do（配備しない dev ハーネス）は含まない", () => {
    expect(findTargets(root)).toEqual([
      "apps/gateway/wrangler.jsonc",
      "apps/host/wrangler.jsonc",
      "packages/data-api/wrangler.jsonc",
    ]);
  });

  it("既定では infra/terraform/envs/<env> で terraform output を読み、差分のあるファイルだけを書く", () => {
    expect(runCli(["--env", "staging"], io)).toBe(EXIT_OK);

    expect(terraformCalls).toEqual([join(root, "infra/terraform/envs/staging")]);
    expect(read("packages/data-api/wrangler.jsonc")).toBe(DATA_API_STAGING_SYNCED);
    expect(untouched("apps/gateway/wrangler.jsonc")).toBe(true);
    expect(untouched("apps/host/wrangler.jsonc")).toBe(true);
    expect(untouched("packages/app-do/wrangler.jsonc")).toBe(true);
    expect(out).toContain(
      "更新      packages/data-api/wrangler.jsonc: env.staging.d1_databases[CONTROL_DB].database_id, env.staging.d1_databases[CONTROL_DB].database_name, env.staging.r2_buckets[BUNDLES].bucket_name, env.staging.r2_buckets[UPLOADS].bucket_name, env.staging.queues.producers[BUILD_QUEUE].queue",
    );
    expect(out.at(-1)).toBe("5 キー / 1 ファイルを書き戻した（env=staging）");
    expect(err).toEqual([]);
    expectNoValues(printed());
  });

  it("2回目は何も書かない（冪等）", () => {
    expect(runCli(["--env", "staging"], io)).toBe(EXIT_OK);
    const synced = read("packages/data-api/wrangler.jsonc");
    utimesSync(join(root, "packages/data-api/wrangler.jsonc"), PAST, PAST);
    out = [];

    expect(runCli(["--env", "staging"], io)).toBe(EXIT_OK);
    expect(read("packages/data-api/wrangler.jsonc")).toBe(synced);
    expect(untouched("packages/data-api/wrangler.jsonc")).toBe(true);
    expect(out.at(-1)).toBe("0 キー / 0 ファイルを書き戻した（env=staging）");
  });

  it("--check：乖離があれば書かずに非ゼロで終わり、乖離したファイルと欄を列挙する（値は出さない）", () => {
    expect(runCli(["--env", "staging", "--check", "--bindings", join(root, "bindings.json")], io)).toBe(EXIT_DRIFT);

    expect(read("packages/data-api/wrangler.jsonc")).toBe(DATA_API);
    for (const t of findTargets(root)) expect(untouched(t)).toBe(true);
    expect(out[0]).toMatch(/^NG {2}packages\/data-api\/wrangler\.jsonc: env\.staging\.d1_databases\[CONTROL_DB\]\.database_id/);
    expect(out.at(-1)).toBe("乖離 5 キー / 1 ファイル。pnpm infra:sync --env staging で書き戻す");
    expect(terraformCalls).toEqual([]);
    expectNoValues(printed());
  });

  it("--check：乖離が無ければ exit 0", () => {
    write("packages/data-api/wrangler.jsonc", DATA_API_STAGING_SYNCED);
    expect(runCli(["--env", "staging", "--check"], io)).toBe(EXIT_OK);
    expect(out).toEqual(["OK  3 ファイルが terraform output（env=staging）と一致"]);
    for (const t of findTargets(root)) expect(untouched(t)).toBe(true);
  });

  it("--bindings - で stdin から読む", () => {
    expect(runCli(["--env=staging", "--check", "--bindings", "-"], io)).toBe(EXIT_DRIFT);
    expect(terraformCalls).toEqual([]);
  });

  it("未知の env は terraform を呼ぶ前に失敗する", () => {
    expect(runCli(["--env", "prod"], io)).toBe(EXIT_ERROR);
    expect(err).toEqual(['infra:sync: 未知の env: "prod"（dev / staging / production のいずれか）']);
    expect(terraformCalls).toEqual([]);
  });

  it.each([
    ["--env が無い", ["--check"], "--env が無い"],
    ["未知の引数", ["--env", "staging", "--force"], "引数が不正"],
    ["位置引数", ["staging"], "引数が不正"],
  ])("%s は失敗する", (_, argv, expected) => {
    expect(runCli(argv, io)).toBe(EXIT_ERROR);
    expect(err[0]).toContain(expected);
  });

  it("同期先が無ければ、どれが無いかを示し、1ファイルも書かずに失敗する", () => {
    rmSync(join(root, "apps/host/wrangler.jsonc"));
    expect(runCli(["--env", "staging"], io)).toBe(EXIT_ERROR);
    expect(err).toEqual(["infra:sync: 同期先が無い: apps/host/wrangler.jsonc"]);
    expect(read("packages/data-api/wrangler.jsonc")).toBe(DATA_API);
    expect(terraformCalls).toEqual([]);
  });

  it("途中のファイルで失敗したら、前のファイルも書かない", () => {
    // 並びは apps/gateway → apps/host → packages/data-api。gateway と data-api は差分ありにしておき、
    // 間の host で失敗させる。どちらも書かれていないことを見る。
    write("apps/gateway/wrangler.jsonc", stagingWith(`{ "r2_buckets": [{ "binding": "BUNDLES", "bucket_name": "x" }] }`));
    write("apps/host/wrangler.jsonc", stagingWith(`{ "d1_databases": [{ "binding": "OTHER_DB" }] }`));
    expect(runCli(["--env", "staging"], io)).toBe(EXIT_ERROR);
    expect(err[0]).toContain("apps/host/wrangler.jsonc: env.staging.d1_databases[OTHER_DB]");
    for (const t of findTargets(root)) expect(untouched(t)).toBe(true);
  });

  it("bindings が不正な JSON なら値を出さずに失敗する", () => {
    write("bindings.json", JSON.stringify(STAGING).slice(0, -20));
    expect(runCli(["--env", "staging", "--bindings", join(root, "bindings.json")], io)).toBe(EXIT_ERROR);
    expect(err).toEqual(["infra:sync: bindings が読めない: JSON として解釈できない"]);
    expectNoValues(printed());
  });

  it("--bindings のファイルが無ければ失敗する", () => {
    expect(runCli(["--env", "staging", "--bindings", join(root, "missing.json")], io)).toBe(EXIT_ERROR);
    expect(err[0]).toContain("--bindings のファイルを開けない");
  });

  it("terraform が失敗しても stderr（アカウント ID を含み得る）を出さない", () => {
    io.terraformOutput = () => {
      throw Object.assign(new Error(`Command failed: https://${STAGING.account_id}.r2.example`), { status: 1 });
    };
    expect(runCli(["--env", "staging"], io)).toBe(EXIT_ERROR);
    expect(err[0]).toContain("infra/terraform/envs/staging で terraform output -json bindings が失敗した");
    expectNoValues(printed());
  });

  it("terraform が入っていなければそう示す", () => {
    io.terraformOutput = () => {
      throw Object.assign(new Error("spawnSync terraform ENOENT"), { code: "ENOENT" });
    };
    expect(runCli(["--env", "staging"], io)).toBe(EXIT_ERROR);
    expect(err).toEqual(["infra:sync: bindings が読めない: terraform が見つからない"]);
  });

  it("別環境の bindings を渡すと失敗する", () => {
    mkdirSync(join(root, "infra/terraform/envs/production"), { recursive: true });
    expect(runCli(["--env", "production"], io)).toBe(EXIT_ERROR);
    expect(err[0]).toContain("bindings の env が --env production と一致しない");
  });
});

describe("CLI の入口", () => {
  it("tsx で直接起動すると main が走る（pnpm infra:sync の経路）", () => {
    const script = fileURLToPath(new URL("./sync-bindings.ts", import.meta.url));
    const stdout = execFileSync(process.execPath, ["--import", "tsx", script, "--help"], { encoding: "utf8" });
    expect(stdout).toContain("usage: pnpm infra:sync --env <dev|staging|production>");
  });
});
