// Sidebar session rows have to read as separate sessions (t169): a two-line title plus a
// sub-line used to sit almost as close to the next row's title as to its own. The row
// rhythm and the inset hairline are both cheap to lose in a later restyle, so this spec
// measures them rather than reading the stylesheet: adjacent rows are either 2px apart or
// joined by a 1px line, a long title stops at two lines, the time sits on the title's first
// line, and a filled row takes the line off itself and the row under it.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

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
    return { height: Number.parseFloat(s.height), background: s.backgroundColor, opacity: Number(s.opacity) };
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
  const long = "a session title long enough to want a third line in the two-hundred-pixel sidebar rail, which it must not take";
  await send(page, `/rename ${long}`);
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
