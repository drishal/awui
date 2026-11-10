import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { E2E_PORT } from "../../playwright.config.js";
import { startFakeHerdr } from "../helpers/fake-herdr.js";

/** Start the built server with fake harnesses on 127.0.0.1 (local use: no sign-in). */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const base = mkdtempSync(path.join(tmpdir(), "awui-e2e-"));
  const root = path.join(base, "workspaces");
  for (const name of ["alpha", "beta", ".hidden-proj"]) mkdirSync(path.join(root, name), { recursive: true });
  // A repository for the git panel's writes (git.spec.ts): one commit, one changed
  // file, one new one. Nothing else in the suite runs in it.
  const gitProject = path.join(root, "gamma");
  mkdirSync(gitProject, { recursive: true });
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: gitProject, stdio: "ignore" });
  runGit("init", "-q", "-b", "main");
  runGit("config", "user.name", "E2E");
  runGit("config", "user.email", "e2e@example.com");
  writeFileSync(path.join(gitProject, "hello.txt"), "one\n");
  runGit("add", "-A");
  runGit("commit", "-qm", "first");
  writeFileSync(path.join(gitProject, "hello.txt"), "one\ntwo\n");
  writeFileSync(path.join(gitProject, "new.txt"), "new\n");
  // A Markdown file for the viewer's rendered preview (unified.spec.ts).
  writeFileSync(path.join(gitProject, "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(path.join(gitProject, "page.html"), '<!doctype html><h1>Preview</h1><script>document.body.dataset.ran = "1";</script>\n');
  writeFileSync(path.join(gitProject, "notes.md"), "# Notes\n\nSome **bold** words and a [link](https://example.com).\n");
  const themeFile = path.join(base, "theme.yaml");
  copyFileSync(path.join(import.meta.dirname, "..", "fixtures", "themes", "stylix.yaml"), themeFile);
  // A stand-in herdr instead of the developer's: its panes are what a test writes to agents.json, and
  // what it was asked lands in calls.jsonl (herdr.spec.ts).
  const herdrDir = path.join(base, "herdr");
  mkdirSync(herdrDir);
  writeFileSync(path.join(herdrDir, "agents.json"), "[]");
  const herdr = await startFakeHerdr(
    path.join(herdrDir, "herdr.sock"),
    () => JSON.parse(readFileSync(path.join(herdrDir, "agents.json"), "utf8")) as unknown[],
    (call) => appendFileSync(path.join(herdrDir, "calls.jsonl"), `${JSON.stringify(call)}\n`),
  );
  const server: ChildProcess = spawn(process.execPath, ["dist/server/server/index.js"], {
    // Inherit neither caller's git workdir nor /tmp used to drive live live.
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    env: {
      ...process.env,
      HERDR_SOCKET_PATH: path.join(herdrDir, "herdr.sock"),
      AWUI_HERDR: "1",
      // Never pick up the developer's own config.yml (host, login, theme).
      AWUI_CONFIG_DIR: "",
      PORT: String(E2E_PORT),
      AWUI_HARNESSES: "fake,fake-b",
      AWUI_FAKE_DELAY_MS: "30",
      AWUI_HEARTBEAT_MS: "1000",
      WORKSPACE_ROOTS: root,
      XDG_STATE_HOME: path.join(base, "state"),
      THEME_FILE: themeFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/Local: http:\/\/127\.0\.0\.1:\d+\//.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.once("exit", (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
  process.env.AWUI_E2E_ROOT = root;
  process.env.AWUI_E2E_HERDR = herdrDir;
  return async () => {
    await herdr.close();
    if (server.exitCode !== null) return;
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  };
}
