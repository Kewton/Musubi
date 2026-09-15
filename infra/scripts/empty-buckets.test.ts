// infra:empty-buckets の試験（Issue #67）。**実環境には一切届かない**（Cloudflare の API は、メモリの中の偽の R2 に差し替える）。
//
//   1. 契約：消すバケットの binding と名前が、data-api の wrangler.jsonc・Terraform のモジュールと一致する。package.json の入口
//   2. 消す先を読む：env.dev の BUNDLES・UPLOADS だけ。知らない binding・足りない binding・dev でない名前なら1つも消さない
//   3. 資格情報・API の形：production のアカウントなら止める。キーの経路（段ごとのエンコード・. と .. の拒否）。一覧の応答の読み方
//   4. CLI：dev 以外は API を呼ばない。偽の R2 を空になるまで消し、空の一覧を読んで終わる。--dry-run は消さない。
//      出力にキー・トークン・Account ID が無い。権限・レート制限・消えない・多すぎる・届かない は止める
//
// fixture の値は全部作り物で、他と衝突しない目印にしてある。出力に目印が1つでも混ざったら「伏せ損ねた」と判定する。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  BUCKET_CONFIG,
  BUCKETS,
  describeErrors,
  EmptyError,
  EMPTYABLE_ENVS,
  EXIT_NG,
  EXIT_OK,
  MAX_DELETIONS,
  objectPath,
  parsePage,
  readBuckets,
  readCredentials,
  runCli,
  type CliIo,
} from "./empty-buckets.ts";
import { ENVS } from "./sync-bindings.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 目印。Account ID（32 桁の 16 進）とトークンの代わり */
const ACCOUNT_ID = "7e3f0a9c1b2d4e5f60718293a4b5c6d7";
const PROD_ACCOUNT_ID = "0d9c8b7a6f5e4d3c2b1a09f8e7d6c5b4";
const TOKEN = "fixture-r2-token-4b8e1d7a";
/** 目印。利用者のファイル名になりうるキー */
const USER_KEY = "uploads/fixture-user-file-9d3a/写真 1.png";
const ODD_KEY = "bundles/app?v=2#top/100%/index.js";
const PROBE_KEY = "_probe/healthz";
const MARKERS = [ACCOUNT_ID, TOKEN, "fixture-user-file-9d3a", "app?v=2", PROBE_KEY];

const DEV_BUCKETS = { BUNDLES: "musunest-dev-bundles", UPLOADS: "musunest-dev-uploads" };

function expectNothingSecret(text: string): void {
  for (const marker of MARKERS) expect(text).not.toContain(marker);
  expect(text).not.toMatch(/\b[0-9a-f]{32}\b/i);
}

function emptyErrorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EmptyError);
    return (e as Error).message;
  }
  throw new Error("EmptyError が投げられなかった");
}

/** data-api の wrangler.jsonc の形で、env.dev の r2_buckets だけを持つテキスト */
const configWith = (buckets: readonly unknown[], env = "dev"): string =>
  JSON.stringify({ env: { [env]: { name: `musunest-${env}-data-api`, r2_buckets: buckets } } }, null, 2);

// ── 1. 契約 ────────────────────────────────────────────────────────────────

describe("契約：消すバケットと入口", () => {
  it("package.json の infra:empty-buckets はこのスクリプトを指す", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["infra:empty-buckets"]).toBe("tsx infra/scripts/empty-buckets.ts");
  });

  it("消してよい env は dev だけ", () => {
    expect(EMPTYABLE_ENVS).toEqual(["dev"]);
  });

  it("data-api の wrangler.jsonc の env.dev から、BUNDLES と UPLOADS の dev のバケットを読む", () => {
    const text = readFileSync(join(ROOT, BUCKET_CONFIG), "utf8");
    expect(readBuckets(text, "dev")).toEqual([
      { binding: "BUNDLES", name: DEV_BUCKETS.BUNDLES },
      { binding: "UPLOADS", name: DEV_BUCKETS.UPLOADS },
    ]);
  });

  it("BUCKETS の binding と名前の末尾は、Terraform のモジュールの R2 バケット（${local.p}-<末尾>）と過不足なく一致する", () => {
    const main = readFileSync(join(ROOT, "infra/terraform/modules/musunest-env/main.tf"), "utf8");
    const resources = [...main.matchAll(/resource "cloudflare_r2_bucket" "(\w+)" \{[^}]*?name\s*=\s*"\$\{local\.p\}-([a-z0-9-]+)"/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(resources.map(([resource, suffix]) => `${resource}=${suffix}`).toSorted()).toEqual(
      Object.values(BUCKETS)
        .map((suffix) => `${suffix}=${suffix}`)
        .toSorted(),
    );
    expect(main).toMatch(/p = "\$\{var\.name_prefix\}-\$\{var\.env\}"/);
  });

  it("data-api の R2 の binding は、全 env で BUCKETS と同じ集合（sync-bindings の同期先と同じ欄を読む）", () => {
    const config = parse(readFileSync(join(ROOT, BUCKET_CONFIG), "utf8")) as { env: Record<string, { r2_buckets: { binding: string }[] }> };
    for (const env of ENVS) {
      expect(config.env[env]?.r2_buckets.map((b) => b.binding).toSorted(), env).toEqual(Object.keys(BUCKETS).toSorted());
    }
  });

  it("data-api の /healthz は BUNDLES に probe のオブジェクトを書く（だから smoke を通した dev は空ではない）", () => {
    const adapter = readFileSync(join(ROOT, "packages/data-api/src/cloudflare.ts"), "utf8");
    expect(adapter).toContain(`export const PROBE_OBJECT_KEY = "${PROBE_KEY}";`);
    expect(adapter).toMatch(/env\.BUNDLES\.put\(PROBE_OBJECT_KEY/);
  });
});

// ── 2. 消す先を読む ─────────────────────────────────────────────────────────────

describe("readBuckets：消す先を読む", () => {
  const bundles = { binding: "BUNDLES", bucket_name: "musunest-dev-bundles" };
  const uploads = { binding: "UPLOADS", bucket_name: "musunest-dev-uploads" };

  it("name_prefix が変わっても、<prefix>-dev-<末尾> の形なら読む", () => {
    expect(
      readBuckets(
        configWith([
          { binding: "UPLOADS", bucket_name: "renamed-dev-uploads" },
          { binding: "BUNDLES", bucket_name: "renamed-dev-bundles" },
        ]),
        "dev",
      ),
    ).toEqual([
      { binding: "BUNDLES", name: "renamed-dev-bundles" },
      { binding: "UPLOADS", name: "renamed-dev-uploads" },
    ]);
  });

  it.each([
    ["staging のバケット名", [{ ...bundles, bucket_name: "musunest-staging-bundles" }, uploads], "の形でない。1つも消さない"],
    ["production のバケット名", [bundles, { ...uploads, bucket_name: "musunest-production-uploads" }], "の形でない。1つも消さない"],
    ["binding と名前の末尾の取り違え", [{ ...bundles, bucket_name: "musunest-dev-uploads" }, uploads], "の形でない"],
    ["知らない binding", [bundles, uploads, { binding: "ARCHIVE", bucket_name: "musunest-dev-archive" }], "知らない binding（ARCHIVE）"],
    ["UPLOADS が無い", [bundles], "UPLOADS が無い"],
    ["binding が文字列でない", [{ bucket_name: "musunest-dev-bundles" }, uploads], "文字列の binding と bucket_name が無い"],
  ])("%s なら1つも消さない", (_, buckets, message) => {
    expect(emptyErrorOf(() => readBuckets(configWith(buckets), "dev"))).toContain(message);
  });

  it("env.dev が無い・JSONC が壊れている なら読まない", () => {
    expect(emptyErrorOf(() => readBuckets(configWith([bundles, uploads], "staging"), "dev"))).toContain("env.dev.r2_buckets が無い");
    expect(emptyErrorOf(() => readBuckets('{ "env": { "dev": ', "dev"))).toContain("が壊れている");
  });
});

// ── 3. 資格情報・API の形 ──────────────────────────────────────────────────────

describe("readCredentials：資格情報", () => {
  it("トークンと Account ID を読む", () => {
    expect(readCredentials({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT_ID })).toEqual({
      token: TOKEN,
      accountId: ACCOUNT_ID,
    });
  });

  it.each([
    ["トークンが無い", { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }, "CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る"],
    ["Account ID が空", { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "" }, "CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る"],
    ["Account ID の形でない", { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "fixture-not-hex" }, "Account ID の形"],
    ["トークンに改行", { CLOUDFLARE_API_TOKEN: `${TOKEN}\n`, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }, "ヘッダに載せられない文字"],
    [
      "production のアカウント（大文字でも）",
      { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID.toUpperCase() },
      "production のアカウント",
    ],
  ])("%s なら止める。値は出さない", (_, env, message) => {
    const text = emptyErrorOf(() => readCredentials(env));
    expect(text).toContain(message);
    expectNothingSecret(text);
    expect(text).not.toContain("fixture-not-hex");
  });
});

describe("API の形", () => {
  it("キーの / は段のまま、段ごとに URL エンコードする（wrangler r2 object delete と同じ経路）", () => {
    expect(objectPath(ACCOUNT_ID, "musunest-dev-bundles", PROBE_KEY)).toBe(`/accounts/${ACCOUNT_ID}/r2/buckets/musunest-dev-bundles/objects/_probe/healthz`);
    expect(objectPath(ACCOUNT_ID, "b", ODD_KEY)).toBe(`/accounts/${ACCOUNT_ID}/r2/buckets/b/objects/bundles/app%3Fv%3D2%23top/100%25/index.js`);
    expect(objectPath(ACCOUNT_ID, "b", USER_KEY)).toBe(
      `/accounts/${ACCOUNT_ID}/r2/buckets/b/objects/uploads/fixture-user-file-9d3a/${encodeURIComponent("写真 1.png")}`,
    );
    // % もエンコードするので、キーの文字としての %2e は . の段にならない
    expect(objectPath(ACCOUNT_ID, "b", "%2e%2e/a")).toBe(`/accounts/${ACCOUNT_ID}/r2/buckets/b/objects/%252e%252e/a`);
  });

  it.each([["a/../b"], ["./a"], ["a/."], [""]])("URL の解決で別の経路に畳まれるキー（%j）は消さない。キーは出さない", (key) => {
    const text = emptyErrorOf(() => objectPath(ACCOUNT_ID, "b", key));
    if (key !== "") expect(text).not.toContain(key);
  });

  it("一覧の応答から key を読む。続きがあるかは is_truncated（無ければ cursor）で見る", () => {
    const result = [{ key: PROBE_KEY, size: 24 }, { key: USER_KEY }];
    expect(parsePage({ success: true, result, result_info: { cursor: "c1", is_truncated: false, per_page: 2 } })).toEqual({
      keys: [PROBE_KEY, USER_KEY],
      truncated: false,
    });
    expect(parsePage({ success: true, result, result_info: { cursor: "", is_truncated: true } }).truncated).toBe(true);
    expect(parsePage({ success: true, result, result_info: { cursor: "c1" } }).truncated).toBe(true);
    expect(parsePage({ success: true, result: [] })).toEqual({ keys: [], truncated: false });
  });

  it.each([
    ["success が true でない", { success: false, result: [] }],
    ["result が配列でない", { success: true, result: {} }],
    ["key が無い要素", { success: true, result: [{ size: 1 }] }],
    ["JSON でない", undefined],
  ])("一覧の応答の形が違えば止める（%s）", (_, body) => {
    expect(emptyErrorOf(() => parsePage(body))).toContain("オブジェクトの一覧の応答の形が想定と違う");
  });

  it("API のエラーは code と、Account ID とトークンを伏せた message だけ", () => {
    const text = describeErrors(
      { success: false, errors: [{ code: 10000, message: `Authentication error for /accounts/${ACCOUNT_ID}/r2 with ${TOKEN}` }, { message: 3 }] },
      { token: TOKEN, accountId: ACCOUNT_ID },
    );
    expect(text).toContain("code 10000");
    expect(text).toContain("code 不明");
    expectNothingSecret(text);
    expect(describeErrors({ success: true }, { token: TOKEN, accountId: ACCOUNT_ID })).toBe("");
  });
});

// ── 4. CLI ─────────────────────────────────────────────────────────────────

interface FakeR2Options {
  /** 1ページに並べる数（続きのページは cursor で返すが、empty-buckets はそれを使わないはず） */
  readonly pageSize?: number;
  /** DELETE を成功で返すが、消さない */
  readonly ignoreDeletes?: boolean;
  /** 最初の呼び出しからこの HTTP ステータスと本文で返す */
  readonly status?: { readonly code: number; readonly body: unknown };
  /** 届かない */
  readonly unreachable?: boolean;
}

interface Call {
  readonly method: string;
  readonly bucket: string;
  /** DELETE のキー（デコードしたもの） */
  readonly key?: string;
  readonly cursor: string | null;
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly all: string;
  readonly calls: readonly Call[];
  readonly store: ReadonlyMap<string, ReadonlySet<string>>;
}

async function emptyBuckets(
  argv: readonly string[],
  initial: Readonly<Record<string, readonly string[]>>,
  options: FakeR2Options = {},
  env: Readonly<Record<string, string | undefined>> = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_ACCOUNT_ID_PROD: PROD_ACCOUNT_ID },
): Promise<Run> {
  const store = new Map(Object.entries(initial).map(([bucket, keys]) => [bucket, new Set(keys)]));
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const pageSize = options.pageSize ?? 1000;
  const io: CliIo = {
    root: ROOT,
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    requestTimeoutMs: 1_000,
    fetch: async (input, init) => {
      if (options.unreachable === true) {
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${String(input)}`), { code: "ENOTFOUND" }) });
      }
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      const prefix = `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/`;
      expect(url.origin).toBe("https://api.cloudflare.com");
      expect(url.pathname.startsWith(prefix)).toBe(true);
      const [bucket = "", objects, ...segments] = url.pathname.slice(prefix.length).split("/");
      expect(objects).toBe("objects");
      const key = segments.length === 0 ? undefined : segments.map(decodeURIComponent).join("/");
      calls.push({ method, bucket, ...(key === undefined ? {} : { key }), cursor: url.searchParams.get("cursor") });
      if (options.status !== undefined) return Response.json(options.status.body, { status: options.status.code });
      const found = store.get(bucket);
      if (found === undefined) {
        return Response.json({ success: false, errors: [{ code: 10006, message: "The specified bucket does not exist." }], result: null }, { status: 404 });
      }
      if (method === "GET" && key === undefined) {
        const keys = [...found].toSorted().slice(0, pageSize);
        const truncated = found.size > pageSize;
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: keys.map((k) => ({ key: k, size: 1, etag: "fixture-etag", storage_class: "Standard" })),
          result_info: { cursor: truncated ? "fixture-cursor" : "", is_truncated: truncated, per_page: pageSize },
        });
      }
      if (method === "DELETE" && key !== undefined) {
        if (options.ignoreDeletes !== true) found.delete(key);
        return Response.json({ success: true, errors: [], messages: [], result: {} });
      }
      throw new Error(`想定外の API: ${method} ${url.pathname}`);
    },
  };
  const code = await runCli(argv, io);
  return { code, out, all: [...out, ...err].join("\n"), calls, store };
}

describe("CLI：dev 以外は受け付けない", () => {
  it.each([
    ["staging", ["--env", "staging"], "--env staging は受け付けない"],
    ["production", ["--env", "production"], "--env production は受け付けない"],
    ["未知の env（値を出さない）", ["--env", "fixture-env-5c1b"], "未知の env"],
    ["--env が無い", [], "--env が無い"],
    ["位置引数（値を出さない）", ["--env", "dev", "fixture-positional-8e2a"], "引数が不正: 位置引数は取らない"],
  ])("%s は、資格情報も API も読まずに exit 1", async (_, argv, message) => {
    const run = await emptyBuckets(argv, { "musunest-staging-bundles": ["k"], "musunest-production-bundles": ["k"] });
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toEqual([]);
    expect(run.all).toContain(`empty-buckets: ${message}`);
    expect(run.all).not.toContain("fixture-env-5c1b");
    expect(run.all).not.toContain("fixture-positional-8e2a");
  });

  it("CLOUDFLARE_ACCOUNT_ID が production のアカウントなら、API を呼ばずに exit 1", async () => {
    const run = await emptyBuckets(["--env", "dev"], { [DEV_BUCKETS.BUNDLES]: [PROBE_KEY] }, {}, {
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID,
    });
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toEqual([]);
    expect(run.all).toContain("production のアカウント");
    expectNothingSecret(run.all);
  });

  it("資格情報が無ければ、API を呼ばずに exit 1", async () => {
    const run = await emptyBuckets(["--env", "dev"], {}, {}, {});
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toEqual([]);
    expect(run.all).toContain("CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID が要る");
  });

  it("--help は使い方を出して exit 0。API を呼ばない", async () => {
    const run = await emptyBuckets(["--help"], {});
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls).toEqual([]);
    expect(run.out[0]).toMatch(/^usage: pnpm infra:empty-buckets --env dev \[--dry-run\]/);
  });
});

describe("CLI：空にする（偽の R2）", () => {
  it("dev の2つのバケットを空になるまで消し、空の一覧を読んで exit 0。キー・トークン・Account ID は出さない", async () => {
    const bundles = [PROBE_KEY, ODD_KEY, ...Array.from({ length: 3 }, (_, i) => `bundles/fixture-${i}.js`)];
    const run = await emptyBuckets(["--env", "dev"], { [DEV_BUCKETS.BUNDLES]: bundles, [DEV_BUCKETS.UPLOADS]: [USER_KEY], "musunest-staging-bundles": [PROBE_KEY] }, { pageSize: 2 });
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(run.store.get(DEV_BUCKETS.BUNDLES)?.size).toBe(0);
    expect(run.store.get(DEV_BUCKETS.UPLOADS)?.size).toBe(0);
    // dev でないバケットには触れない
    expect(run.store.get("musunest-staging-bundles")?.size).toBe(1);
    expect(new Set(run.calls.map((c) => c.bucket))).toEqual(new Set(Object.values(DEV_BUCKETS)));
    // 消したキーは一覧に並んだキーそのもの（エンコードの往復で別のキーにならない）
    expect(run.calls.filter((c) => c.method === "DELETE" && c.bucket === DEV_BUCKETS.BUNDLES).map((c) => c.key).toSorted()).toEqual(bundles.toSorted());
    expect(run.calls.filter((c) => c.method === "DELETE" && c.bucket === DEV_BUCKETS.UPLOADS).map((c) => c.key)).toEqual([USER_KEY]);
    // 続きのページ（cursor）は使わず、最初のページを読み直す。最後は空の一覧
    expect(run.calls.every((c) => c.cursor === null)).toBe(true);
    expect(run.calls.filter((c) => c.method === "GET" && c.bucket === DEV_BUCKETS.BUNDLES)).toHaveLength(4);
    expect(run.calls.at(-1)).toEqual({ method: "GET", bucket: DEV_BUCKETS.UPLOADS, cursor: null });

    expect(run.out).toContain(`  BUNDLES（${DEV_BUCKETS.BUNDLES}）: 空（消した 5 件）`);
    expect(run.out).toContain(`  UPLOADS（${DEV_BUCKETS.UPLOADS}）: 空（消した 1 件）`);
    expect(run.out.at(-1)).toBe("empty-buckets: OK  env=dev の R2 バケット 2 つが空になった（消した 6 件）");
    expectNothingSecret(run.all);
  });

  it("既に空なら、一覧を読むだけで何も消さずに exit 0", async () => {
    const run = await emptyBuckets(["--env", "dev"], { [DEV_BUCKETS.BUNDLES]: [], [DEV_BUCKETS.UPLOADS]: [] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(run.out.at(-1)).toBe("empty-buckets: OK  env=dev の R2 バケット 2 つが空になった（消した 0 件）");
  });

  it("バケットが無い（destroy の後にもう一度動かした）なら、消すものは無いとして exit 0", async () => {
    const run = await emptyBuckets(["--env", "dev"], { [DEV_BUCKETS.UPLOADS]: [USER_KEY] });
    expect(run.code, run.all).toBe(EXIT_OK);
    expect(run.out).toContainEqual(expect.stringMatching(/^ {2}BUNDLES（musunest-dev-bundles）: バケットが無い（HTTP 404（code 10006: .*）。消すものは無い$/));
    expect(run.store.get(DEV_BUCKETS.UPLOADS)?.size).toBe(0);
  });

  it("--dry-run は最初のページの件数を出すだけで、消さない", async () => {
    const run = await emptyBuckets(["--env", "dev", "--dry-run"], { [DEV_BUCKETS.BUNDLES]: [PROBE_KEY, ODD_KEY, USER_KEY], [DEV_BUCKETS.UPLOADS]: [] }, { pageSize: 2 });
    expect(run.code).toBe(EXIT_OK);
    expect(run.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(run.store.get(DEV_BUCKETS.BUNDLES)?.size).toBe(3);
    expect(run.out).toContain(`  BUNDLES（${DEV_BUCKETS.BUNDLES}）: 2 件 以上（続きのページがある）`);
    expect(run.out).toContain(`  UPLOADS（${DEV_BUCKETS.UPLOADS}）: 0 件`);
    expect(run.out.at(-1)).toBe("empty-buckets: OK  --dry-run なので何も消していない");
    expectNothingSecret(run.all);
  });
});

describe("CLI：止める", () => {
  it("消したはずのキーがまた並んだら（消えていない・消している間に書かれた）、止めて exit 1", async () => {
    const run = await emptyBuckets(["--env", "dev"], { [DEV_BUCKETS.BUNDLES]: [PROBE_KEY], [DEV_BUCKETS.UPLOADS]: [] }, { ignoreDeletes: true });
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls.map((c) => c.method)).toEqual(["GET", "DELETE", "GET"]);
    expect(run.all).toContain("消したはずのオブジェクトが 1 件、また一覧に並んだ");
    expectNothingSecret(run.all);
  });

  it(`1バケットで ${MAX_DELETIONS} 件を超えるなら、消し始める前に止めて exit 1`, async () => {
    const many = Array.from({ length: MAX_DELETIONS + 1 }, (_, i) => `bundles/${i}`);
    const run = await emptyBuckets(["--env", "dev"], { [DEV_BUCKETS.BUNDLES]: many, [DEV_BUCKETS.UPLOADS]: [] }, { pageSize: MAX_DELETIONS + 1 });
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(run.all).toContain(`${MAX_DELETIONS} 件を超える`);
  });

  it.each([
    [401, "権限が無い（HTTP 401"],
    [403, "権限が無い（HTTP 403"],
    [429, "レート制限"],
    [500, "HTTP 500"],
  ])("API が HTTP %i なら止めて exit 1。エラーの message は伏せる", async (status, message) => {
    const body = { success: false, errors: [{ code: 10000, message: `denied for /accounts/${ACCOUNT_ID}/r2/buckets with ${TOKEN}` }] };
    const run = await emptyBuckets(["--env", "dev"], { [DEV_BUCKETS.BUNDLES]: [PROBE_KEY] }, { status: { code: status, body } });
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls).toHaveLength(1);
    expect(run.all).toContain(message);
    expectNothingSecret(run.all);
  });

  it("届かなければ、URL を出さずに exit 1", async () => {
    const run = await emptyBuckets(["--env", "dev"], {}, { unreachable: true });
    expect(run.code).toBe(EXIT_NG);
    expect(run.all).toContain("Cloudflare の API に届かない（ENOTFOUND）");
    expectNothingSecret(run.all);
    expect(run.all).not.toContain("https://");
  });

  it("URL の経路で正しく指せないキーが並んだら、消さずに exit 1", async () => {
    const run = await emptyBuckets(["--env", "dev"], { [DEV_BUCKETS.BUNDLES]: ["a/../b"], [DEV_BUCKETS.UPLOADS]: [] });
    expect(run.code).toBe(EXIT_NG);
    expect(run.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(run.all).toContain("URL の経路で正しく指せないキー");
  });
});
