// Start the exact executable electron-builder places beside resources/, with
// no repository to borrow node_modules from. Missing provider dependencies fail
// here before the app opens useless startup dialogs on a user's host machine.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources");
const exe = path.join(resources, process.platform === "win32" ? "awui.exe" : "awui");
const env = { ...process.env, AWUI_CONFIG_DIR: "", AWUI_HARNESSES: "fake", XDG_STATE_HOME: await mkdtemp(path.join(os.tmpdir(), "awui-packaged-start-")) };
const child = spawn(exe, ["--port", "4921"], { cwd: os.tmpdir(), env, stdio: "pipe" });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const timeout = setTimeout(() => { throw new Error(`staged server did not answer within 15s:\n${output}`); }, 15000);
try {
  for (;;) {
    const health = await fetch("http://127.0.0.1:4921/api/health").then((response) => response.json()).catch(() => null);
    if (health?.ok === true) break;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`staged server exited during startup:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log("staged packaged server starts using its own sibling dependencies");
} finally {
  clearTimeout(timeout);
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  await rm(env.XDG_STATE_HOME, { recursive: true, force: true });
}
