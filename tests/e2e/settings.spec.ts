import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { openSettings } from "./helpers.js";

// A localhost server with its own settings folder, so the shared look
// (theme, text size) can be saved to config.yml without signing in.
const PORT = Number(process.env.AWUI_E2E_PORT ?? 4791) + 1;

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

  /** Open a section of the two-pane dialog: the rail on the left is its list. */
  const openSection = (settings: Locator, name: string) => settings.getByRole("tab", { name, exact: true }).click();

  test("theme and text size save to config.yml and apply at once", async ({ page }) => {
    const { base, configFile } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    // No per-device look controls remain: theme and text size live in the server form.
    await expect(settings.getByRole("tab", { name: "This device", exact: true })).toHaveAttribute("aria-selected", "true");
    await openSection(settings, "Appearance");
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

  test("the desktop app's background switch saves desktop_background to config.yml", async ({ page }) => {
    const { base, configFile } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await openSection(settings, "Desktop app");
    const keep = settings.getByRole("switch", { name: "Keep running in the background" });
    await expect(keep).toBeChecked();
    await keep.click();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).toContain("desktop_background: false");
    await expect(keep).not.toBeChecked();
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
    await openSection(settings, "Appearance");
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
    await openSection(settings, "Appearance");
    await settings.getByRole("group", { name: "Density" }).getByRole("button", { name: "Comfortable" }).click();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).not.toContain("density");
    await expect(page.locator("html")).not.toHaveAttribute("data-density", "compact");
  });

  test("tool_style lines draws a run flat, keeps the folds, and leaves no setting behind", async ({ page }) => {
    const { base, configFile } = ctx as NonNullable<typeof ctx>;
    // A finished run of calls to look at, made through the API.
    const project = path.join(path.dirname(path.dirname(configFile)), "workspaces", "proj");
    const opened = await page.request.post(`${base}/api/workspaces/open`, { data: { path: project } });
    const workspaceId = ((await opened.json()) as { id: string }).id;
    const created = await page.request.post(`${base}/api/chats`, { data: { harnessId: "fake", workspaceId } });
    const chatId = (JSON.parse(await created.text()) as { chatId: string }).chatId;
    await page.request.post(`${base}/api/chats/${chatId}/messages`, { data: { text: "showcase", mode: "normal" } });

    await page.goto(`${base}/#chat=${chatId}`);
    const toggle = page.getByTestId("process-toggle").last();
    // Cards are the default: an icon stack and "Used N tools".
    await expect(toggle).toContainText("Used 9 tools");
    await expect(toggle.getByTestId("kind-stack")).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await openSection(settings, "Appearance");
    const row = settings.getByRole("group", { name: "Tool calls" });
    await expect(row.getByRole("button", { name: "Cards" })).toHaveAttribute("aria-pressed", "true");
    await row.getByRole("button", { name: "Lines" }).click();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).toContain("tool_style: lines");
    await settings.getByRole("button", { name: "Close" }).click();

    // Applies at once: no card surface, no icon stack, and the run's counts in words.
    await expect(page.locator("html")).toHaveAttribute("data-tool-style", "lines");
    await expect(toggle).not.toContainText("Used");
    await expect(toggle).toContainText(/^Worked for \d+s · /);
    await expect(page.getByTestId("kind-stack")).toHaveCount(0);
    await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    // The finished turn still starts folded, opens with the same rows, and the icon is bare.
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-tool="bash"] .tool-sentence')).toHaveText("Ran npm test -- --run tool-diff");
    await expect(page.locator(".kind-chip")).toHaveCount(0);
    // The old line's reading order: the facts follow the words instead of being pushed to the edge.
    const grepRow = page.locator('[data-tool="grep"]');
    const grepBox = (await grepRow.boundingBox()) ?? { x: 0, width: 0, y: 0, height: 0 };
    const factsBox = (await grepRow.locator(".tool-facts").boundingBox()) ?? { x: 0, width: 0, y: 0, height: 0 };
    expect(factsBox.x).toBeLessThan(grepBox.x + grepBox.width / 2);

    // A thought and a call share the header's edges: the icon column, the words, and the chevron.
    await page.request.post(`${base}/api/chats/${chatId}/messages`, { data: { text: "widethought", mode: "normal" } });
    const fold = page.getByTestId("process-toggle").last();
    await expect(fold).toContainText(/command/);
    if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    const thought = page.getByTestId("thought-row").last();
    const call = page.locator('[data-tool="bash"]').last();
    await expect(thought).toContainText("Thought");
    await expect(call.locator(".tool-sentence")).toContainText("udevadm");
    const box = async (locator: ReturnType<typeof fold.locator>) => {
      const b = await locator.boundingBox();
      expect(b, locator.toString()).toBeTruthy();
      return b as { x: number; y: number; width: number; height: number };
    };
    const [label, thoughtLead, thoughtTitle, toolLead, sentence, headChevron, toolChevron] = await Promise.all([
      box(fold.locator(".process-label")),
      box(thought.locator(".drow-lead")),
      box(thought.locator(".drow-title")),
      box(call.locator(".tool-plain-lead")),
      box(call.locator(".tool-sentence")),
      box(fold.locator(".process-chevron")),
      box(call.locator(".tool-chevron")),
    ]);
    expect(Math.abs(label.x - thoughtLead.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(thoughtLead.x - toolLead.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(thoughtTitle.x - sentence.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(headChevron.x + headChevron.width - (toolChevron.x + toolChevron.width))).toBeLessThanOrEqual(1);
    // And on the next page load.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-tool-style", "lines");

    // Back to cards leaves no setting behind.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await openSection(settings, "Appearance");
    await settings.getByRole("group", { name: "Tool calls" }).getByRole("button", { name: "Cards" }).click();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).not.toContain("tool_style");
    await expect(page.locator("html")).not.toHaveAttribute("data-tool-style", "lines");
  });

  test("sections switch in place, keep an edit made in another one, and save with one Save", async ({ page }) => {
    const { base, configFile } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("tab", { name: "This device", exact: true })).toHaveAttribute("aria-selected", "true");
    await openSection(settings, "Appearance");
    await settings.getByRole("button", { name: "Theme" }).click();
    await settings.getByRole("listbox", { name: "Theme" }).getByRole("option", { name: "Light" }).click();
    await expect(settings.getByRole("listbox", { name: "Theme" })).toHaveCount(0);
    await expect(settings.getByText("Unsaved changes")).toBeVisible();
    // Wait for the dialog's one-shot transform before measuring; later panes must not resize it.
    const frame = await settings.boundingBox();
    if (!frame) throw new Error("Settings has no dialog frame to measure");
    await openSection(settings, "Layout");
    await settings.getByRole("switch", { name: "Fold the sidebar away in narrow windows" }).click();
    // The edit made in Appearance is still the form's: one Save writes both.
    await expect(settings.getByText("Unsaved changes")).toBeVisible();
    await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    // Settle the last pane before measuring; clientHeight excludes fractional text-scroll changes.
    await expect.poll(async () => {
      const current = await settings.boundingBox();
      return current ? [current.x, current.y, current.width, current.height].map(Math.round) : null;
    }, { timeout: 15_000 }).toEqual([frame.x, frame.y, frame.width, frame.height].map(Math.round));
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    const file = readFileSync(configFile, "utf8");
    expect(file).toContain("theme: light");
    expect(file).toContain("autocollapse_sidebar: false");
    // Back where it was, and the value held.
    await openSection(settings, "Appearance");
    await expect(settings.getByRole("button", { name: "Theme" })).toContainText("Light");
    await settings.getByRole("button", { name: "Close" }).click();
  });

  test("the search narrows the rail and the rows, and Escape clears it", async ({ page }) => {
    const { base } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    const search = settings.getByRole("searchbox", { name: "Search settings" });
    await search.fill("port");
    // Only the section holding a matching row is left in the rail, and it opens by itself.
    await expect(settings.getByRole("tab")).toHaveCount(1);
    await expect(settings.getByRole("tab", { name: "Network and sign-in" })).toHaveAttribute("aria-selected", "true");
    await expect(settings.getByLabel("Port")).toBeVisible();
    // The rows it filtered out are still there for the next search, but take no room.
    await expect(settings.getByLabel("Username")).toBeHidden();
    // A word from a section's own name keeps the whole section.
    await search.fill("folders");
    await expect(settings.getByRole("tab", { name: "Folders and access" })).toHaveAttribute("aria-selected", "true");
    await expect(settings.getByLabel("Workspace roots")).toBeVisible();
    await expect(settings.getByLabel("Allowed hosts")).toBeVisible();
    // Nothing matched: it says so.
    await search.fill("zebra");
    await expect(settings.getByRole("tab")).toHaveCount(0);
    await expect(settings.getByText("Nothing matches “zebra”.")).toBeVisible();
    // Escape empties the search rather than closing the dialog.
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("tab", { name: "Folders and access" })).toBeVisible();
    await settings.getByRole("button", { name: "Close" }).click();
  });

  test("a setting that waits for a restart says so from any section", async ({ page }) => {
    const { base, configFile } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await openSection(settings, "Network and sign-in");
    await settings.getByLabel("Username").fill("alice");
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).toContain("username: alice");
    // The notice is in the bar under both panes: another section still shows it.
    await openSection(settings, "Appearance");
    await expect(settings.getByText("Saved; takes effect after a restart: username.")).toBeVisible();
    await settings.getByRole("button", { name: "Close" }).click();
  });

  test("?settings=<section> opens Settings on that section", async ({ page }) => {
    const { base } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/?settings=network`);
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("tab", { name: "Network and sign-in" })).toHaveAttribute("aria-selected", "true");
    await expect(settings.getByLabel("Port")).toBeVisible();
    // Read once: the query is gone, so a reload does not open it again.
    expect(page.url()).toBe(`${base}/`);
    await settings.getByRole("button", { name: "Close" }).click();
  });

  test("on a phone the rail is a list, and a section opens with a way back", async ({ page }) => {
    const { base } = ctx as NonNullable<typeof ctx>;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/`);
    // A phone keeps the gear in the drawer.
    await openSettings(page);
    const settings = page.getByRole("dialog", { name: "Settings" });
    // The list first: the sections, and no pane behind them.
    await expect(settings.getByRole("searchbox", { name: "Search settings" })).toBeVisible();
    await expect(settings.getByRole("tab", { name: "Appearance", exact: true })).toBeVisible();
    await expect(settings.getByRole("slider", { name: "Chat text size" })).toBeHidden();
    await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
    // The section, with the way back to the list.
    await expect(settings.getByRole("slider", { name: "Chat text size" })).toBeVisible();
    await expect(settings.getByRole("searchbox", { name: "Search settings" })).toBeHidden();
    await expect(settings.getByRole("button", { name: "Sections" })).toBeVisible();
    // Nothing runs off the side.
    const overflow = await settings.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await settings.getByRole("button", { name: "Sections" }).click();
    await expect(settings.getByRole("searchbox", { name: "Search settings" })).toBeVisible();
    await expect(settings.getByRole("slider", { name: "Chat text size" })).toBeHidden();
    // The Save bar is under the list too, so a phone can always save.
    await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  });

  test("the rail takes the keyboard: Tab reaches it and the arrows move through it", async ({ page }) => {
    const { base } = ctx as NonNullable<typeof ctx>;
    await page.goto(`${base}/`);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("searchbox", { name: "Search settings" }).focus();
    await page.keyboard.press("Tab");
    await expect(settings.getByRole("tab", { name: "This device", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(settings.getByRole("tab", { name: "Appearance", exact: true })).toBeFocused();
    await expect(settings.getByRole("tab", { name: "Appearance", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(settings.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await page.keyboard.press("End");
    await expect(settings.getByRole("tab", { name: "Invitations", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(settings.getByRole("heading", { name: "Invitations" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(settings.getByRole("tab", { name: "This device", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
  });
});
