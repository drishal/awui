import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openSettings, showSidebar } from "./helpers.js";

// The theme library on a server of its own: its config folder holds two
// schemes, and the picks land in its config.yml, so the shared server's look
// is never touched. One port past the settings spec's.
const PORT = Number(process.env.AWUI_E2E_PORT ?? 4791) + 3;

const scheme = (name: string, variant: "dark" | "light", hexes: string[]) =>
  [`system: "base16"`, `name: "${name}"`, `variant: "${variant}"`, "palette:", ...hexes.map((h, i) => `  base0${i.toString(16).toUpperCase()}: "#${h}"`)].join("\n") + "\n";
const GRUVBOX = scheme("Gruvbox Dark", "dark", ["282828", "3c3836", "504945", "665c54", "bdae93", "d5c4a1", "ebdbb2", "fbf1c7", "fb4934", "fe8019", "fabd2f", "b8bb26", "8ec07c", "83a598", "d3869b", "d65d0e"]);
const SOLARIZED = scheme("Solarized Light", "light", ["fdf6e3", "eee8d5", "93a1a1", "839496", "657b83", "586e75", "073642", "002b36", "dc322f", "cb4b16", "b58900", "859900", "2aa198", "268bd2", "6c71c4", "d33682"]);
const NORD = scheme("Nord Test", "dark", ["2e3440", "3b4252", "434c5e", "4c566a", "d8dee9", "e5e9f0", "eceff4", "8fbcbb", "bf616a", "d08770", "ebcb8b", "a3be8c", "88c0d0", "81a1c1", "b48ead", "5e81ac"]);

let ctx: { server: ChildProcess; configFile: string; themes: string; base: string } | null = null;

test.beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "awui-themes-"));
  const root = path.join(dir, "workspaces");
  mkdirSync(path.join(root, "proj"), { recursive: true });
  const configDir = path.join(dir, "awui");
  const themes = path.join(configDir, "themes");
  mkdirSync(themes, { recursive: true });
  writeFileSync(path.join(themes, "gruvbox-dark.yml"), GRUVBOX);
  writeFileSync(path.join(themes, "solarized-light.yml"), SOLARIZED);
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
  ctx = { server, configFile: path.join(configDir, "config.yml"), themes, base: `http://127.0.0.1:${PORT}` };
});

test.afterAll(async () => {
  if (!ctx || ctx.server.exitCode !== null) return;
  const exited = new Promise((r) => ctx?.server.once("exit", r));
  ctx.server.kill("SIGTERM");
  await exited;
});

const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const config = () => (existsSync((ctx as NonNullable<typeof ctx>).configFile) ? readFileSync((ctx as NonNullable<typeof ctx>).configFile, "utf8") : "");

/** Each test starts from the same look: the built-in System theme. */
async function start(page: Page): Promise<void> {
  const { base } = ctx as NonNullable<typeof ctx>;
  await page.request.put(`${base}/api/settings`, { data: { theme: "system", themeScheme: null } });
  await page.goto(`${base}/`);
  await showSidebar(page);
}

test("the theme menu previews a scheme while pointed at, and saves the one chosen to config.yml", async ({ page }) => {
  await start(page);
  const plain = await background(page);
  const trigger = page.getByRole("button", { name: "Theme: System" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Theme" });
  await expect(menu.getByRole("menuitemradio", { name: /System/ })).toHaveAttribute("aria-checked", "true");

  // Pointing previews it on the whole page; leaving the list puts the current one back.
  await menu.getByRole("menuitemradio", { name: "Gruvbox Dark" }).hover();
  await expect.poll(() => background(page)).toBe("rgb(40, 40, 40)");
  await page.mouse.move(900, 600);
  await expect.poll(() => background(page)).toBe(plain);

  // The arrows preview too, and Escape takes it back.
  await menu.getByRole("menuitemradio", { name: "Gruvbox Dark" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Solarized Light" })).toBeFocused();
  await expect.poll(() => background(page)).toBe("rgb(253, 246, 227)");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect.poll(() => background(page)).toBe(plain);

  await trigger.click();
  await menu.getByRole("menuitemradio", { name: "Gruvbox Dark" }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "Theme: Gruvbox Dark" })).toBeVisible();
  await expect.poll(config).toContain("theme_scheme: gruvbox-dark");
  expect(config()).toContain("theme: base16");
  await expect.poll(() => background(page)).toBe("rgb(40, 40, 40)");

  // It holds across a reload, and a built-in goes back to the bare mode.
  await page.reload();
  await expect(page.getByRole("button", { name: "Theme: Gruvbox Dark" })).toBeVisible();
  await expect.poll(() => background(page)).toBe("rgb(40, 40, 40)");
  await page.getByRole("button", { name: "Theme: Gruvbox Dark" }).click();
  await menu.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await expect(page.getByRole("button", { name: "Theme: Light" })).toBeVisible();
  await expect.poll(config).toContain("theme: light");
  await expect.poll(() => background(page)).toBe("rgb(242, 243, 246)");
});

test("the command palette switches theme, previewing the highlighted one", async ({ page }) => {
  await start(page);
  const plain = await background(page);
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "Search commands and sessions" });
  await search.fill("theme solarized");
  await expect.poll(() => background(page)).toBe("rgb(253, 246, 227)");
  // Closing without choosing leaves the page as it was.
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect.poll(() => background(page)).toBe(plain);

  await page.keyboard.press("Control+k");
  await search.fill("theme solarized");
  await page.keyboard.press("Enter");
  await expect.poll(config).toContain("theme_scheme: solarized-light");
  await expect(page.getByRole("button", { name: "Theme: Solarized Light" })).toBeVisible();
  await expect.poll(() => background(page)).toBe("rgb(253, 246, 227)");
});

test("Settings uploads, makes, edits, and deletes a theme, and Undo brings a deleted one back", async ({ page }) => {
  const { base, themes } = ctx as NonNullable<typeof ctx>;
  await start(page);
  // The theme in use cannot be deleted.
  await page.request.put(`${base}/api/settings`, { data: { theme: "base16", themeScheme: "gruvbox-dark" } });
  await page.reload();
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  const cards = settings.getByRole("radiogroup", { name: "Schemes" });
  await expect(cards.getByRole("radio", { name: "Gruvbox Dark" })).toHaveAttribute("aria-checked", "true");
  await expect(settings.getByRole("button", { name: "Delete Gruvbox Dark" })).toBeDisabled();

  // Upload a .yml: it joins the library under a slug of its name.
  await settings.getByLabel("Theme file").setInputFiles({ name: "nord.yml", mimeType: "text/yaml", buffer: Buffer.from(NORD) });
  await expect(cards.getByRole("radio", { name: "Nord Test" })).toBeVisible();
  await expect(settings.getByRole("status").filter({ hasText: "Added" })).toHaveText("Added “Nord Test”.");
  expect(readFileSync(path.join(themes, "nord-test.yml"), "utf8")).toContain("#2e3440");

  // A refused file says why and adds nothing (the count holds theme.yml too, listed as missing here).
  const count = await cards.getByRole("radio").count();
  await settings.getByLabel("Theme file").setInputFiles({ name: "bad.yml", mimeType: "text/yaml", buffer: Buffer.from("name: Broken\npalette:\n  base00: nope\n") });
  await expect(settings.getByRole("alert")).toBeVisible();
  await expect(cards.getByRole("radio")).toHaveCount(count);

  // New theme: the editor, its name and one colour by hex.
  await settings.getByRole("button", { name: "New theme" }).click();
  const editor = page.getByRole("dialog", { name: "New theme" });
  await editor.getByLabel("Name").fill("Made Here");
  await editor.getByLabel("base00 hex").fill("#102030");
  await editor.getByRole("button", { name: "Save theme" }).click();
  await expect(editor).toBeHidden();
  await expect(cards.getByRole("radio", { name: "Made Here" })).toBeVisible();
  expect(readFileSync(path.join(themes, "made-here.yml"), "utf8")).toContain("#102030");

  // Edit writes the same file.
  await settings.getByRole("button", { name: "Edit Made Here" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Made Here" });
  await expect(edit.getByLabel("base00 hex")).toHaveValue("#102030");
  await edit.getByLabel("base00 hex").fill("#203040");
  await edit.getByRole("button", { name: "Save theme" }).click();
  await expect(edit).toBeHidden();
  expect(readFileSync(path.join(themes, "made-here.yml"), "utf8")).toContain("#203040");

  // Delete, then Undo puts the same file back under the same id.
  await settings.getByRole("button", { name: "Delete Made Here" }).click();
  await expect(cards.getByRole("radio", { name: "Made Here" })).toBeHidden();
  expect(existsSync(path.join(themes, "made-here.yml"))).toBe(false);
  await settings.getByRole("button", { name: "Undo" }).click();
  await expect(cards.getByRole("radio", { name: "Made Here" })).toBeVisible();
  expect(readFileSync(path.join(themes, "made-here.yml"), "utf8")).toContain("#203040");

  // Choosing a card is part of the form, saved with its one Save.
  await cards.getByRole("radio", { name: "Nord Test" }).click();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
  expect(config()).toContain("theme_scheme: nord-test");
  await expect.poll(() => background(page)).toBe("rgb(46, 52, 64)");
});
