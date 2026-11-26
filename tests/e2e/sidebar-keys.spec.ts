// The sidebar's menus, keyboard and focus: the row menu's task groups, the keys every menu answers
// (arrows, Home/End, Escape back to its opener), the list as one tab stop, and the collapsed rail.
import { expect, test, type Page } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen, useProjectsView } from "./helpers.js";

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
  await useProjectsView(page);
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

test("the session list is one tab stop, and its arrows walk the rows", async ({ page }) => {
  await signInAndOpen(page);
  for (const text of ["key row one", "key row two", "key row three"]) {
    await newChat(page);
    await sendAndWait(page, text);
  }
  await showSidebar(page);
  // Narrowed to this test's own rows: the shared e2e server holds other specs' sessions too.
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("key row");
  await expect(page.locator(".session-item > .session")).toHaveCount(3);
  // One stop for the whole list, and no separate stop for each row's ⋯.
  const stops = await page.locator(".session-list").evaluate((list) => ({
    rows: Array.from(list.querySelectorAll<HTMLElement>(".session-item > .session")).filter((row) => row.tabIndex >= 0).length,
    more: Array.from(list.querySelectorAll<HTMLElement>(".session-more")).filter((more) => more.tabIndex >= 0).length,
  }));
  expect(stops).toEqual({ rows: 1, more: 0 });

  const rows = page.locator(".session-item > .session");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  // A list clamps: the last row does not wrap round to the first.
  await page.keyboard.press("ArrowDown");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-prompt").first()).toContainText("key row");
});

test("the filter menu answers Escape from its trigger and hands the focus back", async ({ page }) => {
  await signInAndOpen(page);
  const trigger = page.getByRole("button", { name: /^Filters/ });
  await trigger.click();
  const menu = page.getByRole("group", { name: "Filter sessions" });
  await expect(menu).toBeVisible();
  // The menu takes the focus (its View, Show and Hide groups are one walk), and its arrows move it along.
  const focusedLabel = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  await expect(menu.locator(":focus")).toHaveCount(1);
  const first = await focusedLabel();
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator(":focus")).toHaveCount(1);
  expect(await focusedLabel()).not.toBe(first);
  // Escape while the trigger itself has the focus closes the menu too (it used to stay open), and the
  // focus lands back on the trigger rather than the body.
  await trigger.focus();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("a row reached by the keyboard shows its hover card under itself", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "card on focus");
  await showSidebar(page);
  const row = page.locator(".session-item", { hasText: "card on focus" }).first().locator(".session");
  await row.focus();
  const card = page.locator(".session-card");
  await expect(card).toBeVisible({ timeout: 3000 });
  const [rowBox, cardBox] = [await row.boundingBox(), await card.boundingBox()];
  // Under the row, never over it: the row keeps its focus ring in sight.
  expect(cardBox!.y).toBeGreaterThanOrEqual(rowBox!.y + rowBox!.height - 1);
  await expect(row).toHaveAttribute("aria-describedby", /.+/);
});

test("All projects stays chosen when a session opens in another folder", async ({ page, request }) => {
  await useProjectsView(page);
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/beta` } })).json()) as { id: string };
  const other = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${other.chatId}/messages`, { data: { text: "beta session", mode: "normal" } });
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "alpha session");
  const focused = page.getByTestId("focused-project");
  await expect(focused.locator(".project-name")).toHaveText("alpha");
  // All projects, deliberately, from the switch's first item.
  await focused.locator(".focus-switch").click();
  await page.getByRole("menuitem", { name: "All projects" }).click();
  const groups = page.getByTestId("project-group");
  const beta = groups.filter({ has: page.locator(".project-name", { hasText: /^beta$/ }) });
  await expect(beta).toHaveCount(1);

  // Opening a session in another folder moves the folder, not the list: the choice holds.
  await beta.locator(".session", { hasText: "beta session" }).click();
  await expect(page.locator(".chat-header .chat-path")).toHaveText("beta");
  await expect(focused).toHaveCount(0);
  await expect(beta).toHaveCount(1);
});

test("the project switch menu walks with the arrows and Escape returns to its button", async ({ page, request }) => {
  await useProjectsView(page);
  const root = process.env.AWUI_E2E_ROOT as string;
  // A second folder with a session of its own, so the switch has somewhere to go.
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/beta` } })).json()) as { id: string };
  const other = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${other.chatId}/messages`, { data: { text: "beta elsewhere", mode: "normal" } });
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "switch menu keys");
  await showSidebar(page);
  const head = page.getByTestId("focused-project");
  await expect(head.locator(".project-name")).toHaveText("alpha");
  const button = head.locator(".focus-switch");
  await button.click();
  const menu = page.getByRole("menu", { name: "Project" });
  await expect(menu).toBeVisible();
  // Every choice, whether it is the way out (a menuitem) or a folder (a menuitemradio).
  const items = menu.locator('[role^="menuitem"]');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("the focus head is one button naming the project, and its menu counts and places the folders", async ({ page, request }) => {
  await useProjectsView(page);
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/beta` } })).json()) as { id: string };
  const other = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${other.chatId}/messages`, { data: { text: "beta for the head", mode: "normal" } });
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "alpha for the head");

  const head = page.getByTestId("focused-project");
  // The back chevron and the switch chevron are one control: the head is the project and its +.
  await expect(head.getByRole("button")).toHaveCount(2);
  await expect(head.locator(".focus-back")).toHaveCount(0);
  const button = head.locator(".focus-switch");
  await expect(button.locator(".project-name")).toHaveText("alpha");
  // The count is the menu's fact now, not the head's.
  await expect(button.locator(".group-count")).toHaveCount(0);
  await button.click();
  const menu = page.getByRole("menu", { name: "Project" });
  await expect(menu.getByRole("menuitem").first()).toHaveText(/^All projects\s*\d+$/);
  // The folders are the menu's choices: radios, and the folder you are in wears the check.
  await expect(menu.getByRole("menuitemradio", { name: /^alpha/ })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: /^beta/ })).toHaveAttribute("aria-checked", "false");
  // "Set an icon…" is an action on the folder, not a place: last, under its own rule.
  await expect(menu.getByRole("menuitem").last()).toContainText("Set an icon…");
  await expect(menu.locator('[role="separator"]')).toHaveCount(1);
  // A path is home-relative and cut in the middle: the root stays, and so does the folder's own name.
  const betaRow = menu.getByRole("menuitemradio", { name: /beta/ });
  const shown = (await betaRow.locator(".project-menu-path").textContent()) ?? "";
  expect(shown).toMatch(/^(\/tmp|~)\/…\/[a-z]+\/beta$/);
  expect(await betaRow.locator(".project-menu-path").getAttribute("title")).toBe(null);
  // The shortened line is for reading; the full path is one hover away.
  expect(await betaRow.getAttribute("title")).toBe(`${root}/beta`);
});

test("a collapsed sidebar leaves a 44 px rail on a wide screen, and nothing narrower", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "settled for the rail");
  // One chat waiting on an answer, so the amber count has something to count.
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await send(page, "please ask first, for the rail");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await showSidebar(page);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();

  const rail = page.locator(".sidebar-rail");
  await expect(rail).toBeVisible();
  // The collapse animates its column (the is-toggling path): measure the rail where it settles.
  await expect.poll(async () => Math.round((await rail.boundingBox())!.width)).toBe(44);
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect.poll(() => page.locator(".main").evaluate((el) => Math.round(el.getBoundingClientRect().left))).toBe(44);
  // The rail keeps the three actions and the one fact that matters.
  await expect(rail.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "New chat" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Search and commands" })).toBeVisible();
  // Each icon names its shortcut, as the app's own table has it.
  await expect(rail.getByRole("button", { name: "New chat" })).toHaveAttribute("title", /^(New chat \(Ctrl\+N\)|New chat \(⌘N\))$/);
  await expect(rail.getByRole("button", { name: "Search and commands" })).toHaveAttribute("title", /^(Search and commands \(Ctrl\+K\)|Search and commands \(⌘K\))$/);
  // The count rides its glyph's own corner and stays inside the 44 px strip.
  const badge = (await rail.locator(".rail-badge").first().boundingBox())!;
  const strip = (await rail.boundingBox())!;
  expect(badge.x + badge.width, "the badge is not clipped at the rail's edge").toBeLessThanOrEqual(strip.x + strip.width);
  const needs = rail.getByRole("button", { name: /^\d+ waiting on you$/ });
  await expect(needs).toBeVisible();

  // A count opens the list it counts, and a row opens that chat.
  await needs.click();
  const peek = page.getByRole("menu", { name: "Waiting on you" });
  await expect(peek.getByRole("menuitem", { name: /please ask first, for the rail/ })).toBeVisible();
  await peek.getByRole("menuitem", { name: /please ask first, for the rail/ }).click();
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await page.getByTestId("approval-card").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });

  // The tray's own things are at the rail's bottom: Usage, Theme and Settings.
  const usage = rail.getByRole("button", { name: "Usage", exact: true });
  await expect(usage).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Theme: / })).toBeVisible();
  const settings = rail.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  expect((await usage.boundingBox())!.y, "the cluster hangs at the bottom").toBeGreaterThan(strip.y + strip.height / 2);
  await settings.click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");

  // New chat and search are still one press away.
  await rail.getByRole("button", { name: "New chat" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a project folder" });
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await rail.getByRole("button", { name: "Search and commands" }).click();
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Reduced motion: no width animation, so the rail is 44 px in the click's own frame.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await rail.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  expect(Math.round((await rail.boundingBox())!.width)).toBe(44);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Narrower than 1100 px the rail goes: the old full hide, with the header's expand button.
  await page.setViewportSize({ width: 1080, height: 860 });
  await expect(rail).toHaveCount(0);
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect.poll(() => page.locator(".main").evaluate((el) => Math.round(el.getBoundingClientRect().left))).toBe(0);
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
});
