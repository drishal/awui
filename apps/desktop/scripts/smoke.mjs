// A headless check of the desktop app's whole contract with the server: it
// starts one when none is running, attaches to one that is, and quitting stops
// exactly the server it started. Playwright drives the real Electron binary, so
// this is the app as a person runs it, not a stand-in.
//
//   cd apps/desktop && npm run smoke        (needs a display, or Xvfb :99)
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const electronPath = createRequire(import.meta.url)("electron");
const binary = path.join(repo, "dist", "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "awui.exe" : "awui");

let failures = 0;
function check(what, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Poll until `probe` answers truthy, or the deadline passes. */
async function until(probe, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

const health = async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
  return res.ok ? await res.json() : null;
};

/** True when nothing answers on the port — a refused connection is the answer we want. */
const down = async (port) => {
  try {
    await health(port);
    return false;
  } catch {
    return true;
  }
};

/** Launch the app against `port` with a throwaway state folder, and hand back the window. */
async function launch(port, stateDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [appDir, "--no-sandbox", "--disable-gpu"],
    cwd: appDir,
    env: {
      ...process.env,
      AWUI_DESKTOP_PORT: String(port),
      // One throwaway home for both sides: the app's Electron profile and the
      // server's state folder, so a run never touches the real ones.
      XDG_STATE_HOME: stateDir,
      AWUI_CONFIG_DIR: "",
      AWUI_HARNESSES: "fake",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { app, page, errors };
}

/** Quit the way a person does — the app's own quit path, not a kill. */
async function quit(app) {
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await app.close().catch(() => {});
}

/** The window really is awui: the served bundle, mounted, themed, on this server. */
async function checkWindow(app, page, errors, port) {
  const url = page.url();
  check("the window opened the local server", url.startsWith(`http://127.0.0.1:${port}/`), url);
  const mounted = await until(() => page.evaluate(() => (document.querySelector("#root")?.children.length ?? 0) > 0), 20_000);
  check("the app mounted", mounted === true);
  // Its first line is "Connecting to the server"; a booted app has left that behind.
  const booted = await until(() => page.evaluate(() => document.body.innerText.length > 40 && !document.body.innerText.startsWith("Connecting")), 20_000);
  check("the app reached its start screen", booted === true);
  const shape = await page.evaluate(() => ({
    title: document.title,
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    nodes: document.querySelectorAll("body *").length,
    text: document.body.innerText.length,
    sample: document.body.innerText.slice(0, 120),
  }));
  check("the title is awui's", shape.title.includes("awui"), shape.title);
  check("the theme tokens arrived", shape.bg.length > 0, shape.bg);
  check("the page has content", shape.nodes > 50 && shape.text > 10, `${shape.nodes} nodes, ${shape.text} chars${shape.nodes > 50 ? "" : `: ${JSON.stringify(shape.sample)}`}`);
  check("no page errors", errors.length === 0, errors.join("; "));
  // The window is the app: no File/View/Window row. macOS keeps its menu in the
  // system bar, where isMenuBarVisible is always true, so only the others assert.
  if (process.platform !== "darwin") {
    const bars = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isMenuBarVisible()));
    check("no menu bar over the window", bars.every((visible) => visible === false), JSON.stringify(bars));
  }
}

async function main() {
  if (!(await until(() => import("node:fs").then((fs) => fs.existsSync(binary)), 1))) throw new Error(`no built binary at ${binary}; run \`bun run scripts/build-binary.ts\` first`);

  // 1. No server: the app starts one, opens it, and stops it on quit.
  const stateA = await mkdtemp(path.join(os.tmpdir(), "awui-desktop-a-"));
  const portA = 4799;
  const a = await launch(portA, stateA);
  const started = await until(() => health(portA), 25_000);
  check("it started a server when none was running", started?.ok === true);
  await checkWindow(a.app, a.page, a.errors, portA);
  await quit(a.app);
  const gone = await until(() => down(portA), 10_000);
  check("quitting stopped the server it started", gone === true);
  await rm(stateA, { recursive: true, force: true });

  // 2. A server already running: the app attaches, and quitting leaves it alone.
  const stateB = await mkdtemp(path.join(os.tmpdir(), "awui-desktop-b-"));
  const portB = 4801;
  const server = spawn(binary, ["--port", String(portB)], {
    env: { ...process.env, XDG_STATE_HOME: stateB, AWUI_CONFIG_DIR: "", AWUI_HARNESSES: "fake" },
    stdio: "ignore",
  });
  try {
    const up = await until(() => health(portB), 25_000);
    check("a server answers before the app opens", up?.ok === true);
    const b = await launch(portB, stateB);
    await checkWindow(b.app, b.page, b.errors, portB);
    await quit(b.app);
    const still = await until(() => health(portB), 5_000);
    check("quitting left the server it attached to running", still?.ok === true);
  } finally {
    server.kill("SIGTERM");
    await until(() => down(portB), 10_000);
    await rm(stateB, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
