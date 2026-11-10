#!/usr/bin/env node
// A foreground fixture standing in only for a child exec: its own PID/starter
// state identifies it to runDesktop's real owner coordinator. A SIGUSR1 records
// activation; counts happen at the exec boundary, not by screenshot inference.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = process.env.AWUI_TEST_DESKTOP_PROFILE;
if (!directory) throw new Error("missing test profile");
function startTime(stat) { return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null; }
const started = startTime(await readFile("/proc/self/stat", "utf8"));

async function publish() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `owner.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({ pid: process.pid, started }), { mode: 0o600 });
  await rename(temporary, path.join(directory, "owner.json"));
}
if (process.env.AWUI_TEST_DESKTOP_DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.AWUI_TEST_DESKTOP_DELAY)));
try {
  const previous = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
  if (previous.pid !== process.pid) {
    process.kill(previous.pid, 0);
    const old = startTime(await readFile(`/proc/${previous.pid}/stat`, "utf8"));
    if (old === previous.started) {
      await appendFile(path.join(dirname(), "focus.jsonl"), JSON.stringify({ pid: previous.pid, link: "native" }) + "\n");
      // Native direct-launch arbitration keeps the earlier window in the default case.
      process.exit(0);
    }
  }
} catch {
  // No valid owner record yet: this is the first candidate.
}
await appendFile(path.join(directory, "spawns"), `${process.pid}\n`);
await publish();
process.on("SIGUSR1", () => {
  void appendFile(path.join(directory, "focus.jsonl"), JSON.stringify({ pid: process.pid }) + "\n");
});
process.on("SIGTERM", () => process.exit(0));
function dirname() { return directory; }
// The timeout belongs to this fixture so failed assertions cannot leak an idle process.
setTimeout(() => process.exit(0), 60000).unref();
// Wait through a timer scoped by Promise: keeps a stdio-ignored detached fixture
// alive exactly like the window-bearing desktop process being represented here.
await new Promise((resolve) => setTimeout(resolve, 60000));
