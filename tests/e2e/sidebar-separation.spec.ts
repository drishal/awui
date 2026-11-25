// Sidebar session rows have to read as separate sessions (t169): a two-line title plus a
// sub-line used to sit almost as close to the next row's title as to its own. The row
// rhythm and the inset hairline are both cheap to lose in a later restyle, so this spec
// measures them rather than reading the stylesheet: adjacent rows are either 2px apart or
// joined by a 1px line, a long title stops at two lines, the time sits on the title's first
// line, and a filled row takes the line off itself and the row under it.
//
// The setting that swaps the rows for the compact ones older versions drew (config.yml's
// `sidebar_style`) is measured the same way: 1px apart, no line, and the clock in the row's
// middle instead of against the title's first line.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

/** A title long enough to take the two lines the clamp allows, in the ~200px sidebar rail. */
const LONG_TITLE = "a session title long enough to want a third line in the two-hundred-pixel sidebar rail, which it must not take";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });
const row = (page: Page, title: string) => sidebar(page).locator(".session-item", { hasText: title });

/** The first date section holding at least `atLeast` rows: only rows inside one group can share a line. */
async function sectionWith(page: Page, atLeast: number): Promise<Locator> {
  const lists = sidebar(page).locator(".session-sublist");
  await expect(lists.first()).toBeVisible();
  for (let i = 0; i < (await lists.count()); i++) {
    const list = lists.nth(i);
    if ((await list.locator(".session-item").count()) >= atLeast) return list;
  }
  throw new Error(`no date section with ${atLeast} session rows`);
}

/** Four chats in the open project: a line needs a neighbour on both sides, and the open row takes one. */
async function fourChats(page: Page): Promise<Locator> {
  await signInAndOpen(page);
  for (const word of ["first", "second", "third", "fourth"]) {
    await newChat(page);
    await sendAndWait(page, `${word} row of the separation check`);
  }
  await showSidebar(page);
  return sectionWith(page, 4);
}

/** A row's own `::before` line as the browser resolves it. */
const lineOf = (session: Locator) =>
  session.evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    // `content` is the only field that says whether the line is drawn at all: a `content: none` rule leaves
    // the height and colour the base rule set, because nothing is painted to use them.
    return { content: s.content, height: Number.parseFloat(s.height), background: s.backgroundColor, opacity: Number(s.opacity) };
  });

const TRANSPARENT = /rgba\(0, 0, 0, 0\)|transparent/;

test("adjacent rows are 2px apart or carry a 1px inset line", async ({ page }) => {
  const section = await fourChats(page);
  const rows = section.locator(".session-item");
  const count = await rows.count();
  for (let i = 1; i < count; i++) {
    const above = await rows.nth(i - 1).boundingBox();
    const below = await rows.nth(i).boundingBox();
    expect(above, "row above has a box").not.toBeNull();
    expect(below, "row below has a box").not.toBeNull();
    const gap = (below as { y: number; height: number }).y - ((above as { y: number; height: number }).y + (above as { height: number }).height);
    if (gap >= 2) continue;
    const line = await lineOf(rows.nth(i).locator(".session"));
    expect(line.height, "rows closer than 2px are joined by a 1px line").toBe(1);
    expect(line.background, "the line is drawn, not transparent").not.toMatch(TRANSPARENT);
  }
});

test("a long title clamps to two lines, and the time sits on the first", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "clamp check");
  await send(page, `/rename ${LONG_TITLE}`);
  await showSidebar(page);

  const title = row(page, "a session title long enough").locator(".session-title");
  await expect(title).toBeVisible();
  const box = await title.evaluate((el) => {
    const s = getComputedStyle(el);
    return { client: el.clientHeight, scroll: el.scrollHeight, line: Number.parseFloat(s.lineHeight) };
  });
  expect(box.line).toBeGreaterThan(0);
  expect(box.scroll, "the title the test wrote is longer than two lines").toBeGreaterThan(box.client);
  expect(box.client, "at most two lines").toBeLessThanOrEqual(2 * box.line + 1);

  // The clock is read against the title it belongs to; centred, it floats between lines.
  const placed = await row(page, "a session title long enough").evaluate((el) => {
    const t = el.querySelector(".session-title")?.getBoundingClientRect();
    const m = el.querySelector(".session-time")?.getBoundingClientRect();
    return t && m ? { title: t.top, time: m.top } : null;
  });
  expect(placed, "the row has a title and a time").not.toBeNull();
  expect(Math.abs((placed as { title: number; time: number }).time - (placed as { title: number }).title)).toBeLessThanOrEqual(3);
});

test("a filled row takes the line off itself and off the row under it", async ({ page }) => {
  const section = await fourChats(page);
  const rows = section.locator(".session-item");
  // The open session's own line and the next row's are hidden on purpose, so take the first row
  // whose line is in place and which has a row under it.
  const count = await rows.count();
  let at = -1;
  for (let i = 1; i < count - 1; i++) {
    if ((await lineOf(rows.nth(i).locator(".session"))).opacity === 1) {
      at = i;
      break;
    }
  }
  expect(at, "a row with its line, and a row under it").toBeGreaterThan(0);
  const second = rows.nth(at).locator(".session");
  const third = rows.nth(at + 1).locator(".session");
  await expect.poll(async () => (await lineOf(second)).opacity).toBe(1);

  await second.hover();
  await expect.poll(async () => (await lineOf(second)).opacity, { message: "the filled row drops its own line" }).toBe(0);
  await expect.poll(async () => (await lineOf(third)).opacity, { message: "so does the row below it" }).toBe(0);

  // Leaving puts both back, so the list is unchanged by a pointer that crossed it.
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await lineOf(third)).opacity).toBe(1);
});

test.describe("on touch", () => {
  test("the divider stays inside the row that swipe clips", async ({ page }) => {
    const section = await fourChats(page);
    // Start desktop so the sessions exist; then make the same media query real as on a touch device.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const second = section.locator(".session-item").nth(1).locator(".session");
    const line = await second.evaluate((el) => {
      const item = el.parentElement?.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el, "::before");
      return item ? { itemTop: item.top, itemHeight: item.height, top: box.top + Number.parseFloat(style.top), height: Number.parseFloat(style.height), background: style.backgroundColor } : null;
    });
    expect(line).not.toBeNull();
    const placed = line as { itemTop: number; itemHeight: number; top: number; height: number; background: string };
    expect(placed.height).toBe(1);
    expect(placed.background).not.toMatch(TRANSPARENT);
    expect(placed.top).toBeGreaterThanOrEqual(placed.itemTop);
    expect(placed.top + placed.height).toBeLessThanOrEqual(placed.itemTop + placed.itemHeight);
  });
});

// The other look a page can choose (config.yml's `sidebar_style: compact`): the tight rows older versions
// drew. The suite's own server has no settings folder, so the attribute is set on <html> here, which is
// exactly what App.tsx does from the setting; saving the setting from the dialog gets its own server.
test.describe("the compact rows", () => {
  test("compact sits rows 1px apart with no divider and centres the clock", async ({ page }) => {
    await signInAndOpen(page);
    await sendAndWait(page, "compact row one");
    await newChat(page);
    await sendAndWait(page, "compact row two");
    // A title long enough for two lines: on one line both looks centre the clock, so the difference only
    // shows where the separated look pins it to the first line of a taller row.
    await send(page, `/rename ${LONG_TITLE}`);
    await showSidebar(page);
    const section = await sectionWith(page, 2);
    const rows = section.locator(".session-item");
    // The suite shares one server and one project, so the section holds other tests' sessions too: the
    // newest two are this test's own.
    const count = await rows.count();
    const top = rows.nth(count - 2);
    const bottom = rows.nth(count - 1);

    await page.evaluate(() => document.documentElement.setAttribute("data-sidebar", "compact"));
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "compact");

    // Tight: the 1px the old rows had, and no hairline to sit in it.
    const above = (await top.boundingBox()) as { y: number; height: number };
    const below = (await bottom.boundingBox()) as { y: number; height: number };
    expect(below.y - (above.y + above.height)).toBe(1);
    const line = await lineOf(bottom.locator(".session"));
    expect(line.content, "compact draws no divider").toBe("none");

    // The clock sits in the row's middle rather than against the title's first line.
    const clock = await row(page, "a session title long enough").locator(".session").evaluate((el) => {
      const box = el.getBoundingClientRect();
      const time = el.querySelector(".session-time")?.getBoundingClientRect();
      const title = el.querySelector(".session-title") as HTMLElement | null;
      return {
        row: box.top + box.height / 2,
        clock: time ? time.top + time.height / 2 : null,
        lines: title ? Math.round(title.clientHeight / Number.parseFloat(getComputedStyle(title).lineHeight)) : 0,
      };
    });
    expect(clock.lines, "the row under test takes two lines").toBe(2);
    expect(clock.clock, "the row has a clock").not.toBeNull();
    expect(Math.abs((clock.clock as number) - clock.row), "the clock is centred with the row").toBeLessThanOrEqual(2);

    // Off again is the separated look, whole: the setting only swaps rows.
    await page.evaluate(() => document.documentElement.removeAttribute("data-sidebar"));
    const backAbove = (await top.boundingBox()) as { y: number; height: number };
    const backBelow = (await bottom.boundingBox()) as { y: number; height: number };
    expect(backBelow.y - (backAbove.y + backAbove.height)).toBe(2);
    await expect.poll(async () => (await lineOf(bottom.locator(".session"))).content, { message: "the divider is drawn again" }).toBe('""');
  });
});

const SETTINGS_PORT = Number(process.env.AWUI_E2E_PORT ?? 4791) + 2;

// Its own server, because saving a setting needs a settings folder and the suite's server has none.
test.describe("the sidebar style setting", () => {
  let server: ChildProcess | undefined;
  let base = "";
  let configFile = "";
  let project = "";

  test.beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-sidebar-style-"));
    const root = path.join(dir, "workspaces");
    project = path.join(root, "proj");
    mkdirSync(project, { recursive: true });
    const configDir = path.join(dir, "awui");
    mkdirSync(configDir, { recursive: true });
    configFile = path.join(configDir, "config.yml");
    const env: NodeJS.ProcessEnv = { ...process.env, AWUI_CONFIG_DIR: configDir, AWUI_HARNESSES: "fake,fake-b", WORKSPACE_ROOTS: root };
    for (const key of ["HOST", "PORT", "AUTH_USERNAME", "AUTH_PASSWORD", "AUTH_CREDENTIALS_FILE", "ALLOWED_HOSTS"]) delete env[key];
    env.PORT = String(SETTINGS_PORT);
    env.XDG_STATE_HOME = path.join(dir, "state");
    env.THEME_FILE = path.join(dir, "none.yaml");
    const child = spawn(process.execPath, ["dist/server/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
    server = child;
    let out = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
      const onData = (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes(`Local: http://127.0.0.1:${SETTINGS_PORT}/`)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", (code) => reject(new Error(`server exited (${code}):\n${out}`)));
    });
    base = `http://127.0.0.1:${SETTINGS_PORT}`;
  });

  test.afterAll(async () => {
    if (!server || server.exitCode !== null) return;
    const exited = new Promise((resolve) => server?.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  });

  test("picking Compact saves sidebar_style, and the next page load carries it", async ({ page }) => {
    // One session for the sidebar to draw, made through the API (this server has its own project folder).
    const opened = await page.request.post(`${base}/api/workspaces/open`, { data: { path: project } });
    const workspaceId = ((await opened.json()) as { id: string }).id;
    const created = await page.request.post(`${base}/api/chats`, { data: { harnessId: "fake", workspaceId } });
    const chatId = (JSON.parse(await created.text()) as { chatId: string }).chatId;
    await page.request.post(`${base}/api/chats/${chatId}/messages`, { data: { text: "sidebar style probe", mode: "normal" } });

    await page.goto(`${base}/`);
    await expect(page.locator(".session", { hasText: "sidebar style probe" }).first()).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-sidebar", "compact");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
    await settings.getByRole("group", { name: "Sidebar" }).getByRole("button", { name: "Compact" }).click();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).toContain("sidebar_style: compact");
    // Applies at once, without a reload.
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "compact");
    await settings.getByRole("button", { name: "Close" }).click();

    // And on the next page load, from config.yml.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "compact");

    // Back to separated, the default, leaves no setting behind.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
    await settings.getByRole("group", { name: "Sidebar" }).getByRole("button", { name: "Separated" }).click();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByText("Saved.", { exact: true })).toBeVisible();
    expect(readFileSync(configFile, "utf8")).not.toContain("sidebar_style");
    await expect(page.locator("html")).not.toHaveAttribute("data-sidebar", "compact");
  });
});
