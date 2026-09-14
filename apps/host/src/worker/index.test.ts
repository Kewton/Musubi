// host の受入試験（Issue #9）。
//
//   1. wrangler.jsonc（env ごと）：持つ binding は同じ env の gateway への Service Binding だけで、D1 / R2 / DO（と infra:sync が
//      扱う KV・Queue・dispatch）を持たない。ページは Static Assets が返し、Worker が先に受けるのは /api/* と /healthz だけ
//   2. host を env ごとに**実際に vite build し**、`wrangler deploy` が読むのと同じ出力（.wrangler/deploy/config.json の指す先）を確かめる
//      - SPAシェル：dist/client/index.html はシェルだけで、ルートの中身を描いていない（SSR にしない）
//      - 配る Worker のバンドルに React / TanStack Start の描画が入っていない（入っているのはビルド時の prerender Worker だけ）
//   3. その出力を本物の workerd の上で gateway・data-api と並べて起動し、
//      - / と深いリンクが同じ SPAシェルを返し、/healthz が Service Binding 越しに gateway → data-api → {D1, R2, DO} まで届く
//   4. Worker を「呼ばれたら目印を返す」罠に差し替えても、ページロードは SPAシェルが返る＝**Static Assets が Worker を起動せずに返している**。
//      罠に掛かるのは run_worker_first の2つだけ
//
// モックにしないのは gateway と同じ理由：Service Binding が結線されていること、Static Assets の経路が設定どおりであることの
// 証明は、vite-plugin が wrangler.jsonc を解決した出力を、wrangler が実際に動かすことでしか得られない。
//
// ビルドは一時ディレクトリに写した host で行う。本物の dist/ と .wrangler/deploy/ を書き換えると、手元で作った配備物を
// テストが黙って別の env のものに差し替えてしまう。wrangler / vitest はルートの package.json に集約してある（gateway と同じ）。
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig } from "wrangler";
import type { TestHarness } from "wrangler";
import { GATEWAY_BINDING, HEALTHZ_PATH, HOST_HEALTHZ_CHECKS, PACKAGE_NAME, WORKER_ROUTES } from "./contract.js";
import type { HostHealthzBody } from "./contract.js";
import { SKIPPED } from "./healthz.js";

const HOST_DIR = fileURLToPath(new URL("../../", import.meta.url).href);
const REPO_ROOT = resolve(HOST_DIR, "../..");
const CONFIG_PATH = join(HOST_DIR, "wrangler.jsonc");
/** Service Binding の宛先。gateway と data-api の Worker 名の正本はそれぞれの wrangler.jsonc */
const GATEWAY_CONFIG_PATH = join(REPO_ROOT, "apps/gateway/wrangler.jsonc");
const DATA_API_CONFIG_PATH = join(REPO_ROOT, "packages/data-api/wrangler.jsonc");
const VITE_BIN = join(HOST_DIR, "node_modules/vite/bin/vite.js");
const BOOT_TIMEOUT_MS = 120_000;

const ENVS = ["dev", "staging", "production"] as const;
type Env = (typeof ENVS)[number];

const readConfig = (path: string, env?: string) =>
  unstable_readConfig({ config: path, ...(env === undefined ? {} : { env }) }, { hideWarnings: true });

/** 描画のコードに固有の識別子。SSR の描画（React）と TanStack Start のサーバーがバンドルに入っていれば、どちらかが残る */
const RENDERER_MARKERS = ["renderToReadableStream", "createStartHandler"] as const;
/** ルートの中身（src/app/routes/index.tsx）。シェルに入っていれば、そのページを SSR で描いたことになる */
const ROUTE_CONTENT = "<h1>Musubi</h1>";
/** Worker を差し替える罠。Worker が呼ばれたら必ずこの本文を 418 で返す（Static Assets も workerd も返さない組み合わせ） */
const TRIPWIRE = "host worker was invoked";
/** ブラウザのページ遷移が付けるヘッダ。Static Assets はこれで「ナビゲーション」を見分ける */
const NAVIGATION = { "sec-fetch-mode": "navigate", accept: "text/html" } as const;

describe("host パッケージ", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musubi/host");
  });
});

describe.each(ENVS)("wrangler.jsonc（env.%s）", (env) => {
  const config = readConfig(CONFIG_PATH, env);
  const gateway = readConfig(GATEWAY_CONFIG_PATH, env);

  it("Worker 名が musubi-<env>-host", () => {
    expect(config.name).toBe(`musubi-${env}-host`);
  });

  it("Service Binding は GATEWAY の1本だけで、同じ env の gateway を指す", () => {
    expect(gateway.name).toBe(`musubi-${env}-gateway`);
    expect(config.services).toEqual([{ binding: GATEWAY_BINDING, service: gateway.name }]);
  });

  it("D1 / R2 / DO を直接触らない：d1_databases・r2_buckets・durable_objects・migrations が無い", () => {
    expect(config.d1_databases).toEqual([]);
    expect(config.r2_buckets).toEqual([]);
    expect(config.durable_objects.bindings).toEqual([]);
    expect(config.migrations).toEqual([]);
  });

  it("infra:sync が扱う他の binding（KV・Queue・dispatch）も持たない", () => {
    expect(config.kv_namespaces).toEqual([]);
    expect(config.queues.producers ?? []).toEqual([]);
    expect(config.queues.consumers ?? []).toEqual([]);
    expect(config.dispatch_namespaces).toEqual([]);
  });

  it("vars.ENVIRONMENT がその env を名乗る（gateway と同じ値。healthz が突き合わせる）", () => {
    expect(config.vars).toMatchObject({ ENVIRONMENT: env });
    expect(gateway.vars).toMatchObject({ ENVIRONMENT: env });
  });

  it("SSR をしない：main は薄い Worker（src/worker/index.ts）で、ページは Static Assets の SPAシェルが返す", () => {
    expect(config.main).toBe(join(HOST_DIR, "src/worker/index.ts"));
    expect(config.assets).toMatchObject({ not_found_handling: "single-page-application" });
  });

  it("Worker が先に受けるのは /api/* と /healthz だけ", () => {
    expect(config.assets?.run_worker_first).toEqual([...WORKER_ROUTES]);
  });
});

describe("CLOUDFLARE_ENV（ビルド時の env）", () => {
  it("dev / staging / production 以外ならビルドを始めずに失敗する", async () => {
    const root = copyHost("invalid");
    try {
      const { code, output } = await viteBuild(root, "prod");
      expect(code).not.toBe(0);
      expect(output).toContain("CLOUDFLARE_ENV は dev / staging / production のどれか");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface Build {
  readonly root: string;
  /** vite build の出力 */
  readonly dist: string;
  /** .wrangler/deploy/config.json。wrangler deploy はこれが指す設定を読む */
  readonly deploy: { readonly configPath: string; readonly auxiliaryWorkers: unknown[]; readonly prerenderWorkerConfigPath?: string };
  /** wrangler deploy が配る Worker の設定（vite-plugin が書き出した wrangler.json） */
  readonly workerConfigPath: string;
  /** ビルド中にシェルを描くためだけの prerender Worker の設定 */
  readonly prerenderConfigPath: string;
}

const builds = new Map<Env, Build>();

beforeAll(async () => {
  // dev は CLOUDFLARE_ENV を渡さずに作る。未指定が dev に倒れることも同時に確かめる（vite.config.ts）。
  // 並列にしない：prerender の preview サーバー（workerd）が同時に立つと、互いに取り合って描画が 500 になる。
  for (const env of ENVS) {
    const root = copyHost(env);
    const { code, output } = await viteBuild(root, env === "dev" ? undefined : env);
    if (code !== 0) throw new Error(`vite build（${env}）が exit ${code} で失敗した:\n${output}`);
    const deployConfigPath = join(root, ".wrangler/deploy/config.json");
    const deploy = JSON.parse(readFileSync(deployConfigPath, "utf8")) as Build["deploy"];
    builds.set(env, {
      root,
      dist: join(root, "dist"),
      deploy,
      workerConfigPath: resolve(dirname(deployConfigPath), deploy.configPath),
      prerenderConfigPath: resolve(dirname(deployConfigPath), deploy.prerenderWorkerConfigPath ?? ""),
    });
  }
}, BOOT_TIMEOUT_MS * 2);

afterAll(() => {
  for (const { root } of builds.values()) rmSync(root, { recursive: true, force: true });
});

const buildOf = (env: Env): Build => {
  const build = builds.get(env);
  if (build === undefined) throw new Error(`${env} のビルドが無い`);
  return build;
};

describe.each(ENVS)("vite build の出力（env.%s）", (env) => {
  it("wrangler deploy が配るのは host の Worker 1つだけで、prerender Worker を配らない", () => {
    const { deploy, workerConfigPath, prerenderConfigPath } = buildOf(env);
    expect(deploy.auxiliaryWorkers).toEqual([]);
    expect(deploy.prerenderWorkerConfigPath).toEqual(expect.any(String));
    expect(dirname(prerenderConfigPath)).not.toBe(dirname(workerConfigPath));

    const config = JSON.parse(readFileSync(workerConfigPath, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      name: `musubi-${env}-host`,
      // ビルドした env が刻まれる。wrangler deploy --env <別の env> はこれと食い違って失敗する
      targetEnvironment: env,
      services: [{ binding: GATEWAY_BINDING, service: `musubi-${env}-gateway` }],
      assets: { not_found_handling: "single-page-application", run_worker_first: [...WORKER_ROUTES] },
    });
  });

  it("SPAシェル（dist/client/index.html）はシェルだけで、ルートの中身を描いていない（SSR にしない）", () => {
    const html = readFileSync(join(buildOf(env).dist, "client/index.html"), "utf8");
    expect(html).toMatch(/^<!DOCTYPE html><html lang="ja">/);
    expect(html).toContain("<title>Musubi</title>");
    expect(html).toMatch(/<script type="module" async="" src="\/assets\/[^"]+\.js"><\/script>/);
    expect(html).not.toContain(ROUTE_CONTENT);
  });

  it("配る Worker のバンドルに描画のコードが入っていない（入っているのはビルド時の prerender Worker だけ）", () => {
    const { workerConfigPath, prerenderConfigPath } = buildOf(env);
    const worker = readJs(dirname(workerConfigPath));
    const prerender = readJs(dirname(prerenderConfigPath));
    for (const marker of RENDERER_MARKERS) {
      // 目印が空振りしていないことを、描画を持つ側で先に確かめる
      expect(prerender, marker).toContain(marker);
      expect(worker, marker).not.toContain(marker);
    }
  });
});

describe("生成物", () => {
  // typecheck はビルドの前に走る（CI も verify.yaml も build を持たない）ので、生成物をコミットしてある。古いまま残さない。
  it("コミットしてある src/app/routeTree.gen.ts が、ビルドが生成したものと一致する", () => {
    const generated = readFileSync(join(buildOf("dev").root, "src/app/routeTree.gen.ts"), "utf8");
    expect(readFileSync(join(HOST_DIR, "src/app/routeTree.gen.ts"), "utf8")).toBe(generated);
  });
});

describe.each(ENVS)("host → gateway → data-api（env.%s・workerd 上の実機）", (env) => {
  let server: TestHarness;

  beforeAll(async () => {
    server = createTestHarness({
      workers: [
        // 先頭が primary。server.fetch は host に届く。ビルドの出力は env を解決済みなので env を渡さない
        { configPath: buildOf(env).workerConfigPath, vars: { GIT_SHA: "test-sha" } },
        { configPath: GATEWAY_CONFIG_PATH, env, vars: { GIT_SHA: "test-sha" } },
        { configPath: DATA_API_CONFIG_PATH, env, vars: { GIT_SHA: "test-sha" } },
      ],
    });
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
  }, BOOT_TIMEOUT_MS);

  it("GET / は SPAシェル（dist/client/index.html）を返す", async () => {
    const res = await server.fetch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toBe(readFileSync(join(buildOf(env).dist, "client/index.html"), "utf8"));
  });

  it("深いリンクへのナビゲーションも同じ SPAシェルを返す（ルーティングはブラウザが行う）", async () => {
    const res = await server.fetch("/communities/c1/apps", { headers: NAVIGATION });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(readFileSync(join(buildOf(env).dist, "client/index.html"), "utf8"));
  });

  it("GET /healthz が Service Binding 越しに gateway に届き、data-api の D1 / R2 / DO まで全部 ok で 200", async () => {
    const res = await server.fetch(HEALTHZ_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HostHealthzBody;
    expect(body).toEqual({
      service: "host",
      env,
      version: "test-sha",
      checks: { gateway: "ok", data_api: "ok", d1: "ok", r2: "ok", do: "ok" },
      elapsed_ms: expect.any(Number),
    });
    expect(Object.keys(body.checks)).toEqual([...HOST_HEALTHZ_CHECKS]);
  });

  it("/api/* は Worker が受け、SPAシェルではなく JSON の 404 を返す", async () => {
    const res = await server.fetch("/api/communities", { headers: { accept: "application/json" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("GET 以外の /healthz は 405", async () => {
    const res = await server.fetch(HEALTHZ_PATH, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("別の env の gateway に届いたとき（workerd 上の実機）", () => {
  // Service Binding は Worker 名で結ぶので、名前が合えば中身が別の env の gateway でも届いてしまう。
  // gateway と data-api の ENVIRONMENT だけを staging に差し替え（gateway 自身は ok になる）、host（dev）が止めることを見る。
  // gateway 以下の ok が host 自身ではなく、Service Binding の先の応答から来ていることの証明も兼ねる。
  let server: TestHarness;

  beforeAll(async () => {
    server = createTestHarness({
      workers: [
        { configPath: buildOf("dev").workerConfigPath, vars: { GIT_SHA: "test-sha" } },
        { configPath: GATEWAY_CONFIG_PATH, env: "dev", vars: { GIT_SHA: "test-sha", ENVIRONMENT: "staging" } },
        { configPath: DATA_API_CONFIG_PATH, env: "dev", vars: { GIT_SHA: "test-sha", ENVIRONMENT: "staging" } },
      ],
    });
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
  }, BOOT_TIMEOUT_MS);

  it("gateway が ng: env mismatch の 503 になり、その先は確かめなかったと示す", async () => {
    const res = await server.fetch(HEALTHZ_PATH);
    expect(res.status).toBe(503);
    const body = (await res.json()) as HostHealthzBody;
    expect(body.env).toBe("dev");
    expect(body.checks).toEqual({ gateway: "ng: env mismatch", data_api: SKIPPED, d1: SKIPPED, r2: SKIPPED, do: SKIPPED });
  });
});

describe("Static Assets 経由の配信（Worker を罠に差し替えた実機）", () => {
  // 配る Worker の設定（assets の directory・not_found_handling・run_worker_first）はそのままに、main だけを
  // 「呼ばれたら目印を返す」Worker に差し替える。目印が返らなかったリクエストは、Worker を起動せずに Static Assets が返したものである。
  // Static Assets へのリクエストは Workers の 100k req/日 に数えられない（06 §4.1。実数の確認は 06 §7 #4 で Analytics を見る）。
  let server: TestHarness;
  let html: string;
  let script: string;

  beforeAll(async () => {
    const { dist, workerConfigPath } = buildOf("dev");
    html = readFileSync(join(dist, "client/index.html"), "utf8");
    script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? "";

    const config = JSON.parse(readFileSync(workerConfigPath, "utf8")) as Record<string, unknown>;
    // directory は "../client"（出力ディレクトリからの相対）なので、同じ深さに置けばそのまま解決される
    const trapDir = join(dist, "tripwire");
    mkdirSync(trapDir, { recursive: true });
    writeFileSync(
      join(trapDir, "index.js"),
      `export default { fetch() { return new Response(${JSON.stringify(TRIPWIRE)}, { status: 418 }); } };\n`,
    );
    // 宛先の無い Service Binding では workerd が起動しないので、binding だけ外す（Worker は呼ばれないはずである）
    writeFileSync(join(trapDir, "wrangler.json"), JSON.stringify({ ...config, main: "index.js", services: [] }));

    server = createTestHarness({ workers: [{ configPath: join(trapDir, "wrangler.json") }] });
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
  }, BOOT_TIMEOUT_MS);

  it.each([
    ["/", "/", {}],
    ["深いリンクへのナビゲーション", "/communities/c1/apps", NAVIGATION],
  ] as const)("ページロード（%s）は Worker を起動せず、SPAシェルが 200 で返る", async (_, path, headers) => {
    const res = await server.fetch(path, { headers });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(html);
  });

  it("シェルが読む JS も Worker を起動せずに返る", async () => {
    expect(script).not.toBe("");
    const res = await server.fetch(script);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
  });

  it.each(["/healthz", "/api/communities"])("run_worker_first の %s だけは Worker に届く（罠に掛かる）", async (path) => {
    const res = await server.fetch(path);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe(TRIPWIRE);
  });
});

/**
 * host を一時ディレクトリへ写す。node_modules は本物を指す。
 * tsconfig の extends と references は相対パスなので、本物を指す絶対パスに書き換える（vite は references まで辿る）。
 */
function copyHost(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `host-build-${label}-`));
  for (const entry of ["package.json", "vite.config.ts", "wrangler.jsonc", "src"]) {
    cpSync(join(HOST_DIR, entry), join(root, entry), { recursive: true });
  }
  for (const entry of ["tsconfig.json", "tsconfig.app.json"]) {
    const tsconfig = JSON.parse(readFileSync(join(HOST_DIR, entry), "utf8")) as {
      extends: string;
      references?: { path: string }[];
    };
    tsconfig.extends = resolve(HOST_DIR, tsconfig.extends);
    if (tsconfig.references !== undefined) {
      tsconfig.references = tsconfig.references.map(({ path }) => ({ path: resolve(HOST_DIR, path) }));
    }
    writeFileSync(join(root, entry), JSON.stringify(tsconfig));
  }
  symlinkSync(join(HOST_DIR, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

/** 写した host で `vite build` を別プロセスで走らせる。vitest の環境（NODE_ENV=test など）と CLOUDFLARE_* は持ち込まない。 */
function viteBuild(root: string, cloudflareEnv: string | undefined): Promise<{ code: number | null; output: string }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(NODE_ENV|VITEST.*|CLOUDFLARE_.*|TSS_.*)$/.test(key)),
  );
  if (cloudflareEnv !== undefined) env.CLOUDFLARE_ENV = cloudflareEnv;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [VITE_BIN, "build"], { cwd: root, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => done({ code, output }));
  });
}

/** ディレクトリ直下から再帰的に .js を読んで連結する（Worker のバンドルは複数の chunk に分かれ得る）。 */
function readJs(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
}
