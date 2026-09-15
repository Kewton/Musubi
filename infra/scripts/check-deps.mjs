#!/usr/bin/env node
// 依存の向きを機械強制する（01-repo-bootstrap.md §3.2「禁止する依存」）。
//
// なぜ oxlint の no-restricted-imports だけに頼らないか：
//   import 文の検査は「書かれたコード」しか見ない。まだ中身が空の M0 では素通りする。
//   package.json の依存グラフを直接照合すれば、コードを1行も書く前から境界を守れる。
//   TypeScript の project references も同じ向きに張ってあるので、typecheck でも二重に効く。
import { readFileSync } from "node:fs";
import { ALLOWED, DIRS } from "./dep-graph.mjs";

let ng = 0;
const isWorkspace = (v) => typeof v === "string" && v.startsWith("workspace:");

for (const [name, allowed] of Object.entries(ALLOWED)) {
  const pkg = JSON.parse(readFileSync(`${DIRS[name]}/package.json`, "utf8"));
  const actual = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(([k, v]) => k.startsWith("@musunest/") && isWorkspace(v))
    .map(([k]) => k);

  for (const dep of actual) {
    if (!allowed.includes(dep)) {
      console.error(`NG  ${name} -> ${dep} は許可されていない依存`);
      ng++;
    }
  }
  // TypeScript project references が package.json と食い違っていないか
  const tsconfig = JSON.parse(readFileSync(`${DIRS[name]}/tsconfig.json`, "utf8"));
  const refs = (tsconfig.references ?? []).map((r) => r.path.replace(/^(\.\.\/)+/, ""));
  const expected = actual.map((d) => DIRS[d]).sort();
  if (JSON.stringify(refs.slice().sort()) !== JSON.stringify(expected)) {
    console.error(`NG  ${name} の tsconfig references が dependencies と一致しない`);
    console.error(`    references=${JSON.stringify(refs.slice().sort())} dependencies=${JSON.stringify(expected)}`);
    ng++;
  }
}

if (ng) {
  console.error(`\n依存の向きに違反 ${ng} 件。infra/scripts/dep-graph.mjs が正本。`);
  process.exit(1);
}
console.log(`OK  依存の向き ${Object.keys(ALLOWED).length} パッケージ（dep-graph.mjs と一致）`);
