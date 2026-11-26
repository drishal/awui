// Sidebar rows are one line each, on one pitch: 32px, or 48px when the row has a subline (the project it
// is out of, the agent's status, a branch). Nothing divides them — no inset hairline, no rail — so the
// rhythm and the calendar headings do the grouping, and a title is cut with an ellipsis rather than
// wrapped onto a second line that says nothing about the story. The ⋯ keeps a gutter of its own, so the
// age never disappears under the pointer.
//
// The setting that swaps the rows for the compact ones older versions drew (config.yml's `sidebar_style`)
// is measured the same way: 28px, one line, and the subline as a dim suffix after the title.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen, useProjectsView } from "./helpers.js";

/** Longer than the row can hold: the title must be cut, not wrapped. */
const LONG_TITLE =
  "a session title long enough to want a third line in the two-hundred-pixel sidebar rail, which it must not take, because one line is the whole rhythm of this list";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });
const row = (page: Page, title: string) => sidebar(page).locator(".session-item", { hasText: title });

/** A row's own `::before`, as the browser resolves it: `content` says whether anything is drawn at all. */
const lineOf = (session: Locator) => session.evaluate((el) => ({ content: getComputedStyle(el, "::before").content }));

/** A row's own box, in the list it is drawn in. */
async function rowBox(title: string, page: Page): Promise<{ height: number }> {
  const box = await row(page, title)
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  return { height: Math.round(box) };
}

/**
 * The pitch of the rows a selector draws: each row's height, and the gap to the row right under it. Only
 * adjacent session rows are paired, so a date heading or the show-more row never skews a gap.
 */
async function pitchIn(page: Page, selector: string): Promise<{ heights: number[]; gaps: number[] }> {
  return page.evaluate((sel) => {
    const rows = [...document.querySelectorAll(`${sel} .session-item`)];
    const heights = rows.map((el) => Math.round(el.getBoundingClientRect().height));
    const gaps = rows.flatMap((el) => {
      const next = el.nextElementSibling;
      if (!next?.classList.contains("session-item")) return [];
      return [Math.round(next.getBoundingClientRect().top - el.getBoundingClientRect().bottom)];
    });
    return { heights, gaps };
  }, selector);
}

test.describe("the separated rows", () => {
  test("one line at 32px inside a project, 48px with its tag in the flat list, no divider", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "older pitch row");
    await newChat(page);
    await sendAndWait(page, "pitch row in the sidebar");
    await showSidebar(page);

    // The flat list: this row carries its project as a tag, which is its subline, so it stands 48px tall.
    const item = row(page, "pitch row in the sidebar").first();
    await expect(item.locator(".session-sub")).toBeVisible();
    expect(await rowBox("pitch row in the sidebar", page), "a row with its tag is 48px").toEqual({ height: 48 });
    // The pitch of the whole list: one 2px step from row to row, and every row one line (48 here, since
    // every row of the flat list carries its project).
    const pitch = await pitchIn(page, ".flat-group");
    expect(new Set(pitch.heights)).toEqual(new Set([48]));
    expect(new Set(pitch.gaps), "rows sit 2px apart").toEqual(new Set([2]));
    expect((await lineOf(item.locator(".session"))).content, "no hairline joins two rows").toBe("none");
    // The tag is the project's badge and its name, on one line under the title.
    await expect(item.locator(".session-sub .project-badge")).toHaveCount(1);
    await expect(item.locator(".session-sub")).toContainText("alpha");

    // The grouped view: inside its own project the row has nothing to add, so it is one 32px line.
    await useProjectsView(page);
    await page.reload();
    await showSidebar(page);
    // The grouped view: one folder head (focused, or plain with a single project), and the row under it.
    await expect(sidebar(page).locator(".flat-group")).toHaveCount(0);
    await expect(sidebar(page).locator(".project-group").first()).toBeVisible();
    const grouped = row(page, "pitch row in the sidebar").first();
    await expect(grouped.locator(".session-sub")).toHaveCount(0);
    const box = (await grouped.boundingBox()) as { height: number } | null;
    expect(Math.round((box as { height: number }).height), "a one-line row is 32px").toBe(32);
  });

  test("a title under a project head lines up with the project's name", async ({ page, request }) => {
    await useProjectsView(page);
    // Focus mode needs a second project with a session of its own (the suite shares one server).
    const beta = (await (await request.post("/api/workspaces/open", { data: { path: `${process.env.AWUI_E2E_ROOT as string}/beta` } })).json()) as { id: string };
    const other = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: beta.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${other.chatId}/messages`, { data: { text: "aligned row's other project", mode: "normal" } });
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "aligned row under the head");
    await showSidebar(page);
    // The all-projects list, whose heads have no back button: a head is chevron, badge, name.
    await expect(page.getByTestId("focused-project")).toBeVisible();
    await page.getByRole("button", { name: "All projects" }).click();
    await expect(page.getByTestId("focused-project")).toHaveCount(0);
    const xs = await page.evaluate(() => {
      const group = [...document.querySelectorAll('[data-testid="project-group"]')].find((el) => el.querySelector(".project-name")?.textContent === "alpha");
      const name = group?.querySelector(".project-name")?.getBoundingClientRect();
      const title = [...(group?.querySelectorAll(".session-title") ?? [])].find((el) => el.textContent?.includes("aligned row under the head"))?.getBoundingClientRect();
      return name && title ? { name: name.left, title: title.left } : null;
    });
    expect(xs, "the head and the row are both drawn").not.toBeNull();
    // No rail under the head: its rows start at the name's own left edge.
    expect(Math.abs((xs as { name: number; title: number }).title - (xs as { name: number; title: number }).name)).toBeLessThanOrEqual(2);
  });

  test("a long title stops at one line with an ellipsis, and keeps its words on hover", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "ellipsis check");
    await send(page, `/rename ${LONG_TITLE}`);
    await showSidebar(page);

    const item = row(page, "a session title long enough").first();
    const title = item.locator(".session-title");
    await expect(title).toBeVisible();
    const box = await title.evaluate((el) => {
      const s = getComputedStyle(el);
      return { client: el.clientHeight, line: Number.parseFloat(s.lineHeight), scroll: el.scrollWidth, width: el.clientWidth, overflow: s.textOverflow, wrap: s.whiteSpace };
    });
    expect(box.client, "one line, never two").toBeLessThanOrEqual(box.line + 1);
    expect(box.overflow).toBe("ellipsis");
    expect(box.wrap).toBe("nowrap");
    expect(box.scroll, "the title the test wrote is wider than the row").toBeGreaterThan(box.width);
    // The words the ellipsis hides are in the row's title attribute (and its hover card).
    await expect(item.locator(".session")).toHaveAttribute("title", new RegExp(`^${LONG_TITLE}`));
  });

  test("the age stays where it is on hover; the ⋯ has a gutter of its own", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "hover keeps the age");
    await showSidebar(page);
    const item = row(page, "hover keeps the age").first();
    const age = item.locator(".session-time");
    await expect(age).toBeVisible();
    const before = (await age.boundingBox()) as { x: number; width: number } | null;
    await item.locator(".session").hover();
    const more = item.locator(".session-more");
    await expect(more).toBeVisible();
    await expect(age, "the age is not taken away under the pointer").toBeVisible();
    const after = (await age.boundingBox()) as { x: number; width: number } | null;
    expect(after?.x).toBe(before?.x);
    // The gutter sits to the right of the age, so the two never overlap.
    const button = (await more.boundingBox()) as { x: number } | null;
    expect(button?.x ?? 0).toBeGreaterThanOrEqual(((before as { x: number; width: number }).x + (before as { x: number; width: number }).width));
  });
});

test.describe("on touch", () => {
  test("a row is a 44px target and its title still ends with an ellipsis", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "touch row height");
    // Start desktop so the sessions exist; then make the same media query real as on a touch device.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await showSidebar(page);
    const item = row(page, "touch row height").first();
    const box = (await item.boundingBox()) as { height: number } | null;
    expect(Math.round((box as { height: number }).height)).toBeGreaterThanOrEqual(44);
    const title = item.locator(".session-title");
    await expect(title).toHaveCSS("text-overflow", "ellipsis");
    expect(await title.evaluate((el) => el.clientHeight <= Number.parseFloat(getComputedStyle(el).lineHeight) + 1)).toBe(true);
  });
});

// The other look a page can choose (config.yml's `sidebar_style: compact`): the tight rows older versions
// drew. The suite's own server has no settings folder, so the attribute is set on <html> here, which is
// exactly what App.tsx does from the setting; saving the setting from the dialog gets its own server.
test.describe("the compact rows", () => {
  test("compact is 28px and one line, with the project as a suffix after the title", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "compact row one");

    const item = row(page, "compact row one").first();
    await page.evaluate(() => document.documentElement.setAttribute("data-sidebar", "compact"));
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "compact");

    const box = (await item.boundingBox()) as { height: number } | null;
    expect(Math.round((box as { height: number }).height), "a compact row is one 28px line").toBe(28);
    expect((await lineOf(item.locator(".session"))).content, "compact draws no divider").toBe("none");
    // The subline is a suffix on that line, not a second one: the title ends left of the project's name.
    const placed = await item.evaluate((el) => {
      const title = el.querySelector(".session-title")?.getBoundingClientRect();
      const sub = el.querySelector(".session-sub")?.getBoundingClientRect();
      return title && sub ? { titleBottom: title.bottom, subTop: sub.top, titleRight: title.right, subLeft: sub.left } : null;
    });
    expect(placed, "the row carries its project").not.toBeNull();
    const suffix = placed as { titleBottom: number; subTop: number; titleRight: number; subLeft: number };
    expect(suffix.subTop, "one line: the suffix starts on the title's own line").toBeLessThan(suffix.titleBottom);
    expect(suffix.subLeft).toBeGreaterThanOrEqual(suffix.titleRight);
    // Off again is the separated look, whole: the setting only swaps rows.
    await page.evaluate(() => document.documentElement.removeAttribute("data-sidebar"));
    const back = (await item.boundingBox()) as { height: number } | null;
    expect(Math.round((back as { height: number }).height)).toBe(48);
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

test("the project switch menu stands on one grid: marks in one column, labels on one edge", async ({ page, request }) => {
  await useProjectsView(page);
  const root = process.env.AWUI_E2E_ROOT as string;
  for (const name of ["alpha", "beta"]) {
    const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/${name}` } })).json()) as { id: string };
    const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: `menu grid ${name}`, mode: "normal" } });
  }
  await page.goto("/");
  await showSidebar(page);
  // The shared server's current folder may not be beta: the search finds a row in any project.
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("menu grid beta");
  await page.locator(".session", { hasText: "menu grid beta" }).first().click();
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("");
  await page.locator(".focus-group .project-toggle").first().click();
  const menu = page.getByRole("menu", { name: "Project" });
  await expect(menu).toBeVisible();
  // Every row's mark (the back chevron, the image glyph, a folder's badge) is centred on one x, and every label (the
  // two commands and each folder's name) starts at one x: before, the badge sat on a line of its own and a path wrapped
  // under it, and the two glyph rows' labels stood 5 px left of the folders'.
  const rows = await menu.getByRole("menuitem").evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect();
      const mark = (item.firstElementChild as Element).getBoundingClientRect();
      const label = (item.querySelector(".project-menu-name") as Element).getBoundingClientRect();
      return { markCentre: mark.left + mark.width / 2 - box.left, labelLeft: label.left - box.left, markMid: mark.top + mark.height / 2 - (box.top + box.height / 2), height: box.height };
    }),
  );
  expect(rows.length).toBeGreaterThanOrEqual(3);
  for (const row of rows) {
    expect(Math.abs(row.markCentre - rows[0]!.markCentre), "marks share a column").toBeLessThanOrEqual(1);
    expect(Math.abs(row.labelLeft - rows[0]!.labelLeft), "labels share an edge").toBeLessThanOrEqual(1);
    expect(Math.abs(row.markMid), "mark is centred in its row").toBeLessThanOrEqual(1.5);
  }
});
