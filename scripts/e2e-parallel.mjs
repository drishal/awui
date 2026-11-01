// The e2e suite in two halves at once, for the loops that wait on it: one Playwright
// run per shard, each with its own port (globalSetup starts a server per run), its own
// temp state root, and its own output dir, since a run clears its output dir at start
// and two sharing one would erase each other's traces. Both streams are prefixed, and
// the exit is non-zero if either shard fails. Build first (`npm run test:e2e:fast`
// does): both shards serve the same dist.
import { spawn } from "node:child_process";

// Ten apart: a shard's own spec may start a server on the next ports (remote-login does), so leave room.
const shards = [
  { n: 1, port: process.env.AWUI_E2E_PORT_A || "4801" },
  { n: 2, port: process.env.AWUI_E2E_PORT_B || "4811" },
];

const children = shards.map(({ n, port }) => {
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", `--shard=${n}/${shards.length}`, `--output=test-results/shard-${n}`], {
    env: { ...process.env, AWUI_E2E_PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // A line at a time, tagged, so the two shards read as one stream.
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

for (const shard of children) shard.child.on("exit", (code) => (shard.code = code ?? 1));

await Promise.all(children.map(({ child }) => new Promise((done) => child.on("close", done))));

const failed = children.filter((s) => s.code !== 0);
console.log(
  failed.length === 0
    ? `\ne2e: both shards passed (ports ${children.map((s) => s.port).join(", ")})`
    : `\ne2e: shard${failed.length > 1 ? "s" : ""} ${failed.map((s) => `${s.n} (port ${s.port})`).join(", ")} failed`,
);
process.exit(failed.length === 0 ? 0 : 1);
