// data-api Worker の受入試験（Issue #6）。
//
//   1. 外部ルートを持たないことを、wrangler が解決した設定で env ごとに確かめる
//   2. D1 / R2 / DO の binding が env ごとに書かれ、DO の migration が app-do の正本と一致する
//   3. 本物の workerd の上で /healthz が 200 を返し、D1 / R2 / DO を実際に踏んでいる
//   4. D1 のマイグレーション（Issue #12）：SQL は control-plane に置き、data-api の設定で当てる。
//      runbook の適用コマンドを env.dev に --local で実際に叩き、全部当たることを確かめる
//
// モックにしないのは app-do と同じ理由：binding が「解決している」ことの証明は、
// 解決した binding を実際に叩くことでしか得られない。
//
// wrangler / vitest は devDependencies に無い。ルートの package.json に集約してある（app-do と同じ）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig } from "wrangler";
import type { DataApiEnv } from "./cloudflare.js";
import { PROBE_DO_NAME, PROBE_OBJECT_KEY } from "./cloudflare.js";
import {
  BUNDLES_BINDING,
  CONTROL_DB_BINDING,
  HEALTHZ_PATH,
  PACKAGE_NAME,
  UPLOADS_BINDING,
} from "./contract.js";
import type { HealthzBody } from "./contract.js";

// tsconfig の lib は ES2022 ＋ workers-types だけなので ImportMeta.url が型に無い。
// このファイルは workerd ではなく Node（vitest）の側で動くので、ここだけ局所的に補う。
const HERE = (import.meta as ImportMeta & { url: string }).url;
const CONFIG_PATH = new URL("../wrangler.jsonc", HERE);
/** DO の class_name / migration の正本（03 §4・app-do の wrangler.jsonc 冒頭） */
const APP_DO_CONFIG_PATH = new URL("../../app-do/wrangler.jsonc", HERE);
const BOOT_TIMEOUT_MS = 120_000;

/** D1 マイグレーションの SQL の置き場（docs/runbook/d1-migration.md §1）。D1 は Control Plane 専用 */
const CONTROL_PLANE_MIGRATIONS_DIR = new URL("../../control-plane/migrations/", HERE);
const REPO_ROOT = new URL("../../../", HERE);
const WRANGLER_CLI = new URL("../../../node_modules/wrangler/bin/wrangler.js", HERE);

const ENVS = ["dev", "staging", "production"] as const;

const readConfig = (path: URL, env?: string) =>
  unstable_readConfig(
    { config: decodeURIComponent(path.pathname), ...(env === undefined ? {} : { env }) },
    { hideWarnings: true },
  );

describe("data-api パッケージ", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/data-api");
  });
});

describe.each(ENVS)("wrangler.jsonc（env.%s）", (env) => {
  const config = readConfig(CONFIG_PATH, env);
  const appDo = readConfig(APP_DO_CONFIG_PATH);

  it("Worker 名が musunest-<env>-data-api（gateway の Service Binding の宛先）", () => {
    expect(config.name).toBe(`musunest-${env}-data-api`);
  });

  it("外部ルートを持たない：workers.dev・Preview URL・routes のどれも無い", () => {
    // Service Binding は呼ぶ側が Worker 名で結ぶので、到達経路を1つも作らなくても届く。
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes ?? []).toEqual([]);
    expect(config.route).toBeUndefined();
  });

  it("D1 は CONTROL_DB の1つだけで、その env の control データベースを指す", () => {
    expect(config.d1_databases).toEqual([
      expect.objectContaining({
        binding: CONTROL_DB_BINDING,
        database_name: `musunest-${env}-control`,
        database_id: expect.any(String),
      }),
    ]);
  });

  it("CONTROL_DB の migrations_dir が packages/control-plane/migrations を指す（SQL は control-plane・適用は data-api の設定）", () => {
    // control-plane には wrangler の設定が無く、infra:sync も database_id を書き戻さない。
    // だから CONTROL_DB を binding している data-api の設定から当てる。3環境とも同じ SQL を当てる。
    const [controlDb] = config.d1_databases;
    expect(controlDb?.migrations_dir).toBe("../control-plane/migrations");
    // wrangler は設定ファイルのディレクトリから解決する（2026-09-14 実測・wrangler 4.131.1）
    expect(new URL(`${controlDb?.migrations_dir}/`, CONFIG_PATH).href).toBe(CONTROL_PLANE_MIGRATIONS_DIR.href);
    // 適用済みの記録は既定の d1_migrations 表。runbook の巻き戻し手順（§5）がこの名前を前提にする
    expect(controlDb?.migrations_table).toBeUndefined();
  });

  it("R2 は BUNDLES と UPLOADS で、その env のバケットを指す", () => {
    expect(config.r2_buckets).toEqual([
      expect.objectContaining({ binding: BUNDLES_BINDING, bucket_name: `musunest-${env}-bundles` }),
      expect.objectContaining({ binding: UPLOADS_BINDING, bucket_name: `musunest-${env}-uploads` }),
    ]);
  });

  it("DO の binding と migration が app-do の正本と一致する（new_sqlite_classes）", () => {
    expect(config.durable_objects.bindings).toEqual(appDo.durable_objects.bindings);
    expect(config.migrations).toEqual(appDo.migrations);
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["AppInstanceDO"] }]);
  });

  it("vars.ENVIRONMENT がその env を名乗る", () => {
    expect(config.vars).toMatchObject({ ENVIRONMENT: env });
  });

  it("infra:sync が扱えない binding（KV・Queue consumer）を持たない", () => {
    expect(config.kv_namespaces).toEqual([]);
    expect(config.queues.consumers ?? []).toEqual([]);
  });
});

describe.each(ENVS)("data-api Worker（env.%s・workerd 上の実機）", (env) => {
  const server = createTestHarness({
    workers: [{ configPath: CONFIG_PATH, env, vars: { GIT_SHA: "test-sha" } }],
  });

  beforeAll(async () => {
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it("GET /healthz が 200 を返し、D1 / R2 / DO が全部 ok", async () => {
    const res = await server.fetch(HEALTHZ_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthzBody;
    expect(body).toEqual({
      service: "data-api",
      env,
      version: "test-sha",
      checks: { d1: "ok", r2: "ok", do: "ok" },
      elapsed_ms: expect.any(Number),
    });
  });

  it("binding が解決している：healthz が R2 と DO（SQLite）に実際に書いている", async () => {
    await server.fetch(HEALTHZ_PATH);
    const worker = server.getWorker<DataApiEnv>();

    const bindings = await worker.getEnv();
    expect(Object.keys(bindings)).toEqual(
      expect.arrayContaining([CONTROL_DB_BINDING, BUNDLES_BINDING, UPLOADS_BINDING, "APP_DO"]),
    );
    expect(await bindings.BUNDLES.head(PROBE_OBJECT_KEY)).not.toBeNull();

    const sql = await worker.getDurableObjectStorage("APP_DO", { name: PROBE_DO_NAME });
    expect(await sql.exec("SELECT k FROM _probe")).toEqual([{ k: "healthz" }]);
  });

  it("/healthz 以外のパスは 404", async () => {
    const res = await server.fetch("/");
    expect(res.status).toBe(404);
  });

  it("GET 以外は 405", async () => {
    const res = await server.fetch(HEALTHZ_PATH, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

// ── D1 マイグレーション（docs/runbook/d1-migration.md §2.1）─────────────────────────
//
// SQL を当てる経路は wrangler の d1 migrations だけで、ほかのゲートはどれも SQL を読まない。
// ここで当てておかないと、壊れた migration は main へのマージ後に staging の CD（04 §4 ①）で初めて落ちる。
// runbook の適用コマンドをリポジトリ直下からそのまま叩く。違いは2つだけ：
//   - `pnpm exec wrangler` ではなく wrangler の CLI を node で直接起動する
//   - `--persist-to` で一時ディレクトリへ逃がす（開発者の packages/data-api/.wrangler/state に触れない）

/**
 * tsconfig の types は workers-types だけで、Node の型を読まない（src は workerd 向け）。
 * wrangler を子プロセスで起動するところだけ Node の API が要るので、使う形だけを局所的に書く。
 */
interface NodeApis {
  execFileSync(
    file: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      encoding: "utf8";
      stdio: ["ignore", "pipe", "pipe"];
      timeout: number;
    },
  ): string;
  mkdtempSync(prefix: string): string;
  readdirSync(path: string): string[];
  rmSync(path: string, options: { recursive: true; force: true }): void;
  tmpdir(): string;
}

// 文字列リテラルで import すると tsc が型を探しに行くので、引数を経由する
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

async function loadNodeApis(): Promise<NodeApis> {
  const [childProcess, fs, os] = await Promise.all([
    importUntyped("node:child_process"),
    importUntyped("node:fs"),
    importUntyped("node:os"),
  ]);
  return {
    execFileSync: childProcess.execFileSync,
    mkdtempSync: fs.mkdtempSync,
    readdirSync: fs.readdirSync,
    rmSync: fs.rmSync,
    tmpdir: os.tmpdir,
  };
}

const node = await loadNodeApis();
const WRANGLER_TIMEOUT_MS = 60_000;

const wrangler = (...args: string[]) =>
  node.execFileSync(process.execPath, [decodeURIComponent(WRANGLER_CLI.pathname), ...args], {
    cwd: decodeURIComponent(REPO_ROOT.pathname),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
    // stdin を渡さない＝非対話。確認は既定値（yes）で進む。CD のランナーと同じ条件
    stdio: ["ignore", "pipe", "pipe"],
    timeout: WRANGLER_TIMEOUT_MS,
  });

const sqlFiles = () =>
  node
    .readdirSync(decodeURIComponent(CONTROL_PLANE_MIGRATIONS_DIR.pathname))
    .filter((name) => name.endsWith(".sql"))
    .sort();

describe("D1 マイグレーション（packages/control-plane/migrations）", () => {
  let persistTo = "";

  /** runbook §2.1 の `--env dev --config packages/data-api/wrangler.jsonc --local` に `--persist-to` を足したもの */
  const devLocal = () => [
    "--env", "dev", "--config", "packages/data-api/wrangler.jsonc", "--local", "--persist-to", persistTo,
  ];

  const query = <Row>(sql: string): Row[] => {
    const out = wrangler("d1", "execute", CONTROL_DB_BINDING, ...devLocal(), "--json", "--command", sql);
    const [result] = JSON.parse(out) as [{ results: Row[] }];
    return result.results;
  };

  beforeAll(() => {
    persistTo = node.mkdtempSync(`${node.tmpdir()}/musunest-d1-migrations-`);
    // 2回当てる。CD は main への push のたびに当てるので、2回目が何も当てないことまでが契約
    wrangler("d1", "migrations", "apply", CONTROL_DB_BINDING, ...devLocal());
    wrangler("d1", "migrations", "apply", CONTROL_DB_BINDING, ...devLocal());
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (persistTo !== "") node.rmSync(persistTo, { recursive: true, force: true });
  });

  it("ファイル名は <4桁の連番>_<名前>.sql で、0001 から欠番も重複もなく並ぶ", () => {
    // wrangler はファイル名の順に当てる。番号が衝突・前後すると、環境によって当たる順が変わりうる（runbook §1.2）
    const files = sqlFiles();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((name, i) => {
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(name.slice(0, 4)).toBe(String(i + 1).padStart(4, "0"));
    });
  });

  it("適用コマンドで env.dev に --local で全部当たり、2回目は何も当てない（d1_migrations に1件ずつ）", () => {
    const applied = query<{ name: string }>("SELECT name FROM d1_migrations ORDER BY id");
    expect(applied.map((row) => row.name)).toEqual(sqlFiles());
  });

  it("0001 が _musunest_meta を作る（03 §7）", () => {
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_musunest_meta'",
    );
    expect(tables).toEqual([{ name: "_musunest_meta" }]);
  });
});
