// The sidebar's menus, keyboard and focus: the row menu's task groups, the keys every menu answers
// (arrows, Home/End, Escape back to its opener), the list as one tab stop, and the collapsed rail.
import { expect, test, type Page } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen, useProjectsView } from "./helpers.js";


/** A theme colour as the browser paints it (a token can be a hex, a mix, or a color() function). */
async function paintedColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

/** A second project (beta) holding sessions of its own, so focus mode has somewhere to leak from. */
async function seedBeta(page: Page, request: import("@playwright/test").APIRequestContext, text: string): Promise<void> {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/beta` } })).json()) as { id: string };
  const other = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${other.chatId}/messages`, { data: { text, mode: "normal" } });
}
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
  // Four tasks, three rules when Move is present: open, mark and snooze, organise (Select + Move), archive.
  expect(marks).toHaveLength(3);
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
  // Select and Move sit on one side of the same rule (the organise group), Archive on the other.
  expect(shape.indexOf("Select sessions")).toBe(marks[1]! + 1);
  // Archive is the last thing a row's menu says, whatever else it can do.
  // Every row leads with a glyph, Select included.
  expect(shape.at(-1)).toBe("Archive");
  const glyphs = await page.getByRole("menu").getByRole("menuitem").evaluateAll((items) => items.map((item) => item.querySelector("svg.icon") !== null));
  expect(glyphs.every(Boolean)).toBe(true);

  // Snooze folds its choices out under its own row, so the menu stays short until it is asked.
  await page.getByRole("menuitem", { name: "Snooze", exact: true }).click();
  const folded = await menuShape(page);
  expect(folded.slice(folded.indexOf("Snooze") + 1, folded.indexOf("Select sessions")).filter((row) => row !== "|")).toEqual(["For an hour", "Until tomorrow", "Until next week", "Until a time…"]);
});

test("a row menu flipped above clears its own row's title", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 560 });
  await signInAndOpen(page);
  for (const text of ["menu above one", "menu above two", "menu above three"]) {
    await newChat(page);
    await sendAndWait(page, text);
  }
  await showSidebar(page);
  // The newest row sits near the list's bottom third; a long menu cannot fit under it.
  await page.locator(".session-item", { hasText: "menu above one" }).first().locator(".session").click({ button: "right" });
  const box = await page.evaluate(() => {
    const menu = document.querySelector(".row-menu")!.getBoundingClientRect();
    const row = document.querySelector(".session-item.is-menu-open .session")!.getBoundingClientRect();
    return { menuBottom: menu.bottom, rowTop: row.top };
  });
  expect(box.menuBottom, "the menu's foot clears the row").toBeLessThanOrEqual(box.rowTop + 0.5);
  await page.keyboard.press("Escape");
});

test("a Recent row menu is 32px, with Select joining the state group", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "menu compact without move");
  await showSidebar(page);
  await page.locator(".session-item", { hasText: "menu compact without move" }).first().locator(".session").click({ button: "right" });
  // In Recent there is no Move pair: Select joins the state group and two rules separate three tasks.
  expect((await menuShape(page)).filter((row) => row === "|")).toHaveLength(2);
  const pitch = await page.getByRole("menuitem", { name: "Pin", exact: true }).evaluate((el) => el.getBoundingClientRect().height);
  expect(pitch, "not the shared menu rule's 37px items").toBeLessThanOrEqual(33);
  expect(pitch).toBeGreaterThanOrEqual(28);
});

test("Tab closes the row menu and moves the focus on, and so does the view menu", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "menu tab close");
  await showSidebar(page);
  const row = page.locator(".session-item", { hasText: "menu tab close" }).first().locator(".session");
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Sidebar view: Recent" }).click();
  await expect(page.getByRole("menu", { name: "Sidebar view" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu", { name: "Sidebar view" })).toHaveCount(0);
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

test("the filter dialog keeps native Tab and radio keys, and Escape returns to its trigger", async ({ page }) => {
  await signInAndOpen(page);
  const trigger = page.getByRole("button", { name: /^Filters/ });
  await trigger.click();
  const menu = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(menu).toBeVisible();
  // A form keeps the trigger's focus on open; native Tab reaches its first visible control.
  await page.keyboard.press("Tab");
  await expect(menu.getByRole("radio").first()).toBeFocused();
  const running = menu.getByRole("radio", { name: /^Running/ });
  await running.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("radio", { name: /^Needs you/ })).toBeChecked();
  // A native radio group is one Tab stop; Tab then reaches each enabled command in document order.
  // The checked Show radio owns its group's native Tab stop; the following six are distinct controls.
  await page.getByRole("radio", { name: /^Needs you/ }).focus();
  const names = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    names.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | HTMLButtonElement;
      return el.tagName === "INPUT" ? el.name || el.getAttribute("aria-describedby") : (el.textContent ?? "").trim();
    }));
  }
  expect(names).toEqual(["filter-hint-sleeping", "filter-hint-defaultBranch", "filter-hint-automation", "filter-hint-agent", "New room", "Refresh sessions"]);
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

test("the focus head has a separate All projects back button beside its switch, and the switch menu counts and places the folders", async ({ page, request }) => {
  await useProjectsView(page);
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/beta` } })).json()) as { id: string };
  const other = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${other.chatId}/messages`, { data: { text: "beta for the head", mode: "normal" } });
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "alpha for the head");

  const head = page.getByTestId("focused-project");
  // Back is its own button, not a chevron that opens the switch menu: the head is back + switch + new chat.
  await expect(head.getByRole("button")).toHaveCount(3);
  const back = head.getByRole("button", { name: "All projects", exact: true });
  await expect(back).toBeVisible();
  await expect(back).toHaveCSS("width", "24px");
  await expect(back.locator("svg")).toHaveCSS("color", await back.evaluate((el) => getComputedStyle(el).color));
  const button = head.locator(".focus-switch");
  // The name shares the rows' title edge; no badge or duplicate back disclosure competes with it.
  await expect(button.locator(".project-badge")).toHaveCount(0);
  await expect(button.locator(".focus-back-chevron")).toHaveCount(0);
  await expect(button.locator(".project-name")).toHaveText("alpha");
  const edges = await page.evaluate(() => {
    const name = document.querySelector(".focus-switch .project-name")?.getBoundingClientRect();
    const title = document.querySelector(".focus-group .session-title")?.getBoundingClientRect();
    return name && title ? { name: name.left, title: title.left } : null;
  });
  expect(edges).not.toBeNull();
  expect(Math.abs((edges?.name ?? 0) - (edges?.title ?? 99)), "the focus name starts on the titles' edge").toBeLessThanOrEqual(0.5);
  // The count is the menu's fact now, not the head's.
  await expect(button.locator(".group-count")).toHaveCount(0);
  await button.click();
  const menu = page.getByRole("menu", { name: "Project" });
  await expect(menu.getByRole("menuitem").first()).toHaveText(/^All projects\s*\d+$/);
  // The folders are the menu's choices: radios, and the folder you are in wears the check.
  await expect(menu.getByRole("menuitemradio", { name: /^alpha/ })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: /^beta/ })).toHaveAttribute("aria-checked", "false");
  const countEdges = await menu.locator(".group-count").evaluateAll((counts) => counts.map((el) => el.getBoundingClientRect().right));
  expect(Math.max(...countEdges) - Math.min(...countEdges), "all project counts end on one column").toBeLessThanOrEqual(0.5);
  await expect(menu.locator(".project-menu-check").first()).toHaveCSS("width", "13px");
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
  // Working and Waiting are exclusive buckets: a slow sibling supplies the first, an approval the second.
  await newChat(page);
  await send(page, "slow stream for the rail");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await newChat(page);
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
  // The rail names its harness: a 32px mark first, opening the same harness menu as the head's title.
  const mark = rail.getByRole("button", { name: /^Harness: / });
  await expect(mark).toBeVisible();
  expect(Math.round((await mark.boundingBox())!.height)).toBe(32);
  const expand = await rail.getByRole("button", { name: "Expand sidebar" }).boundingBox();
  expect(Math.round((await mark.boundingBox())!.y), "the mark leads the rail").toBeLessThan(expand!.y);
  await mark.click();
  await expect(page.getByRole("listbox", { name: "Harness" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rail.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "New chat", exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Search and commands" })).toBeVisible();
  // Each icon names its shortcut, as the app's own table has it.
  await expect(rail.getByRole("button", { name: "New chat", exact: true })).toHaveAttribute("title", /^(New chat \(Ctrl\+N\)|New chat \(⌘N\))$/);
  await expect(rail.getByRole("button", { name: "Search and commands" })).toHaveAttribute("title", /^(Search and commands \(Ctrl\+K\)|Search and commands \(⌘K\))$/);
  // The count rides its glyph's own corner and stays inside the 44 px strip.
  const badge = (await rail.locator(".rail-badge").first().boundingBox())!;
  const strip = (await rail.boundingBox())!;
  expect(badge.x + badge.width, "the badge is not clipped at the rail's edge").toBeLessThanOrEqual(strip.x + strip.width);
  const needs = rail.getByRole("button", { name: /^\d+ waiting on you$/ });
  const running = rail.getByRole("button", { name: /^\d+ running$/ });
  await expect(running).toBeVisible();
  await expect(running.getByRole("img", { name: "Working" })).toBeVisible();
  await expect(running.locator(".rail-badge")).toHaveCSS("box-shadow", "none");
  await expect(running.locator(".rail-badge")).toHaveCSS("color", await paintedColor(page, "--text-2"));
  await running.click();
  await expect(page.getByRole("menu", { name: "Running", exact: true }).getByRole("menuitem", { name: /slow stream for the rail/ })).toBeVisible();
  await page.keyboard.press("Escape");
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
  await rail.getByRole("button", { name: "New chat", exact: true }).click();
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

test("focus mode scopes the Needs-you and Working sections to the focused project", async ({ page, request }) => {
  await useProjectsView(page);
  // beta holds a chat waiting on an answer; alpha is the folder on screen.
  await seedBeta(page, request, "please ask first, in beta for the focus scope");
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "an alpha chat for the focus scope");
  await showSidebar(page);
  const head = page.getByTestId("focused-project");
  await expect(head.locator(".project-name")).toHaveText("alpha");
  // The head says alpha, so a needs-you row from beta must not stand under it. The shared server may
  // hold other specs' waiting chats, but beta's must never leak into alpha's focused section.
  const needs = page.getByTestId("needs-group");
  await expect(needs.locator(".session", { hasText: "please ask first, in beta for the focus scope" })).toHaveCount(0);
  // Out of focus, the same waiting chat is back in the global section.
  await head.getByRole("button", { name: "All projects", exact: true }).click();
  await expect(needs).toHaveCount(1);
  await expect(needs.locator(".session", { hasText: "please ask first, in beta for the focus scope" })).toHaveCount(1);
});

test("the focused rows sit at the list's own edge, not indented 24px under a headless sibling", async ({ page, request }) => {
  await useProjectsView(page);
  await seedBeta(page, request, "beta for the focus indent");
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "alpha for the focus indent");
  await showSidebar(page);
  await expect(page.getByTestId("focused-project").locator(".project-name")).toHaveText("alpha");
  await expect(page.locator(".focus-group .session-sublist")).toHaveCSS("padding-left", "0px");
});

test("Tab reaches All projects in the focused head and Enter shows every folder", async ({ page, request }) => {
  await useProjectsView(page);
  await seedBeta(page, request, "beta for the back button's keyboard");
  await signInAndOpen(page, "alpha");
  // A chat on screen, not the start screen a fresh New chat leaves: the sidebar's rows are live then.
  await sendAndWait(page, "alpha for the back button's keyboard");
  await showSidebar(page);
  const head = page.getByTestId("focused-project");
  await expect(head.locator(".project-name")).toHaveText("alpha");
  const back = head.getByRole("button", { name: "All projects", exact: true });
  await back.focus();
  await expect(back).toBeFocused();
  // Shift+Tab from the switch button is the back button: it precedes the switch in the tab order.
  await head.locator(".focus-switch").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(back).toBeFocused();
  // Tab forward from the back button returns to the switch, and Shift+Tab leaves it on the back button.
  await page.keyboard.press("Tab");
  await expect(head.locator(".focus-switch")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(head).toHaveCount(0);
  // Every folder, not a count the shared server's other specs would change.
  await expect(page.getByTestId("project-group").locator(".project-name", { hasText: /^alpha$/ })).toHaveCount(1);
  await expect(page.getByTestId("project-group").locator(".project-name", { hasText: /^beta$/ })).toHaveCount(1);
});

test("the focused head's back chevron is muted, never the current project's accent", async ({ page, request }) => {
  await useProjectsView(page);
  await seedBeta(page, request, "beta for the muted chevron");
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "alpha for the muted chevron");
  await showSidebar(page);
  const back = page.getByTestId("focused-project").getByRole("button", { name: "All projects", exact: true });
  await expect(back.locator("svg")).toHaveCSS("color", await paintedColor(page, "--muted-text"));
});
