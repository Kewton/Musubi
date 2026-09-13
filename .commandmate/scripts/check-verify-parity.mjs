#!/usr/bin/env node
// 検証ゲートの定義が2か所で食い違っていないかを機械で止める。
//
//   node .commandmate/scripts/check-verify-parity.mjs
//
// なぜ要るか：
//   「合格とは何か」は .commandmate/verify.yaml（ローカル／commandmate verify）と
//   .github/workflows/ci.yml の lint-typecheck-unit（GitHub Actions）の2か所に書かれている。
//   片方だけ直すと「ローカルは通るが CI で落ちる」「CI は通るがローカル検証に無い」が起きる。
//   人の注意力に頼らず、ズレた瞬間に CI を落とす。
//
// なぜ .commandmate/ に置くか：
//   CommandMate は .commandmate/ をワーカーの編集範囲から既定で外す（profile-contract.md §9.6）。
//   このスクリプトを infra/scripts/ に置くと、ゲートを足したいワーカーが「常に通る」ように
//   書き換えられてしまう。審判の整合性を検査するものは、審判と同じ保護下に置く。
//
// 検査すること：
//   1. verify.yaml の gate id の並びと、ci.yml の `# verify-gate: <id>` 目印の並びが**順序まで**一致する
//   2. lint-typecheck-unit ジョブで `run:` を持つステップは、すべて直前に目印を持つ
//      （目印を付けずにステップを足すと 1 が素通りするので、その穴を塞ぐ）
//      `- run: x` の形も、`- name: x` / `- id: x` の次行に `run:` を書く形も、どちらもステップとして数える
//
// ゲートではない準備の run ステップ（例：.terraform-version を読む）は
// `# verify-setup: <理由>` を直前に書いて明示的に除外する。黙った抜け道ではなく、
// 書いた人の意図がレビューで見える形の除外である。gate id の並びには数えない。
//
// 検査しないこと：
//   コマンドの中身の一致。verify.yaml は corepack の有効化を含み、ci.yml は setup action で
//   同じことをするので、文字列は一致しない。一致を要求するのは「どのゲートがどの順で走るか」まで。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_JOB = "lint-typecheck-unit";

export function verifyGateIds(yaml) {
  return [...yaml.matchAll(/^\s{2}- id:\s*([a-z0-9-]+)\s*$/gm)].map((m) => m[1]);
}

/** ci.yml から対象ジョブのブロックだけを切り出す（`  <job>:` から次の同じ深さのキーまで）。 */
export function extractJob(yaml, job) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) throw new Error(`ci.yml に ${job} ジョブが無い`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

export function ciGateIds(jobLines) {
  return jobLines
    .map((l) => l.match(/^\s*# verify-gate:\s*([a-z0-9-]+)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * steps 配下のステップを切り出す。1ステップ＝リスト項目（`- `）から次の同じ深さの項目の直前まで。
 * `- run: x` と、`- name: x` の次行に `run:` がある形の両方を run ステップとして扱う。
 */
export function parseSteps(jobLines) {
  const at = jobLines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (at < 0) return [];
  let itemIndent = -1;
  const steps = [];
  for (let i = at + 1; i < jobLines.length; i++) {
    const m = jobLines[i].match(/^(\s*)- /);
    if (m && (itemIndent < 0 || m[1].length === itemIndent)) {
      itemIndent = m[1].length;
      steps.push({ start: i, lines: [jobLines[i]] });
    } else if (steps.length && (jobLines[i].trim() === "" || jobLines[i].match(/^(\s*)/)[1].length > itemIndent)) {
      steps[steps.length - 1].lines.push(jobLines[i]);
    }
  }
  const keyIndent = " ".repeat(itemIndent + 2);
  return steps.map((st) => ({
    ...st,
    isRun: /^\s*- run:/.test(st.lines[0]) || st.lines.slice(1).some((l) => l.startsWith(`${keyIndent}run:`)),
    label: st.lines.map((l) => l.trim()).filter(Boolean).join(" ").slice(0, 80),
  }));
}

/** 直前（空行とコメント以外の行を遡る前）にある目印の種類を返す。 */
function markerBefore(jobLines, start) {
  let j = start - 1;
  while (j >= 0 && jobLines[j].trim() === "") j--;
  if (j < 0) return null;
  if (/^\s*# verify-gate:/.test(jobLines[j])) return "gate";
  if (/^\s*# verify-setup:\s*\S/.test(jobLines[j])) return "setup";
  return null;
}

/** 目印（gate / setup）の無い run ステップを返す。 */
export function unmarkedRunSteps(jobLines) {
  return parseSteps(jobLines)
    .filter((st) => st.isRun && markerBefore(jobLines, st.start) === null)
    .map((st) => st.label);
}

export function assertGateParity(verifyIds, ciIds, unmarked) {
  if (verifyIds.length === 0) throw new Error("verify.yaml から gate id を取得できない");
  if (new Set(verifyIds).size !== verifyIds.length) throw new Error("verify.yaml に重複した gate id がある");
  if (new Set(ciIds).size !== ciIds.length) throw new Error("ci.yml に重複した verify-gate 目印がある");
  if (unmarked.length > 0) {
    throw new Error(
      `ci.yml の ${CI_JOB} に目印の無い run ステップがある（直前に # verify-gate: <id> を付けること）\n` +
        unmarked.map((s) => `  ${s}`).join("\n"),
    );
  }
  if (verifyIds.join("\0") !== ciIds.join("\0")) {
    throw new Error(
      "検証ゲートが同期していない\n" +
        `  verify.yaml: ${verifyIds.join(" -> ")}\n` +
        `  ci.yml:      ${ciIds.join(" -> ")}\n` +
        "ゲートの追加・削除は人（監督側）が verify.yaml と ci.yml を同時に直す（CLAUDE.md）。",
    );
  }
}

function main() {
  const verifyYaml = readFileSync(join(REPO_ROOT, ".commandmate/verify.yaml"), "utf8");
  const ciYaml = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = extractJob(ciYaml, CI_JOB);
  const verifyIds = verifyGateIds(verifyYaml);
  assertGateParity(verifyIds, ciGateIds(job), unmarkedRunSteps(job));
  console.log(`OK  verify parity: ${verifyIds.join(" -> ")}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (e) {
    console.error(`NG  ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
