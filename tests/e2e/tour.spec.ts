// The guided reader with real HTTP, a real browser, and a controlled `gh` process.
// Its isolated server/repo/head record prevents test ports or the developer's
// configured credentials becoming evidence for a feature they did not perform.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const port = (Number(process.env.AWUI_E2E_PORT) || 4791) + 5;
const base = `http://127.0.0.1:${port}`;
const root = mkdtempSync(path.join(tmpdir(), "awui-tour-e2e-"));
const project = path.join(root, "alpha");
const recordPath = path.join(root, "pr.json");
const original = {
  title: "Ordered auth work",
  url: "https://github.com/acme/repo/pull/42",
  head: "a01cdef",
  diff: [
    "diff --git a/tsconfig.json b/tsconfig.json",
    "--- a/tsconfig.json",
    "+++ b/tsconfig.json",
    "@@ -0,0 +1 @@",
    "+es2025",
    "diff --git a/dist/core.js b/dist/core.js",
    "--- a/dist/core.js",
    "+++ b/dist/core.js",
    "@@ -0,0 +1 @@",
    "+compiled();",
    "diff --git a/tests/core.spec.ts b/tests/core.spec.ts",
    "--- a/tests/core.spec.ts",
    "+++ b/tests/core.spec.ts",
    "@@ -0,0 +1 @@",
    "+expect(check()).toBe(true);",
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -0,0 +1 @@",
    "+{}",
    "diff --git a/src/core.ts b/src/core.ts",
    "--- a/src/core.ts",
    "+++ b/src/core.ts",
    "@@ -0,0 +1 @@",
    "+export function check() { return verify(); }",
    "",
  ].join("\n"),
};

function save(value: unknown) {
  const temporary = `${recordPath}.next`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, recordPath);
}

let server: ChildProcess | null = null;

test.beforeAll(() => {
  save(original);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project });
  mkdirSync(path.join(root, "gh-bin"), { recursive: true });
  const gh = path.join(root, "gh-bin", "gh");
  execFileSync("cp", [path.resolve(import.meta.dirname, "../fixtures/fake-review-gh"), gh]);
  execFileSync("chmod", ["755", gh]);
  mkdirSync(project, { recursive: true });
  git("init", "-q", "-b", "tour");
  git("config", "user.name", "E2E");
  git("config", "user.email", "e2e@example.com");
  writeFileSync(path.join(project, "README.md"), "# PR tour\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "start");
  git("remote", "add", "origin", "https://github.com/acme/repo.git");
  const running = spawn(process.execPath, ["dist/server/server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      AWUI_CONFIG_DIR: "",
      AWUI_HARNESSES: "fake",
      AWUI_TEST_PR_FIXTURE: recordPath,
      WORKSPACE_ROOTS: project,
      XDG_STATE_HOME: path.join(root, "state"),
      PORT: String(port),
      PATH: `${path.join(root, "gh-bin")}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = running;
  let output = "";
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tour fixture did not start: ${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`Local: http://127.0.0.1:${port}/`)) { clearTimeout(timer); resolve(); }
    };
    running.stdout?.on("data", onData);
    running.stderr?.on("data", onData);
    running.once("exit", (code) => reject(new Error(`tour fixture exited (${code}): ${output}`)));
  });
});

test.afterAll(() => {
  if (!server || server.exitCode !== null) return;
  const running: ChildProcess = server;
  const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
  running.kill("SIGTERM");
  return exited;
});

test("walk every PR file in reading order and consciously rewrite a moved-head guide", async ({ page, request }) => {
  const workspace = (await (await request.post(`${base}/api/workspaces/open`, { data: { path: project } })).json()) as { id: string };
  const chat = (await (await request.post(`${base}/api/chats`, { data: { harnessId: "fake", workspaceId: workspace.id } })).json()) as { chatId: string };
  await page.goto(`${base}/#chat=${chat.chatId}`);
  await page.getByRole("button", { name: "GitHub and pull requests" }).click();
  await page.getByRole("button", { name: "Guided PR tour", exact: true }).click();
  await expect(page.getByRole("region", { name: "Review guide for pull request 42" })).toBeVisible();
  await expect(page.locator(".tour-step strong")).toHaveText("src/core.ts");
  await expect(page.getByText("export function check() { return verify(); }", { exact: false })).toBeVisible();
  for (const file of ["tests/core.spec.ts", "dist/core.js", "package-lock.json", "tsconfig.json"]) {
    await page.getByRole("button", { name: "Next file", exact: true }).click();
    await expect(page.locator(".tour-step strong")).toHaveText(file);
  }
  await expect(page.getByRole("button", { name: "Next file", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Previous file", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Previous file", exact: true }).click();
  await expect(page.locator(".tour-step strong")).toHaveText("package-lock.json");
  save({ ...original, head: "b36ffda", diff: original.diff.replace("verify()", "verifyCurrent()") });
  // The original view is still saved until regenerated. Merely revisiting it warns.
  await page.getByRole("button", { name: "Back to pull request" }).click();
  await page.getByRole("button", { name: "Guided PR tour", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The PR has changed since this guide was made.");
  await expect(page.locator(".tour-step strong")).toHaveText("src/core.ts");
  await page.getByRole("button", { name: "Rebuild from current PR" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".tour-step strong")).toHaveText("src/core.ts");
  await expect(page.getByText("verifyCurrent()", { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Next file", exact: true }).click();
  await expect(page.locator(".tour-step strong")).toHaveText("tests/core.spec.ts");
  await expect(page.getByRole("button", { name: "Back to pull request", exact: true })).toBeVisible();
});
