import { type ChildProcess, execFileSync, spawn } from "node:child_process";
// Sidebar rows keep one pitch: 36px, or 54px with a subline on a fine pointer. A two-line title takes
// the full row; the right end of its subline holds the age, which fades out on hover
// for the ⋯ that takes its place, so the title never changes width under the pointer.
// A one-line title keeps the age beside it, and hover swaps the ⋯ for that age.
// Unread is title weight, never an accent dot; section rows do not repeat their section's
// state word. A project group states a common branch on its head, not on every child.
//
// Compact keeps one 28px line: the title (flex 1 1 auto, never below 96px), the project's name as a suffix
// of at most 56px, and a stable age slot that hover trades for the ⋯. The title takes every spare pixel and
// the suffix yields first; the suffix holds one fact, so beside a state the agent set the project's name is
// not drawn at any width, and under a 224px rail it goes altogether, while a branch or the state stays. The
// tests below measure the contract.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showAllProjects, showSidebar, signInAndOpen, useProjectsView } from "./helpers.js";

/** Longer than the row can hold: the title must be cut, not wrapped. */
const LONG_TITLE =
  "a session title long enough to want a third line in the two-hundred-pixel sidebar rail, which it must not take, because one line is the whole rhythm of this list";

/** A stubbed status's width inside a compact suffix before the project stopped being drawn beside it (measured
 *  at 57f5405f): the project kept its 24px floor and the sentence gave way around it. The fact is wider now. */
const WAS_FACT_WIDTH: Record<number, number> = { 236: 10.7, 292: 62.9, 340: 62.9 };

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
  test("one line at 36px inside a project, 54px with its tag in the flat list, no divider", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "older pitch row");
    await newChat(page);
    await sendAndWait(page, "pitch row in the sidebar");
    await showSidebar(page);

    // The flat list: this row carries its project as a tag, which is its subline, so it stands 54px tall.
    const item = row(page, "pitch row in the sidebar").first();
    await expect(item.locator(".session-sub")).toBeVisible();
    expect(await rowBox("pitch row in the sidebar", page), "a row with its tag is 54px").toEqual({ height: 54 });
    // The pitch of the whole list: one 2px step from row to row, and every row one line (54 here, since
    // every row of the flat list carries its project).
    const pitch = await pitchIn(page, ".flat-group");
    expect(new Set(pitch.heights)).toEqual(new Set([54]));
    expect(new Set(pitch.gaps), "rows sit 2px apart").toEqual(new Set([2]));
    expect((await lineOf(item.locator(".session"))).content, "no hairline joins two rows").toBe("none");
    // The tag is the project's badge and its name, on one line under the title.
    await expect(item.locator(".session-sub .project-badge")).toHaveCount(1);
    await expect(item.locator(".session-sub")).toContainText("alpha");

    // The grouped view: inside its own project the row has nothing to add, so it is one 36px line.
    await useProjectsView(page);
    await page.reload();
    await showSidebar(page);
    // The grouped view: one folder head (focused, or plain with a single project), and the row under it.
    await expect(sidebar(page).locator(".flat-group")).toHaveCount(0);
    await expect(sidebar(page).locator(".project-group").first()).toBeVisible();
    const grouped = row(page, "pitch row in the sidebar").first();
    await expect(grouped.locator(".session-sub")).toHaveCount(0);
    const box = (await grouped.boundingBox()) as { height: number } | null;
    expect(Math.round((box as { height: number }).height), "a one-line row is 36px").toBe(36);
  });

  test("the rows sit on a 12px gutter and the titles on one 26px edge", async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const root = process.env.AWUI_E2E_ROOT as string;
    const beta = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/beta` } })).json()) as { id: string };
    const other = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: beta.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${other.chatId}/messages`, { data: { text: "a second folder head", mode: "normal" } });
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "one shared title edge");
    await showSidebar(page);
    await expect(sidebar(page).locator(".date-divider").first()).toBeVisible();
    const flat = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
      const first = document.querySelector(".sidebar .session")?.getBoundingClientRect();
      const title = document.querySelector(".sidebar .session-title")?.getBoundingClientRect();
      const date = document.querySelector(".sidebar .date-divider") as HTMLElement | null;
      const dateStyle = date && getComputedStyle(date);
      return sidebar && first && title && date && dateStyle ? {
        rowGutter: first.left - sidebar.left,
        titleInset: title.left - first.left,
        dateEdge: date.getBoundingClientRect().left + Number.parseFloat(dateStyle.paddingLeft) - sidebar.left,
      } : null;
    });
    expect(flat, "a row and a date heading are drawn").not.toBeNull();
    expect(flat?.rowGutter ?? 0, "the rows sit on the panel's 12px gutter").toBeCloseTo(12, 0);
    expect(flat?.titleInset ?? 0, "the titles start 26px into a row").toBeCloseTo(26, 0);
    // Default keeps the existing blank identity court and exactly one project badge on the subline.
    const marked = await sidebar(page).locator(".session", { hasText: "one shared title edge" }).evaluate((el) => {
      const slot = el.querySelector(":scope > .harness-dot.is-blank");
      const badge = el.querySelector(".session-sub > .project-badge");
      if (!(slot instanceof HTMLElement) || !(badge instanceof HTMLElement)) return null;
      return { count: el.querySelectorAll(".project-badge").length, width: slot.getBoundingClientRect().width, blank: true, font: getComputedStyle(badge).fontSize };
    });
    expect(marked, "one project badge in the default subline").toEqual({ count: 1, width: 6, blank: true, font: "9px" });
    expect(flat?.dateEdge ?? 0, "a date label starts on the titles' edge").toBeCloseTo(38, 0);

    await useProjectsView(page);
    await page.reload();
    await showSidebar(page);
    if (await sidebar(page).locator(".focus-switch").count()) await showAllProjects(page);
    await expect(sidebar(page).locator('.project-group[data-testid="project-group"]').first()).toBeVisible();
    const folderEdge = await sidebar(page).locator(".project-group[data-testid='project-group'] .project-name").first().evaluate((el) => {
      const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
      return sidebar ? el.getBoundingClientRect().left - sidebar.left : null;
    });
    expect(folderEdge ?? 0, "a folder head's name shares the titles' 38px edge").toBeCloseTo(38, 0);
  });

  test("a folder head and its rows share the list's one edge", async ({ page, request }) => {
    await useProjectsView(page);
    // Focus mode needs a second project with a session of its own (the suite shares one server).
    const beta = (await (await request.post("/api/workspaces/open", { data: { path: `${process.env.AWUI_E2E_ROOT as string}/beta` } })).json()) as { id: string };
    const other = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: beta.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${other.chatId}/messages`, { data: { text: "aligned row's other project", mode: "normal" } });
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "aligned row under the head");
    await showSidebar(page);
    // The all-projects list, whose heads have no back button: a head is the badge, the name, the chevron.
    await expect(page.getByTestId("focused-project")).toBeVisible();
    await showAllProjects(page);
    await expect(page.getByTestId("focused-project")).toHaveCount(0);
    const edge = await page.evaluate(() => {
      const group = [...document.querySelectorAll('[data-testid="project-group"]')].find((el) => el.querySelector(".project-name")?.textContent === "alpha");
      const head = group?.querySelector(".project-head") as HTMLElement | null;
      const badge = head?.querySelector(".project-badge")?.getBoundingClientRect();
      const chevron = head?.querySelector(".group-chevron")?.getBoundingClientRect();
      const name = head?.querySelector(".project-name")?.getBoundingClientRect();
      const title = [...(group?.querySelectorAll(".session-title") ?? [])].find((el) => el.textContent?.includes("aligned row under the head"))?.getBoundingClientRect();
      const item = group?.querySelector(".session-item")?.getBoundingClientRect();
      const headBox = head?.getBoundingClientRect();
      if (!badge || !name || !title || !item || !headBox || !chevron) return null;
      return {
        headLeft: headBox.left,
        name: name.left,
        title: title.left,
        rowLeft: item.left,
        rowRight: item.right,
        headRight: headBox.right,
        badgeCentre: badge.left + badge.width / 2,
        markCentre: headBox.left + 10 + 5,
        chevronLeft: chevron.left,
        nameRight: name.right,
      };
    });
    expect(edge, "the head and the row are both drawn").not.toBeNull();
    const e = edge as { headLeft: number; name: number; title: number; rowLeft: number; rowRight: number; headRight: number; badgeCentre: number; markCentre: number; chevronLeft: number; nameRight: number };
    // One text edge, and no indent: the head's name and its rows' titles start on the same x, the row
    // spans the list, and the badge hangs in the mark column left of it.
    expect(Math.abs(e.title - e.name), "the head's name is on the titles' edge").toBeLessThanOrEqual(2);
    expect(Math.abs(e.rowLeft - e.headLeft), "a folder's rows are not indented under it").toBeLessThanOrEqual(1);
    expect(Math.abs(e.rowRight - e.headRight), "a folder's rows span the list").toBeLessThanOrEqual(1);
    expect(Math.abs(e.badgeCentre - e.markCentre), "the badge hangs in the mark column").toBeLessThanOrEqual(0.5);
    expect(e.chevronLeft, "the fold chevron follows the name").toBeGreaterThan(e.nameRight);
  });

  test("a long title stops at one line with an ellipsis, and hover never moves it", async ({ page }) => {
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
    // The words the ellipsis hides are in the row's title attribute (and its hover card), bounded: a
    // session's title is a whole prompt, so the tooltip keeps a caption's worth of it, not the wall itself.
    const tooltip = (await item.locator(".session").getAttribute("title")) ?? "";
    expect(tooltip, "the tooltip keeps the title's first words").toMatch(/^a session title long enough/);
    expect(tooltip.split(" · ")[0], "one part is capped at a caption").toHaveLength(100);
    expect(tooltip, "and says it was cut").toContain("…");
    // Hover gives the ⋯ the age at the subline's end, not 22px of the title: the title's box keeps the
    // width it had, so its own ellipsis does not move and no glyph is cut under the control.
    await item.locator(".session").hover();
    await expect(item.locator(".session-more")).toHaveCSS("opacity", "1");
    await expect(item.locator(".session-sub .session-meta")).toHaveCSS("opacity", "0", { timeout: 2000 });
    const after = await title.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: el.clientWidth, scroll: el.scrollWidth, padding: s.paddingRight, overflow: s.textOverflow };
    });
    expect(after.padding, "no hover gutter on the title").toBe("0px");
    expect(after.width, "the title's box is the same width hovered as not").toBe(box.width);
    expect(after.scroll, "and its words end where they ended").toBe(box.scroll);
    expect(after.overflow).toBe("ellipsis");
  });

  test("a two-line title keeps its width, and the ⋯ takes the age at the subline's end", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "hover keeps the age");
    await showSidebar(page);
    const item = row(page, "hover keeps the age").first();
    await expect(item.locator(".session-body")).toHaveClass(/has-sub/);
    const before = await item.evaluate((el) => {
      const title = el.querySelector(".session-title")?.getBoundingClientRect();
      const meta = el.querySelector(".session-meta")?.parentElement?.getBoundingClientRect();
      const sub = el.querySelector(".session-sub")?.getBoundingClientRect();
      return title && meta && sub ? { width: title.width, titleBottom: title.bottom, metaTop: meta.top, metaRight: meta.right, subTop: sub.top, subBottom: sub.bottom } : null;
    });
    expect(before).not.toBeNull();
    await item.locator(".session").hover();
    await expect(item.locator(".session-more")).toHaveCSS("opacity", "1");
    await expect(item.locator(".session-sub .session-meta")).toHaveCSS("opacity", "0", { timeout: 2000 });
    const now = await item.evaluate((el) => {
      const button = el.querySelector(".session-more")?.getBoundingClientRect();
      const title = el.querySelector(".session-title") as HTMLElement | null;
      const metaEl = el.querySelector(".session-sub .session-meta");
      const sessionEl = el.querySelector(".session");
      return button && title && metaEl && sessionEl ? { left: button.left, right: button.right, centre: button.top + button.height / 2, bottom: button.bottom, metaOpacity: getComputedStyle(metaEl).opacity, mask: getComputedStyle(title).maskImage, titlePadding: getComputedStyle(title).paddingRight, titleWidth: title.getBoundingClientRect().width, padding: getComputedStyle(sessionEl).paddingRight } : null;
    });
    expect(now?.metaOpacity).toBe("0");
    // The title neither fades nor narrows under the pointer: it keeps its whole width and its own ellipsis.
    expect(now?.mask).toBe("none");
    expect(now?.titlePadding).toBe("0px");
    expect(now?.titleWidth).toBe(before?.width);
    // No reserved gutter: the row's right padding stays the list's 10px.
    expect(now?.padding).toBe("10px");
    // The ⋯ sits over the age at the subline's end: its glyph on that line's centre, and the box it covers
    // is the age's own right end.
    expect(now?.centre ?? 0).toBeGreaterThan(before?.titleBottom ?? 0);
    expect(Math.abs((now?.centre ?? 0) - (((before?.subTop ?? 0) + (before?.subBottom ?? 0)) / 2))).toBeLessThanOrEqual(1.5);
    expect(now?.right ?? 0).toBeGreaterThanOrEqual(before?.metaRight ?? 0);
    expect((await item.locator(".session-more").boundingBox())?.width).toBe(28);
  });

  test("a one-line row swaps its age for the ⋯ without moving the title", async ({ page }) => {
    await useProjectsView(page);
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "one line hover row");
    await showSidebar(page);
    const item = row(page, "one line hover row").first();
    await expect(item.locator(".session-body")).not.toHaveClass(/has-sub/);
    const titleBefore = await item.locator(".session-title").boundingBox();
    const age = item.locator(".session-meta");
    await item.locator(".session").hover();
    await expect(item.locator(".session-more")).toHaveCSS("opacity", "1");
    await expect(age).toHaveCSS("opacity", "0", { timeout: 2000 });
    expect((await item.locator(".session-title").boundingBox())?.width).toBe(titleBefore?.width);
    // The control replaces its faded age in the same part of the one-line row.
    const boxes = await item.evaluate((el) => {
      const more = el.querySelector(".session-more")?.getBoundingClientRect();
      const meta = el.querySelector(".session-meta")?.parentElement?.getBoundingClientRect();
      return more && meta ? { moreTop: more.top, moreBottom: more.bottom, metaTop: meta.top, metaBottom: meta.bottom } : null;
    });
    expect(boxes?.metaTop).toBeLessThan(boxes?.moreBottom ?? 0);
    expect(boxes?.metaBottom).toBeGreaterThan(boxes?.moreTop ?? 0);
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
      const sub = el.querySelector(".session-sub-name")?.getBoundingClientRect();
      return title && sub ? { titleBottom: title.bottom, subTop: sub.top, titleRight: title.right, subLeft: sub.left } : null;
    });
    expect(placed, "the row carries its project").not.toBeNull();
    const suffix = placed as { titleBottom: number; subTop: number; titleRight: number; subLeft: number };
    expect(suffix.subTop, "one line: the suffix starts on the title's own line").toBeLessThan(suffix.titleBottom);
    expect(suffix.subLeft).toBeGreaterThanOrEqual(suffix.titleRight);
    // The suffix is one bounded box: the project's name wears a 56px cap (a px cap, not a share of the line:
    // a percentage cap on a content-sized track resolved to its floor, which cut "drishal-notes" and left
    // 30px of dead column beside it).
    const suffixBox = await item.locator(".session-sub-name").evaluate((el) => ({ width: el.getBoundingClientRect().width, max: getComputedStyle(el).maxWidth }));
    expect(suffixBox.max, "the suffix's own cap").toBe("96px");
    const projectCap = await item.locator(".session-sub-project").evaluate((el) => ({ max: getComputedStyle(el).maxWidth, width: el.getBoundingClientRect().width }));
    expect(projectCap.max, "the project's name gives way at 56px").toBe("56px");
    expect(projectCap.width).toBeLessThanOrEqual(56.5);
    // The title keeps a sensible share of the line: at least 96px, and every spare pixel.
    const titleWidth = await item.locator(".session-title").evaluate((el) => el.getBoundingClientRect().width);
    expect(titleWidth, "the title's own floor").toBeGreaterThanOrEqual(95.5);
    // A second row whose title is wider than the line: the suffix keeps one position, so the project names
    // form a column beside the age. Hugging the title put a short row's suffix 98px left of a long one's.
    await newChat(page);
    await sendAndWait(page, "compact long row");
    await send(page, `/rename ${LONG_TITLE}`);
    // The row takes the new title when the list refreshes: measure the two once it is there.
    const long = row(page, "a session title long enough").first();
    await expect(long).toBeVisible();
    const rights = await page.evaluate(() =>
      [...document.querySelectorAll(".flat-group .session-item")].flatMap((el) => {
        const right = el.querySelector(".session-sub-name")?.getBoundingClientRect().right;
        return right === undefined ? [] : [right];
      }),
    );
    expect(rights.length, "both compact rows carry a suffix").toBeGreaterThanOrEqual(2);
    expect(Math.max(...rights) - Math.min(...rights), "the suffix has one position").toBeLessThanOrEqual(0.5);
    // The title gives way first, with its own ellipsis, left of the suffix.
    const titleBox = await long.locator(".session-title").evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(titleBox.scroll, "the long title is cut, not wrapped").toBeGreaterThan(titleBox.client);
    expect(await long.locator(".session-title").evaluate((el) => el.clientHeight), "one line").toBeLessThanOrEqual(19);
    // The age at the line's end gets the same slot as ⋯ on hover, not a third column.
    await item.locator(".session").hover();
    await expect(item.locator(".session-meta")).toHaveCSS("opacity", "0", { timeout: 2000 });
    await expect(item.locator(".session-more")).toHaveCSS("opacity", "1");
    // Off again is the separated look, whole: the setting only swaps rows.
    await page.evaluate(() => document.documentElement.removeAttribute("data-sidebar"));
    const back = (await item.boundingBox()) as { height: number } | null;
    expect(Math.round((back as { height: number }).height)).toBe(54);
  });

  test("a long project's name is cut, and the title keeps its own 96px", async ({ page, request }) => {
    // A folder whose name is wider than the suffix's 56px, on a 232px rail: the width where the grid this
    // replaced gave the title exactly 96px and the suffix 44px of "drish…".
    const root = process.env.AWUI_E2E_ROOT as string;
    const folder = path.join(root, "drishal-notes-archive");
    mkdirSync(folder, { recursive: true });
    const ws = (await (await request.post("/api/workspaces/open", { data: { path: folder } })).json()) as { id: string };
    const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: "a compact row out of a long project name", mode: "normal" } });
    await page.addInitScript(() => window.localStorage.setItem("awui.sidebarWidth", JSON.stringify(232)));
    await signInAndOpen(page);
    await showSidebar(page);
    await page.evaluate(() => document.documentElement.setAttribute("data-sidebar", "compact"));
    const longRow = row(page, "a compact row out of a long project name").first();
    await expect(longRow).toBeVisible();
    const fit = await longRow.evaluate((el) => {
      const title = el.querySelector(".session-title") as HTMLElement;
      const project = el.querySelector(".session-sub-project") as HTMLElement;
      return { title: title.getBoundingClientRect().width, project: project.getBoundingClientRect().width, projectScroll: project.scrollWidth };
    });
    // The project's name stops at 56px and ellipsises there; the title keeps its own 96px floor, so the title
    // is never the part that gives way to fit a project name beside a full age.
    expect(fit.project, "the project's name is cut at 56px").toBeLessThanOrEqual(56.5);
    expect(fit.projectScroll, "a long project name ellipsises inside its box").toBeGreaterThan(fit.project);
    expect(fit.title, "the title keeps its floor").toBeGreaterThanOrEqual(95.5);
    await page.evaluate(() => document.documentElement.removeAttribute("data-sidebar"));
  });

  test("at the 236px floor the suffix yields, so every row's age keeps one column", async ({ page, request }) => {
    // The narrowest rail a desktop resizer gives. A row whose project hit its 56px cap used to make the line
    // wider than the body it sits in (189px inside 183), so its age sat 6px right of every other row's: the
    // suffix has to give way to the age's column, not overflow past it.
    const root = process.env.AWUI_E2E_ROOT as string;
    const rows = [
      { folder: "a-project-name-longer-than-the-suffix-cap", text: "a long-foldered row whose title wants the whole line at the narrowest rail" },
      { folder: "rings", text: "a short-foldered row whose title wants the whole line at the narrowest rail" },
    ];
    for (const one of rows) {
      const folder = path.join(root, one.folder);
      mkdirSync(folder, { recursive: true });
      const ws = (await (await request.post("/api/workspaces/open", { data: { path: folder } })).json()) as { id: string };
      const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
      await request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: one.text, mode: "normal" } });
    }
    await page.addInitScript(() => window.localStorage.setItem("awui.sidebarWidth", JSON.stringify(236)));
    await signInAndOpen(page);
    await showSidebar(page);
    await page.evaluate(() => document.documentElement.setAttribute("data-sidebar", "compact"));
    for (const one of rows) await expect(row(page, one.text.slice(0, 24)).first(), "the row is in the list").toBeVisible();
    const measured = await page.evaluate(() =>
      [...document.querySelectorAll(".session-item")]
        .filter((el) => el.querySelector(".session-sub-project") !== null)
        .map((el) => {
          const body = el.querySelector(".session-body") as HTMLElement;
          const slot = el.querySelector(".session-slot") as HTMLElement;
          return { edge: Math.round(slot.getBoundingClientRect().right * 10) / 10, over: body.scrollWidth - body.clientWidth, put: el.querySelector(".session-sub-project")?.textContent ?? "" };
        }),
    );
    expect(measured.length, "two tagged rows at least").toBeGreaterThanOrEqual(2);
    expect(new Set(measured.map((m) => m.put)).size, "a long project's name and a short one's").toBeGreaterThanOrEqual(2);
    const edges = measured.map((m) => m.edge);
    expect(Math.max(...edges) - Math.min(...edges), "one age column, at 236px").toBeLessThanOrEqual(0.5);
    expect(Math.max(...measured.map((m) => m.over)), "no row overflows the line it is drawn in").toBeLessThanOrEqual(0.5);
    await page.evaluate(() => document.documentElement.removeAttribute("data-sidebar"));
  });

  test("under a 224px rail the project's name goes and the fact beside it stays", async ({ page, request }) => {
    // Two folders and one repository on a feature branch: at 200px a project's name alone is 7-12px of
    // ellipsis — no word at all — while a branch is what tells the row from its siblings.
    const root = process.env.AWUI_E2E_ROOT as string;
    const folder = path.join(root, "drishal-notes-narrow");
    mkdirSync(folder, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "feature/sidebar-compact"], { cwd: folder, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: folder, stdio: "ignore" });
    const ws = (await (await request.post("/api/workspaces/open", { data: { path: folder } })).json()) as { id: string };
    const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: "a row on a narrow rail", mode: "normal" } });
    // A folder with no repository: its row's suffix is the project's name and nothing else.
    const plain = path.join(root, "drishal-notes-plain");
    mkdirSync(plain, { recursive: true });
    const plainWs = (await (await request.post("/api/workspaces/open", { data: { path: plain } })).json()) as { id: string };
    const plainChat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: plainWs.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${plainChat.chatId}/messages`, { data: { text: "a row in a plain folder", mode: "normal" } });

    await signInAndOpen(page);
    await showSidebar(page);
    // The resizer stops at 236px, so no saved width gets a desktop rail under 224px; a very narrow phone drawer
    // can. Set the rail's width token directly (CSSOM, not an inline style attribute) to stand in for it.
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-sidebar", "compact");
      (document.querySelector(".app") as HTMLElement).style.setProperty("--sidebar-w", "200px");
    });
    const narrowRow = row(page, "a row on a narrow rail").first();
    await expect(narrowRow).toBeVisible();
    // The class is the sidebar's own measurement of the rail, and it lands a frame after the token: wait for
    // it, or the row is read in the state before it (the project still 24px wide, the title still on its floor).
    await expect(page.locator(".sidebar"), "the rail has measured itself narrow").toHaveClass(/is-narrow/);
    const parts = await narrowRow.evaluate((el) => {
      const title = el.querySelector(".session-title") as HTMLElement;
      const project = el.querySelector(".session-sub-project") as HTMLElement;
      const branch = el.querySelector(".session-sub-branch") as HTMLElement | null;
      const row = el.querySelector(".session") as HTMLElement;
      return {
        rail: document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0,
        title: title.getBoundingClientRect().width,
        project: { display: getComputedStyle(project).display, width: project.getBoundingClientRect().width },
        branch: branch ? { display: getComputedStyle(branch).display, text: branch.textContent, width: branch.getBoundingClientRect().width } : null,
        name: row.getAttribute("title") ?? "",
      };
    });
    expect(Math.round(parts.rail), "the rail is at the narrow width this is about").toBe(200);
    expect(parts.project.width, "the project's name is not drawn").toBeLessThanOrEqual(1.5);
    expect(parts.project.display, "clipped, not display:none: the name stays in the accessible name").not.toBe("none");
    expect(parts.branch?.display, "the branch is a fact the row keeps").not.toBe("none");
    expect(parts.branch?.text).toBe("feature/sidebar-compact");
    expect(parts.branch?.width ?? 0, "a long branch ellipsises at 56px").toBeLessThanOrEqual(56.5);
    expect(parts.title, "the title keeps its own floor").toBeGreaterThanOrEqual(95.5);
    // The project is still named: the row's own title, its hover card and its accessible name carry it.
    expect(parts.name).toContain("drishal-notes-narrow");
    await expect(narrowRow.locator(".session")).toHaveAccessibleName(/drishal-notes-narrow/);

    // The plain row: its name is gone, and the title takes the 20px it held (96 → 116 at this width).
    const plainBits = await row(page, "a row in a plain folder")
      .first()
      .evaluate((el) => {
        const title = el.querySelector(".session-title") as HTMLElement;
        const project = el.querySelector(".session-sub-project") as HTMLElement;
        return { title: title.getBoundingClientRect().width, project: { display: getComputedStyle(project).display, width: project.getBoundingClientRect().width } };
      });
    expect(plainBits.project.width, "a lone project name is not drawn under 224px").toBeLessThanOrEqual(1.5);
    expect(plainBits.title, "the title takes the room it had").toBeGreaterThanOrEqual(110);
    await expect(row(page, "a row in a plain folder").first().locator(".session"), "the clipped name is still in the accessible name").toHaveAccessibleName(/drishal-notes-plain/);
    await page.evaluate(() => document.documentElement.removeAttribute("data-sidebar"));
  });

  // The agent's own sentence is a status, not a place: at the rail's floor it is longer than the suffix box
  // that caps it at 96px. A nowrap box's min-content is the whole sentence, so with a min-content floor the
  // fact stayed 440px wide inside the box and pushed the project's name out of the row (its left edge 585 on a
  // 236px rail), cutting the words mid-glyph with no ellipsis and taking the age with them.
  test("a long status ends inside its row at 236, 292 and 340px, active or not", async ({ page }) => {
    const status = "DeepSeek research, live Pi audit, and two-model council review all finished cleanly";
    // The listing is the one reader of an agent's status line: stand one in for the two rows below, the way
    // the orchestration `set_status` tool would set it. Nothing else in the payload changes.
    await page.route("**/api/sessions*", async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { sessions?: { title?: string; agentStatus?: unknown }[] };
      for (const s of json.sessions ?? []) {
        if ((s.title ?? "").includes("compact status")) s.agentStatus = { state: "done", comment: status, at: Date.now() };
      }
      await route.fulfill({ response, json });
    });
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "compact status row");
    await newChat(page);
    await sendAndWait(page, "compact status other");
    await showSidebar(page);
    await row(page, "compact status row")
      .first()
      .click();
    await page.evaluate(() => document.documentElement.setAttribute("data-sidebar", "compact"));
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "compact");

    /** Every fact the row draws has to end inside the row: the line, the suffix's box and the age's slot. */
    const overflowing = async (width: number) => {
      return page.evaluate((w) => {
        const list = [...document.querySelectorAll(".sidebar .session")] as HTMLElement[];
        const over: { title: string; w: number; part: string; over: number }[] = [];
        for (const el of list) {
          const title = el.querySelector(".session-title")?.textContent ?? "";
          const rect = el.getBoundingClientRect();
          const padding = parseFloat(getComputedStyle(el).paddingRight);
          // The active row's wash is its own box, and it is what the row's ink must stay inside.
          // A list with no active row keeps a hidden (0×0) wash of its own: only a drawn one bounds the row.
          const wash = (el.closest("li")?.parentElement?.querySelector(":scope > .session-active-bg") as HTMLElement | null)?.getBoundingClientRect();
          const edge = Math.min(rect.right, wash && wash.width > 0 ? wash.right : Infinity) - padding;
          for (const part of [".session-title-line", ".session-sub-name", ".session-slot"]) {
            const box = el.querySelector(part)?.getBoundingClientRect();
            if (box && box.right > edge + 0.5) over.push({ title, w, part, over: Math.round((box.right - edge) * 10) / 10 });
          }
          // The suffix's own box cuts what does not fit: a piece left outside it is a piece nobody sees.
          const suffix = el.querySelector(".session-sub-name")?.getBoundingClientRect();
          for (const part of [".session-sub-fact", ".session-sub-project"]) {
            const piece = el.querySelector(part)?.getBoundingClientRect();
            if (suffix && piece && piece.right > suffix.right + 0.5) over.push({ title, w, part, over: Math.round((piece.right - suffix.right) * 10) / 10 });
          }
        }
        return over;
      }, width);
    };

    const measure = async (view: string) => {
      for (const width of [236, 292, 340]) {
        await page.evaluate((w) => (document.querySelector(".app") as HTMLElement).style.setProperty("--sidebar-w", `${w}px`), width);
        // The rail's own measurement lands a frame after the token: measure the row once it is that wide, and
        // once the active row's wash (a box the list measures and writes itself) has caught up with it.
        await expect.poll(() => page.locator(".sidebar").evaluate((el) => Math.round(el.getBoundingClientRect().width)), `the rail is ${width}px (${view})`).toBe(width);
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                // A list with no active row keeps a hidden wash of its own (0×0): the drawn one is the one to read.
                const wash = [...document.querySelectorAll(".sidebar .session-active-bg")].map((el) => el.getBoundingClientRect()).find((r) => r.width > 0)?.right;
                const active = document.querySelector(".sidebar .session.is-active")?.getBoundingClientRect().right;
                return wash === undefined || active === undefined ? true : Math.abs(wash - active) <= 0.5;
              }),
            `the active row's wash caught up at ${width}px (${view})`,
          )
          .toBe(true);
        expect(await overflowing(width), `every row's words end inside it at ${width}px (${view})`).toEqual([]);
        // The suffix holds one fact, not two: beside the agent's own status the project is not drawn at any
        // width (a clipped 1px box, so its words stay in the row's name) and the sentence takes the room. It
        // kept its 24px floor before this, and the fact gave way around it: 10.7px at 236, 62.9px above it.
        if (view === "recent") {
          const pieces = await active.evaluate((el) => {
            const widthOf = (sel: string) => Math.round((el.querySelector(sel)?.getBoundingClientRect().width ?? 0) * 10) / 10;
            return { fact: widthOf(".session-sub-fact"), project: widthOf(".session-sub-project"), name: el.textContent ?? "", projectName: el.querySelector(".session-sub-project")?.textContent ?? "" };
          });
          expect(pieces.project, `the project is not drawn beside a fact at ${width}px`).toBeLessThanOrEqual(1.5);
          expect(pieces.fact, `the fact takes the suffix's room at ${width}px`).toBeGreaterThan(WAS_FACT_WIDTH[width] ?? 0);
          await expect(active.locator(":scope > .session > .session-project-mark"), "only the reserved slot carries the project mark").toHaveCount(1);
          await expect(active.locator(".project-badge:visible"), "its one project mark does not repeat beside the fact").toHaveCount(1);
          expect(pieces.name, "a clipped project keeps its words in the accessible name").toContain(pieces.projectName);
          // The native tooltip says what the drawn line cuts: the agent's whole sentence and the project.
          const tooltip = (await active.locator(".session").first().getAttribute("title")) ?? "";
          expect(tooltip, "the row's title carries the agent's status").toContain(status);
          expect(tooltip, "the row's title carries the project").toContain(pieces.projectName);
        }
      }
    };

    // The row the listing gives the status to: its suffix is the fact, and the age is the verdict.
    const active = sidebar(page).locator(".session-item.is-active, .session-item:has(.session.is-active)").first();

    // Recent: the status is the tag line's fact, before the project's name.
    await measure("recent");
    // The age keeps the row's one column, and the agent's verdict is the word in it.
    await expect(active.locator(".session-slot"), "the active row keeps its age").toBeVisible();
    await expect(active.locator(".session-slot")).toHaveText("Done");
    // Projects: the same status, drawn as the row's one plain suffix text.
    await useProjectsView(page);
    await page.reload();
    await page.evaluate(() => document.documentElement.setAttribute("data-sidebar", "compact"));
    await row(page, "compact status row")
      .first()
      .click();
    await measure("projects");
    // Direct agent text must ellipsize inside this cap: a flex wrapper hid its overflow at a word edge.
    // Anonymous flex text never ellipsized before. The proper block text now ellipsizes within this cap;
    // measure that fitted box instead of a DOM range (a range can include text that is hidden by ellipsis).
    await expect(active.locator(".session-sub.session-agent > .session-sub-name")).toHaveCSS("display", "block");
    const fact = await active.locator(".session-sub.session-agent > .session-sub-name").evaluate((el) => ({
      client: el.clientWidth,
      scroll: el.scrollWidth,
      overflow: getComputedStyle(el).textOverflow,
      white: getComputedStyle(el).whiteSpace,
      surplus: el.scrollWidth - el.clientWidth,
    }));
    expect(fact.overflow, "plain agent text actually ellipsizes rather than clipping").toBe("ellipsis");
    expect(fact.white, "the status sentence remains one bounded line").toBe("nowrap");
    expect(fact.surplus, "an overlong plain agent sentence is permitted inside its own ellipsis cap").toBeGreaterThan(0);
    await page.evaluate(() => (document.querySelector(".app") as HTMLElement).style.setProperty("--sidebar-w", "236px"));
    await expect.poll(() => page.locator(".sidebar").evaluate((el) => Math.round(el.getBoundingClientRect().width)), "the rail is at its floor").toBe(236);
    await expect.poll(() => active.locator(".session-sub.session-agent > .session-sub-name").evaluate((el) => el.getBoundingClientRect().width), "a plain agent status borrows the title's spare floor, not the age's space").toBeGreaterThan(55.5);
    await active.locator(".session-sub.session-agent > .session-sub-name").screenshot({ path: "/tmp/awui-sidebar-climb/r13/agent-after.png" });
    await active.locator(".session-sub.session-agent > .session-sub-name").screenshot({ path: "/tmp/awui-sidebar-climb/r12/projects-agent-wide-after.png" });
    await page.evaluate(() => document.documentElement.removeAttribute("data-sidebar"));
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
  // Every choice, including the folders (menuitemradio) the switch menu checks.
  const rows = await menu.locator('[role^="menuitem"]').evaluateAll((items) =>
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


test("single-line switch rows centre their labels, marks and counts", async ({ page, request }) => {
  await useProjectsView(page);
  const root = process.env.AWUI_E2E_ROOT as string;
  for (const name of ["alpha", "beta"]) {
    const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/${name}` } })).json()) as { id: string };
    const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
    await request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: `single line menu ${name}`, mode: "normal" } });
  }
  await page.goto("/");
  await showSidebar(page);
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("single line menu beta");
  await page.locator(".session", { hasText: "single line menu beta" }).first().click();
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("");
  await page.locator(".focus-group .project-toggle").first().click();
  const menu = page.getByRole("menu", { name: "Project" });
  await expect(menu).toBeVisible();
  const rows = await menu.locator("button:not(:has(.project-menu-path))").evaluateAll((items) => items.map((item) => {
    const label = item.querySelector(".project-menu-name")?.getBoundingClientRect();
    const marks = [...item.querySelectorAll(":scope > .icon, :scope > .project-badge, :scope > .project-menu-meta")].map((el) => el.getBoundingClientRect());
    return label ? { label: label.top + label.height / 2, marks: marks.map((mark) => mark.top + mark.height / 2) } : null;
  }));
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) {
    expect(row).not.toBeNull();
    for (const centre of row!.marks) expect(Math.abs(centre - row!.label), "one-line label and mark centres").toBeLessThanOrEqual(0.5);
  }
});
