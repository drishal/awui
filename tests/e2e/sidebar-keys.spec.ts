// The sidebar's menus, keyboard and focus: the row menu's task groups, the keys every menu answers
// (arrows, Home/End, Escape back to its opener), the list as one tab stop, and the collapsed rail.
import { expect, test, type Page } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

/** The menu's rows in order, a `|` for each group rule and a folded group's own rows inline, so a test reads its shape. */
async function menuShape(page: Page): Promise<string[]> {
  return page.getByRole("menu").evaluate((menu) =>
    Array.from(menu.children).flatMap((li): string[] => {
      if (li.getAttribute("role") === "separator") return ["|"];
      return Array.from(li.querySelectorAll("button"), (button) => (button.textContent ?? "").trim().replace(/\s+/g, " "));
    }),
  );
}

test("the row menu groups its actions by task, with a rule between the groups", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "menu groups one");
  await newChat(page);
  await sendAndWait(page, "menu groups two");
  await showSidebar(page);
  await page.locator(".session-item", { hasText: "menu groups one" }).first().locator(".session").click({ button: "right" });

  const shape = await menuShape(page);
  const marks = shape.flatMap((row, i) => (row === "|" ? [i] : []));
  // Five tasks, four rules: open, mark, snooze, arrange, archive — not thirteen flat rows.
  expect(marks).toHaveLength(4);
  expect(shape.filter((row) => row !== "|")).toEqual([
    "Open in new tab",
    "Open beside",
    "Copy resume command",
    "Pin",
    "Mark unread",
    "Settle",
    "Snooze",
    "Select sessions",
    "Move up",
    "Move down",
    "Archive",
  ]);
  // Archive is the last thing a row's menu says, whatever else it can do.
  expect(shape.at(-1)).toBe("Archive");
  // Every row leads with a glyph, Select included.
  const glyphs = await page.getByRole("menu").getByRole("menuitem").evaluateAll((items) => items.map((item) => item.querySelector("svg.icon") !== null));
  expect(glyphs.every(Boolean)).toBe(true);

  // Snooze folds its choices out under its own row, so the menu stays short until it is asked.
  await page.getByRole("menuitem", { name: "Snooze", exact: true }).click();
  const folded = await menuShape(page);
  expect(folded.slice(folded.indexOf("Snooze") + 1, folded.indexOf("Select sessions")).filter((row) => row !== "|")).toEqual(["For an hour", "Until tomorrow", "Until next week", "Until a time…"]);
});

test("a long row menu opens inside the session list, never over the head above it", async ({ page }) => {
  // The menu pops in scaled: measure it where it settles.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 560 });
  await signInAndOpen(page);
  for (const text of ["menu clamp one", "menu clamp two", "menu clamp three"]) {
    await newChat(page);
    await sendAndWait(page, text);
  }
  await showSidebar(page);
  const list = page.locator(".session-list");
  // The newest row sits at the list's bottom; a menu of eleven rows cannot fit under it in this window.
  await page.locator(".session-item", { hasText: "menu clamp one" }).first().locator(".session").click({ button: "right" });
  // Read both boxes in one frame: scrolling the list to the row moves its top too.
  const box = await page.evaluate(() => {
    const menu = document.querySelector(".row-menu")!.getBoundingClientRect();
    const list = document.querySelector(".session-list")!.getBoundingClientRect();
    return { top: menu.top, bottom: menu.bottom, listTop: list.top };
  });
  expect(box.top).toBeGreaterThanOrEqual(box.listTop);
  expect(box.bottom).toBeLessThanOrEqual(560);
});

test("the row menu is one tab stop: arrows walk it, Escape hands the focus back to the row", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "row menu keys");
  await showSidebar(page);
  const row = page.locator(".session-item", { hasText: "row menu keys" }).first().locator(".session");
  await row.focus();
  // The keyboard's context menu opens it, so a row is not two tab stops.
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Copy resume command" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Archive" })).toBeFocused();
  // A menu wraps at its ends.
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();
});
