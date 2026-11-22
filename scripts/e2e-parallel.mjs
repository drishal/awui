// The e2e suite in four parts at once, for the loops that wait on it: one Playwright
// run per shard, each with its own port (globalSetup starts a server per run), its own
// temp state root, and its own output dir, since a run clears its output dir at start
// and two sharing one would erase each other's traces. Every stream is prefixed, and
// the exit is non-zero if any shard fails. Build first (`npm run test:e2e:fast`
// does): all four shards serve the same dist.
//
// What each shard runs comes from `tests/e2e/shards.json`, the cost-balanced table
// `npm run e2e:shards` writes: Playwright's own `--shard=N/4` splits by test count,
// and app.spec.ts alone is more than a quarter of the suite's time, so that split
// always leaves one shard far behind. A table that no longer matches the specs on
// disk is ignored whole — every shard then takes `--shard=N/4`, which runs every
// test — and so is a missing one. Each shard writes
// test-results/shard-N/report.json, the durations the next table is built from.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Ten apart: a shard's own spec may start a server on the next ports (remote-login does), so leave room.
const shards = [
  { n: 1, port: process.env.AWUI_E2E_PORT_A || "4801" },
  { n: 2, port: process.env.AWUI_E2E_PORT_B || "4811" },
  { n: 3, port: process.env.AWUI_E2E_PORT_C || "4821" },
  { n: 4, port: process.env.AWUI_E2E_PORT_D || "4831" },
];

const root = path.resolve(import.meta.dirname, "..");
const e2eDir = path.join(root, "tests/e2e");

const specFiles = () => readdirSync(e2eDir).filter((name) => name.endsWith(".spec.ts"));
const hashOf = (name) => createHash("sha256").update(readFileSync(path.join(e2eDir, name))).digest("hex").slice(0, 16);

/**
 * The Playwright arguments each shard runs with, from the checked-in table: an entry is
 * `app.spec.ts:1005` for one test or `tabs.spec.ts` for a whole file. Returns a reason
 * instead when the table cannot be trusted, and the caller falls back to `--shard=N/4`.
 */
function plan() {
  let table;
  try {
    table = JSON.parse(readFileSync(path.join(e2eDir, "shards.json"), "utf8"));
  } catch {
    return { reason: "no readable tests/e2e/shards.json" };
  }
  const files = specFiles();
  // A file that changed, or that the table never saw, could have moved its tests under
  // their recorded lines. Counting shards then runs everything, at the old speed.
  const changed = files.filter((name) => table.files?.[name] !== hashOf(name));
  if (changed.length) {
    const named = changed.slice(0, 3).join(", ") + (changed.length > 3 ? `, +${changed.length - 3} more` : "");
    return { reason: `${named} changed since tests/e2e/shards.json was written` };
  }
  const lists = (table.shards ?? []).map((shard) => (shard.tests ?? []).map((test) => `tests/e2e/${test}`));
  if (lists.length !== shards.length || lists.some((list) => list.length === 0)) {
    return { reason: "tests/e2e/shards.json does not name four non-empty shards" };
  }
  const seconds = (table.shards ?? []).map((shard) => shard.seconds).join("/");
  return { lists, seconds };
}

const planned = plan();

const children = shards.map(({ n, port }) => {
  const args = planned.lists
    ? planned.lists[n - 1]
    : [`--shard=${n}/${shards.length}`];
  const output = `test-results/shard-${n}`;
  mkdirSync(path.join(root, output), { recursive: true });
  const child = spawn(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", ...args, "--reporter=list,json", `--output=${output}`],
    {
      env: {
        ...process.env,
        AWUI_E2E_PORT: port,
        // Read by the json reporter, which resolves it against the repo root.
        PLAYWRIGHT_JSON_OUTPUT_NAME: `${output}/report.json`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // A line at a time, tagged, so the four shards read as one stream.
  const tag = `[${n}] `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(`${tag}${line}\n`);
    });
    stream.on("end", () => {
      if (rest) process.stdout.write(`${tag}${rest}\n`);
    });
  }
  return { n, port, child, code: null };
});

console.log(
  planned.lists
    ? `e2e: ${planned.seconds} s of spec time per shard, from tests/e2e/shards.json`
    : `e2e: ${planned.reason}; sharding by test count until it is regenerated (npm run e2e:shards)`,
);

for (const shard of children) shard.child.on("exit", (code) => (shard.code = code ?? 1));

await Promise.all(children.map(({ child }) => new Promise((done) => child.on("close", done))));

const failed = children.filter((s) => s.code !== 0);
console.log(
  failed.length === 0
    ? `\ne2e: all ${children.length} shards passed (ports ${children.map((s) => s.port).join(", ")})`
    : `\ne2e: shard${failed.length > 1 ? "s" : ""} ${failed.map((s) => `${s.n} (port ${s.port})`).join(", ")} failed`,
);
process.exit(failed.length === 0 ? 0 : 1);
