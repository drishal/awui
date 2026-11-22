// The e2e suite's cost-balanced shard table: which spec (or which test of a spec)
// belongs to which shard.
//
// `--shard=N/4` splits by test count, and app.spec.ts holds a quarter of the
// suite's time in tests that average nearly twice the rest, so a count-based split
// leaves one shard far behind. This reads the JSON reports a `test:e2e:fast` run
// writes (test-results/shard-N/report.json, one per shard), adds up each spec's
// duration, and packs the specs so every shard costs about the same — longest first,
// each onto the shard that is cheapest so far.
//
// The table also records every spec file's hash. A file that changed since the table
// was written runs whole on the cheapest shard instead (e2e-parallel.mjs), so a stale
// table costs balance, never tests. Regenerate it after adding or editing specs:
//
//   npm run test:e2e:fast && npm run e2e:shards
//
// Reports exist only for a shard that ran to its end, so a run that was interrupted
// leaves no table entry to trust.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const SHARD_COUNT = 4;
const root = path.resolve(import.meta.dirname, "..");
const e2eDir = path.join(root, "tests/e2e");
const tableFile = path.join(e2eDir, "shards.json");

const reportFiles =
  process.argv.length > 2
    ? process.argv.slice(2)
    : Array.from({ length: SHARD_COUNT }, (_, i) => path.join(root, `test-results/shard-${i + 1}/report.json`));

const missing = reportFiles.filter((file) => !existsSync(file));
if (missing.length) {
  console.error(`e2e-shards: no report at ${missing.map((f) => path.relative(root, f)).join(", ")}`);
  console.error("Run `npm run test:e2e:fast` first; it writes one JSON report per shard.");
  process.exit(1);
}

/** Every spec a report holds, at any depth (a describe block nests suites). */
function specsOf(suite, into) {
  for (const spec of suite.specs ?? []) {
    const result = spec.tests?.[0]?.results?.[0];
    into.push({ file: spec.file, line: spec.line, seconds: (result?.duration ?? 0) / 1000 });
  }
  for (const child of suite.suites ?? []) specsOf(child, into);
  return into;
}

const specs = [];
for (const file of reportFiles) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  for (const suite of report.suites ?? []) specsOf(suite, specs);
}

const specFiles = readdirSync(e2eDir)
  .filter((name) => name.endsWith(".spec.ts"))
  .sort();
// A report older than a spec file could name lines that file no longer has, and the
// hash check at run time could not see that: build nothing from it.
const newestSpec = Math.max(...specFiles.map((name) => statSync(path.join(e2eDir, name)).mtimeMs));
const oldestReport = Math.min(...reportFiles.map((file) => statSync(file).mtimeMs));
if (oldestReport < newestSpec) {
  console.error("e2e-shards: a report is older than a spec on disk; run `npm run test:e2e:fast` again first.");
  process.exit(1);
}
// A report from before a spec was deleted still names it; the table keeps only what
// can still run.
const recorded = specs.filter((spec) => specFiles.includes(spec.file));
// A file with no tests (accounts.spec.ts today) has nothing to record, but its hash
// still belongs in the table: otherwise every run would take it for a new spec.
const unrecorded = specFiles.filter((name) => !specs.some((spec) => spec.file === name));
for (const name of unrecorded) {
  const source = readFileSync(path.join(e2eDir, name), "utf8");
  if (/^\s*(test|it)\s*\(|^\s*test\.(only|skip|fixme|fail)\s*\(/m.test(source)) {
    console.error(`e2e-shards: ${name} has tests, but no report lists them; a shard did not finish.`);
    process.exit(1);
  }
}

// A test declared in a loop or a table (app.spec.ts's two phone widths) shares one
// declaration line, and a line filter selects every test of that line: such a set
// travels together, as one entry that carries their summed cost.
const units = new Map();
for (const spec of recorded) {
  const key = `${spec.file}:${spec.line}`;
  const unit = units.get(key) ?? { key, seconds: 0 };
  unit.seconds += spec.seconds;
  units.set(key, unit);
}

// The specs on one shard share one server and one state folder, so a chat a test leaves
// waiting on an approval is still "needs you" for the pages that follow: its sidebar
// keeps a Running row and it puts a notice on screen. A file that leaves such a chat
// travels whole, and never shares a shard with a file that asserts on the whole list.
const leavesWaitingChat = ["context-panel.spec.ts", "sidebar-filter.spec.ts"];
const assertsWholeList = ["sidebar-filter.spec.ts", "toasts-and-swipes.spec.ts"];
const pinned = new Set([...leavesWaitingChat, ...assertsWholeList]);

// Packages travel together: one per test entry, and one whole file for a pinned file.
const packages = [];
const wholeFiles = new Map();
for (const unit of units.values()) {
  const file = unit.key.slice(0, unit.key.lastIndexOf(":"));
  if (!pinned.has(file)) {
    packages.push([unit]);
    continue;
  }
  const pack = wholeFiles.get(file) ?? [];
  pack.push(unit);
  wholeFiles.set(file, pack);
}
packages.push(...wholeFiles.values());

const secondsOf = (pack) => pack.reduce((sum, unit) => sum + unit.seconds, 0);
const totalSeconds = recorded.reduce((sum, spec) => sum + spec.seconds, 0);
const bins = Array.from({ length: SHARD_COUNT }, () => ({ seconds: 0, specs: [] }));
for (const pack of packages.sort((a, b) => secondsOf(b) - secondsOf(a))) {
  const cheapest = bins.reduce((lowest, bin) => (bin.seconds < lowest.seconds ? bin : lowest), bins[0]);
  cheapest.specs.push(...pack);
  cheapest.seconds += secondsOf(pack);
}

// A pinned file is whole, so it sits on exactly one shard.
const binOf = (name) => bins.findIndex((bin) => bin.specs.some((unit) => unit.key.startsWith(`${name}:`)));
for (let pass = 0; pass < SHARD_COUNT; pass++) {
  let moved = false;
  for (const sensitive of assertsWholeList) {
    const home = binOf(sensitive);
    if (home === -1) continue;
    const awkward = leavesWaitingChat.filter((name) => name !== sensitive && binOf(name) === home);
    if (!awkward.length) continue;
    const blocked = leavesWaitingChat.map(binOf);
    const target = bins
      .map((bin, i) => i)
      .filter((i) => !blocked.includes(i))
      .sort((x, y) => bins[x].seconds - bins[y].seconds)[0];
    if (target === undefined) throw new Error(`no shard left for ${sensitive}: too many files must stay apart`);
    const unitsOf = bins[home].specs.filter((unit) => unit.key.startsWith(`${sensitive}:`));
    bins[home].specs = bins[home].specs.filter((unit) => !unitsOf.includes(unit));
    bins[home].seconds -= secondsOf(unitsOf);
    bins[target].specs.push(...unitsOf);
    bins[target].seconds += secondsOf(unitsOf);
    moved = true;
  }
  if (!moved) break;
}
const files = {};
for (const name of specFiles) {
  files[name] = createHash("sha256").update(readFileSync(path.join(e2eDir, name))).digest("hex").slice(0, 16);
}

const table = {
  note: "Generated by `npm run e2e:shards` from a `test:e2e:fast` run; see docs/testing.md. A file whose hash is not the recorded one runs whole on the cheapest shard.",
  files,
  shards: bins.map((bin) => ({
    seconds: Math.round(bin.seconds),
    tests: bin.specs
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((unit) => unit.key),
  })),
};

writeFileSync(tableFile, `${JSON.stringify(table, null, 2)}\n`);

console.log(
  `e2e-shards: ${recorded.length} specs in ${units.size} entries, ${Math.round(totalSeconds)} s of spec time in ${specFiles.length} files -> ` +
    bins.map((bin, i) => `shard ${i + 1} ${Math.round(bin.seconds)} s (${bin.specs.length})`).join(", "),
);
console.log(`e2e-shards: wrote ${path.relative(root, tableFile)}`);
