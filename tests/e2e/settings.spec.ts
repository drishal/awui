import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// A localhost server with its own settings folder, so the shared look
// (theme, text size) can be saved to config.yml without signing in.
const PORT = 4794;

async function startServer(): Promise<{ server: ChildProcess; configFile: string; base: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "awui-settings-"));
  const root = path.join(dir, "workspaces");
  mkdirSync(path.join(root, "proj"), { recursive: true });
  const configDir = path.join(dir, "awui");
  mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, "config.yml");
  const env: NodeJS.ProcessEnv = { ...process.env, AWUI_CONFIG_DIR: configDir, AWUI_HARNESSES: "fake", WORKSPACE_ROOTS: root };
  for (const key of ["HOST", "PORT", "AUTH_USERNAME", "AUTH_PASSWORD", "AUTH_CREDENTIALS_FILE", "ALLOWED_HOSTS"]) delete env[key];
  env.PORT = String(PORT);
  env.XDG_STATE_HOME = path.join(dir, "state");
  env.THEME_FILE = path.join(dir, "none.yaml");
  const server = spawn(process.execPath, ["dist/server/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
    const onData = (c: Buffer) => {
      out += c.toString();
      if (out.includes(`Local: http://127.0.0.1:${PORT}/`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.once("exit", (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });
  return { server, configFile, base: `http://127.0.0.1:${PORT}` };
}

test.describe("shared look in config.yml", () => {
  let ctx: { server: ChildProcess; configFile: string; base: string } | null = null;

  test.beforeAll(async () => {
    ctx = await startServer();
  });

  test.afterAll(async () => {
    if (!ctx || ctx.server.exitCode !== null) return;
    const exited = new Promise((r) => ctx?.server.once("exit", r));
    ctx.server.kill("SIGTERM");
    await exited;
  });

  test("theme and text size save to config.yml and apply at once", async ({ page }) => {
    const { base, configFile } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    // No per-device look controls remain: theme and text size live in the server form.
    await expect(settings.getByText("This device")).toBeVisible();
    await settings.getByRole("button", { name: "Theme" }).click();
    await settings.getByRole("listbox", { name: "Theme" }).getByRole("option", { name: "Dark" }).click();
    const slider = settings.getByRole("slider", { name: "Chat text size" });
    await slider.fill("1.22");
    await expect(settings.getByText("122%", { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    const file = readFileSync(configFile, "utf8");
    expect(file).toContain("theme: dark");
    expect(file).toContain("text_scale: 1.22");
    // Applies here at once: dark background without a reload.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    await settings.getByRole("button", { name: "Close" }).click();
    // And on the next page load, including the text scale.
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    const scale = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chat-scale").trim());
    expect(scale).toBe("1.22");
  });

  test("density compact sets the attribute, tightens a session row, and comes back on reload", async ({ page }) => {
    const { base, configFile } = ctx as NonNullable<typeof ctx>;
    // One session for the sidebar to draw, made through the API (this server has its own project folder).
    const project = path.join(path.dirname(path.dirname(configFile)), "workspaces", "proj");
    const opened = await page.request.post(`${base}/api/workspaces/open`, { data: { path: project } });
    const workspaceId = ((await opened.json()) as { id: string }).id;
    const created = await page.request.post(`${base}/api/chats`, { data: { harnessId: "fake", workspaceId } });
    const chatId = (JSON.parse(await created.text()) as { chatId: string }).chatId;
    await page.request.post(`${base}/api/chats/${chatId}/messages`, { data: { text: "density probe", mode: "normal" } });

    await page.goto(`${base}/`);
    const row = page.locator(".session", { hasText: "density probe" }).first();
    await expect(row).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-density", "compact");
    const comfortable = (await row.boundingBox())?.height ?? 0;
    expect(comfortable).toBeGreaterThanOrEqual(34);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("group", { name: "Density" }).getByRole("button", { name: "Compact" }).click();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).toContain("density: compact");
    // Applies at once, without a reload.
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await settings.getByRole("button", { name: "Close" }).click();
    await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeLessThan(comfortable);

    // And on the next page load.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await expect.poll(async () => (await page.locator(".session", { hasText: "density probe" }).first().boundingBox())?.height ?? 0).toBeLessThan(comfortable);

    // Back to comfortable leaves no setting behind.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await settings.getByRole("group", { name: "Density" }).getByRole("button", { name: "Comfortable" }).click();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).not.toContain("density");
    await expect(page.locator("html")).not.toHaveAttribute("data-density", "compact");
  });
});
