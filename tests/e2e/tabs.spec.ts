// Session tabs: several chats open at once, one shown; runs carry on in the
// tabs that are not.
import { expect, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const prompts = (page: Page) => page.getByTestId("user-prompt");
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open chats" }).getByRole("tab");
const tab = (page: Page, title: string) => page.getByRole("tablist", { name: "Open chats" }).getByRole("tab", { name: new RegExp(title) });
/** + on the strip: a tab at once, showing the start screen; the first send fills it in. */
async function newTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page.getByRole("heading", { name: /^What should .*(do in|work on)/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}
const session = (page: Page, title: string) => page.getByRole("complementary", { name: "Sessions" }).locator(".session", { hasText: title }).first();

test("+ opens another chat in its own tab; tabs switch and close", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first tab prompt");
  await expect(tabs(page)).toHaveCount(1);
  await newTab(page);
  // The tab is there before anything is sent, named for the chat to come.
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).last()).toContainText("New chat");
  await sendAndWait(page, "second tab prompt");
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "second tab prompt")).toHaveAttribute("aria-selected", "true");

  await tab(page, "first tab prompt").click();
  await expect(prompts(page)).toHaveText(["first tab prompt"]);
  await tab(page, "second tab prompt").click();
  await expect(prompts(page)).toHaveText(["second tab prompt"]);

  // Closing the shown tab shows its neighbour; the closed chat is still in the sidebar.
  await tab(page, "second tab prompt").getByRole("button", { name: /^Close / }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(prompts(page)).toHaveText(["first tab prompt"]);
  await showSidebar(page);
  await expect(session(page, "second tab prompt")).toBeVisible();
});

test("a new tab closes like any other, and the start screen comes back when the last one goes", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "only tab");
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(tabs(page)).toHaveCount(2);
  // A draft closes without leaving anything behind: the chat tab is shown again.
  await tabs(page).last().getByRole("button", { name: /^Close / }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(prompts(page)).toHaveText(["only tab"]);
  // Two drafts are two tabs; closing the last tab shows the start screen, no tab.
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(tabs(page)).toHaveCount(3);
  await tabs(page).last().getByRole("button", { name: /^Close / }).click();
  await tabs(page).last().getByRole("button", { name: /^Close / }).click();
  await tabs(page).last().getByRole("button", { name: /^Close / }).click();
  await expect(page.getByRole("tablist", { name: "Open chats" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^What should .* (do in|work on)/ })).toBeVisible();
});

test("a sidebar click shows a session in the current tab, Ctrl-click in a new one, an open one is switched to", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "session one");
  await newChat(page);
  await sendAndWait(page, "session two");
  // Sending from the start screen adds the new chat's tab; nothing was active to take over.
  await expect(tabs(page)).toHaveCount(2);

  // Close session one's tab so Ctrl+click has one to make; it opens beside the shown one.
  await tab(page, "session one").hover();
  await tab(page, "session one").getByRole("button", { name: /^Close / }).click();
  await expect(tabs(page)).toHaveCount(1);
  await showSidebar(page);
  await session(page, "session one").click({ modifiers: ["Control"] });
  await expect(prompts(page)).toHaveText(["session one"]);
  await expect(tabs(page)).toHaveCount(2);

  // Already open in a tab: switched to, not opened twice.
  await showSidebar(page);
  await session(page, "session two").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "session two")).toHaveAttribute("aria-selected", "true");
  await expect(prompts(page)).toHaveText(["session two"]);
});

test("a run keeps going in a background tab, which says when it is done", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow please");
  await newTab(page);
  await sendAndWait(page, "meanwhile here");
  const background = tab(page, "slow please");
  await expect(background.getByRole("img", { name: "Working" })).toBeVisible();
  await expect(background.getByRole("img", { name: "Finished while away" })).toBeVisible({ timeout: 20_000 });
  await background.click();
  await expect(page.getByTestId("answer").last()).toContainText("Echo: slow please");
  await expect(background.getByRole("img", { name: "Finished while away" })).toHaveCount(0);
});

test("tabs come back after a reload, and the keyboard moves between them", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "kept one");
  await newTab(page);
  await sendAndWait(page, "kept two");
  await page.reload();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "kept two")).toHaveAttribute("aria-selected", "true");
  await expect(prompts(page)).toHaveText(["kept two"]);

  await tab(page, "kept two").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "kept one")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(prompts(page)).toHaveText(["kept one"]);
  await page.keyboard.press("Delete");
  await expect(tabs(page)).toHaveCount(1);
  await expect(prompts(page)).toHaveText(["kept two"]);
});

/** Drag a tab with the mouse until its middle sits over `x` (a point on the page), in steps so the strip sees a drag. */
async function dragTab(page: Page, title: string, x: number): Promise<void> {
  const box = (await tab(page, title).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + (x < box.x + box.width / 2 ? -8 : 8), y, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

test("tabs reorder by dragging, pin from a menu, and move by keyboard; order and pins survive a reload", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "order alpha");
  await newTab(page);
  await sendAndWait(page, "order beta");
  await newTab(page);
  await sendAndWait(page, "order gamma");
  await expect(tabs(page)).toHaveText([/order alpha/, /order beta/, /order gamma/]);

  // The third tab dragged before the first. It was the shown tab and still is; the drag is not a click on another.
  const first = (await tab(page, "order alpha").boundingBox())!;
  await dragTab(page, "order gamma", first.x + 10);
  await expect(tabs(page)).toHaveText([/order gamma/, /order alpha/, /order beta/]);
  await expect(tab(page, "order gamma")).toHaveAttribute("aria-selected", "true");
  await expect(prompts(page)).toHaveText(["order gamma"]);

  // A drag that goes nowhere changes nothing, and a plain click still opens a tab.
  const beta = (await tab(page, "order beta").boundingBox())!;
  await page.mouse.move(beta.x + 40, beta.y + beta.height / 2);
  await page.mouse.down();
  await page.mouse.move(beta.x + 42, beta.y + beta.height / 2);
  await page.mouse.up();
  await expect(tabs(page)).toHaveText([/order gamma/, /order alpha/, /order beta/]);
  await expect(tab(page, "order beta")).toHaveAttribute("aria-selected", "true");

  // Pin from the tab's right-click menu: it moves to the left, narrow, with no close button.
  const wide = (await tab(page, "order beta").boundingBox())!.width;
  await tab(page, "order beta").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin tab" }).click();
  await expect(tabs(page)).toHaveText([/order beta/, /order gamma/, /order alpha/]);
  await expect(tab(page, "order beta").getByRole("button", { name: /^Close / })).toHaveCount(0);
  expect((await tab(page, "order beta").boundingBox())!.width).toBeLessThan(wide);
  // An unread tab shows its ✕ only on hover.
  await tab(page, "order gamma").hover();
  await expect(tab(page, "order gamma").getByRole("button", { name: /^Close / })).toHaveCount(1);

  // Neither Delete nor middle-click closes a pinned tab.
  await tab(page, "order beta").focus();
  await page.keyboard.press("Delete");
  await tab(page, "order beta").click({ button: "middle" });
  await expect(tabs(page)).toHaveCount(3);

  // A drag stays inside its group: an unpinned tab dragged over the pinned one does not pass it.
  const pinned = (await tab(page, "order beta").boundingBox())!;
  await dragTab(page, "order alpha", pinned.x + 5);
  await expect(tabs(page)).toHaveText([/order beta/, /order alpha/, /order gamma/]);

  // Alt+Shift+→ and ← move the focused tab inside its group, and the focus stays on it.
  await tab(page, "order alpha").focus();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(tabs(page)).toHaveText([/order beta/, /order gamma/, /order alpha/]);
  await expect(tab(page, "order alpha")).toBeFocused();
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await expect(tabs(page)).toHaveText([/order beta/, /order gamma/, /order alpha/]);
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(tabs(page)).toHaveText([/order beta/, /order alpha/, /order gamma/]);
  await expect(tab(page, "order alpha")).toBeFocused();

  // Kept on this device.
  await page.reload();
  await expect(tabs(page)).toHaveText([/order beta/, /order alpha/, /order gamma/]);
  await expect(tab(page, "order beta").getByRole("button", { name: /^Close / })).toHaveCount(0);
  // An unread tab shows its ✕ only on hover.
  await tab(page, "order alpha").hover();
  await expect(tab(page, "order alpha").getByRole("button", { name: /^Close / })).toHaveCount(1);

  // Unpin from the menu: it goes to the front of the others and the close button is back.
  await tab(page, "order beta").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin tab" }).click();
  await expect(tabs(page)).toHaveText([/order beta/, /order alpha/, /order gamma/]);
  // An unread tab shows its ✕ only on hover.
  await tab(page, "order beta").hover();
  await expect(tab(page, "order beta").getByRole("button", { name: /^Close / })).toHaveCount(1);
});

test("the palette pins and unpins the shown tab", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "palette first");
  await newTab(page);
  await sendAndWait(page, "palette second");
  await expect(tabs(page)).toHaveText([/palette first/, /palette second/]);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("pin tab");
  await page.getByRole("option", { name: /^Pin tab/ }).click();
  await expect(tabs(page)).toHaveText([/palette second/, /palette first/]);
  await expect(tab(page, "palette second").getByRole("button", { name: /^Close / })).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("unpin tab");
  await page.getByRole("option", { name: /^Unpin tab/ }).click();
  // An unread tab shows its ✕ only on hover.
  await tab(page, "palette second").hover();
  await expect(tab(page, "palette second").getByRole("button", { name: /^Close / })).toHaveCount(1);
});

test("Ctrl+[ and Ctrl+] step through the chats shown, Alt+Shift+T reopens a closed tab, Ctrl+Alt+Enter sends and starts a new chat", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "alpha chat");
  await newTab(page);
  await sendAndWait(page, "beta chat");

  await page.keyboard.press("Control+BracketLeft");
  await expect(prompts(page)).toHaveText(["alpha chat"]);
  await page.keyboard.press("Control+BracketRight");
  await expect(prompts(page)).toHaveText(["beta chat"]);

  await tab(page, "beta chat").getByRole("button", { name: /^Close / }).click();
  await expect(tabs(page)).toHaveCount(1);
  await page.keyboard.press("Alt+Shift+KeyT");
  await expect(tabs(page)).toHaveCount(2);
  await expect(prompts(page)).toHaveText(["beta chat"]);

  await page.getByRole("textbox", { name: "Message" }).fill("send then new");
  await page.keyboard.press("Control+Alt+Enter");
  await expect(tabs(page)).toHaveCount(3);
  await expect(page.getByRole("heading", { name: /^What should .* do in / })).toBeVisible();
  await tab(page, "beta chat").click();
  await expect(prompts(page)).toHaveText(["beta chat", "send then new"]);
});

test("the sidebar lifts what needs you and what is working, and settling can be undone", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "settle me later");
  await newTab(page);
  await send(page, "please ask first");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await tab(page, "settle me later").click();
  await showSidebar(page);
  const needs = page.getByTestId("needs-group");
  await expect(needs).toContainText("please ask first", { timeout: 10_000 });
  await expect(needs).toContainText("needs you");

  await tab(page, "please ask first").click();
  await page.getByTestId("approval-card").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await send(page, "slow stream in the background");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await tab(page, "settle me later").click();
  const working = page.getByTestId("working-group");
  await expect(working).toBeVisible({ timeout: 10_000 });
  await expect(working.getByRole("button", { name: /Working/ })).toHaveAttribute("aria-expanded", "false");
  await working.getByRole("button", { name: /Working/ }).click();
  await expect(working).toContainText("please ask first");
  await expect(working).toHaveCount(0, { timeout: 20_000 });

  const row = page.locator(".session-item", { hasText: "settle me later" }).first();
  await row.locator(".session").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle" }).click();
  await expect(page.getByTestId("toast")).toContainText("Settled “settle me later”");
  await expect(page.locator(".session-item", { hasText: "settle me later" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1 settled" })).toBeVisible();
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyZ");
  await expect(page.locator(".session-item", { hasText: "settle me later" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "1 settled" })).toHaveCount(0);
});

test("a row's menu opens its session in a new tab, next to the shown one", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "menu tab one");
  // Closed so the row's "Open in new tab" has a tab to make (the chat keeps running).
  await tab(page, "menu tab one").hover();
  await tab(page, "menu tab one").getByRole("button", { name: /^Close / }).click();
  await expect(tabs(page)).toHaveCount(0);
  await newChat(page);
  await sendAndWait(page, "menu tab two");
  await expect(tabs(page)).toHaveCount(1);

  await showSidebar(page);
  await page.getByRole("button", { name: "More for menu tab one" }).click();
  await page.getByRole("menuitem", { name: "Open in new tab" }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "menu tab one")).toHaveAttribute("aria-selected", "true");
  await expect(prompts(page)).toHaveText(["menu tab one"]);
  await expect(tab(page, "menu tab two")).toHaveAttribute("aria-selected", "false");
});

test("a row's menu opens where it was asked for, as wide as its items, inside the window", async ({ page }) => {
  // The menu pops in scaled; measure it where it settles.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "menu placed");
  await showSidebar(page);
  const row = session(page, "menu placed");
  const menu = page.getByRole("menu");
  const rowBox = (await row.boundingBox())!;

  await row.click({ button: "right", position: { x: 20, y: 10 } });
  let box = (await menu.boundingBox())!;
  expect(box.x).toBeCloseTo(rowBox.x + 20, 0);
  // The menu anchors to the click point (RowMenu's own rule): under it, or over it when it does not fit below.
  const clickY = rowBox.y + 10;
  const below = box.y >= clickY + 1;
  const above = box.y + box.height <= clickY - 1;
  expect(below || above).toBe(true);
  expect(box.width).toBeLessThan(300);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Too near the window's bottom to open downwards: the menu opens above its ⋯ button.
  await page.setViewportSize({ width: 1280, height: Math.ceil(rowBox.y + rowBox.height) + 200 });
  const more = page.getByRole("button", { name: "More for menu placed" });
  await more.click();
  const moreBox = (await more.boundingBox())!;
  box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(moreBox.y);
  expect(box.x + box.width).toBeCloseTo(moreBox.x + moreBox.width, 0);
  expect(box.width).toBeLessThan(300);
});

test("Copy resume command puts the line that resumes a session in a terminal on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAndOpen(page);
  await newChat(page);
  // No chat exists until a send, so its actions menu appears only after one.
  await sendAndWait(page, "resume me in a terminal");
  const menu = page.getByRole("button", { name: "Chat actions" });
  const item = page.getByRole("menuitem", { name: "Copy resume command" });
  await menu.click();
  await item.click();
  const line = /^cd \S+alpha && fake --resume \S+$/;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(line);
  // The chat is open here, a second writer if left open: the banner says so and can close it.
  const banner = page.getByRole("status").filter({ hasText: "Copied: cd " });
  await expect(banner).toContainText("close the chat here first");
  await banner.getByRole("button", { name: "Close chat" }).click();
  await expect(page.getByRole("tablist", { name: "Open chats" }).getByRole("tab", { name: /resume me in a terminal/ })).toHaveCount(0);
  // Its row copies the same line, without the warning now that nothing here has it open.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await showSidebar(page);
  await session(page, "resume me in a terminal").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy resume command" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(line);
  await expect(page.getByRole("status").filter({ hasText: "Copied: cd " })).not.toContainText("close the chat");
});

test("a session opens at once: its tab, title, and a loading screen show while it loads", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "slow to load");
  // Its tab closes, so the sidebar's click opens it again (the chat still runs on the server).
  await tab(page, "slow to load").hover();
  await tab(page, "slow to load").getByRole("button", { name: /^Close / }).click();
  await newChat(page);
  await sendAndWait(page, "shown meanwhile");
  // Hold the chat's snapshot back, as a slow link would.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/chats\/[\w-]+$/, async (route) => {
    if (route.request().method() === "GET") await held;
    await route.continue();
  });
  await showSidebar(page);
  await session(page, "slow to load").click();
  const splash = page.getByRole("status", { name: "Opening slow to load" });
  await expect(splash).toBeVisible();
  await expect(page.locator(".chat-header h1")).toHaveText("slow to load");
  await expect(tab(page, "slow to load")).toHaveAttribute("aria-selected", "true");
  release();
  await expect(prompts(page)).toHaveText(["slow to load"]);
  await expect(splash).toHaveCount(0);
  await page.unroute(/\/api\/chats\/[\w-]+$/);
});

test("a long chat draws its end first, then the rest above it", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  for (let i = 1; i <= 9; i++) await sendAndWait(page, `long chat turn ${i}`);
  await newTab(page);
  await page.reload();
  await tab(page, "long chat turn 1").click();
  await expect(prompts(page)).toHaveCount(9);
  await expect(prompts(page).last()).toHaveText("long chat turn 9");
  // The end is what you see first: the scroller lands at its bottom, not partway down.
  await expect
    .poll(() => page.locator(".conversation").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)), { timeout: 10_000 })
    .toBeLessThanOrEqual(1);
});

test("a session can be snoozed until a time you pick", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "snooze me later");
  await showSidebar(page);
  const row = page.locator(".session-item", { hasText: "snooze me later" }).first();
  await row.locator(".session").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Snooze until a time…" }).click();
  const dialog = page.getByRole("dialog", { name: "Snooze until" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Wake it at").fill("2027-03-04T09:30");
  await dialog.getByRole("button", { name: "Snooze", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("toast")).toContainText("snooze me later");
  await expect(page.locator(".session-item", { hasText: "snooze me later" })).toHaveCount(0);
  // Under "N snoozed" until then, and waking it puts it back for good.
  await page.getByRole("button", { name: "1 snoozed" }).click();
  const back = page.locator(".session-item", { hasText: "snooze me later" });
  await expect(back).toHaveCount(1);
  await back.first().locator(".session").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Wake now" }).click();
  await expect(page.getByRole("button", { name: "1 snoozed" })).toHaveCount(0);
});

test("a session can be marked unread, and opening it marks it read", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "unread me");
  await showSidebar(page);
  const row = page.locator(".session-item", { hasText: "unread me" }).first();
  await row.locator(".session").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark unread" }).click();
  await expect(row.locator(".session-unread")).toBeVisible();
  // Opening it here is reading it: the dot goes without a word.
  await row.locator(".session").click();
  await expect(row.locator(".session-unread")).toHaveCount(0);
});

test("a session can be snoozed until the limit resets", async ({ page }) => {
  // The fake harness reports no limits: stand in for a limited account with a reset ahead.
  const reset = Date.now() + 2 * 3_600_000;
  await page.route("**/api/limits", (route) =>
    route.fulfill({
      json: {
        accounts: [{ id: "claude", source: "Claude Code", provider: "anthropic", limited: true, at: Date.now(), windows: [{ label: "5 hours", used: 1, resetsAt: reset }] }],
        errors: [],
      },
    }),
  );
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "limit snooze me");
  await showSidebar(page);
  const row = page.locator(".session-item", { hasText: "limit snooze me" }).first();
  await row.locator(".session").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Until the limit resets" }).click();
  await expect(page.getByTestId("toast")).toContainText("limit snooze me");
  await expect(page.locator(".session-item", { hasText: "limit snooze me" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1 snoozed" })).toBeVisible();
});

test("a project's folder shows its own monogram", async ({ page }) => {
  await signInAndOpen(page);
  await showSidebar(page);
  // alpha is the project here: its badge is A, and the hue is part of the look.
  const badge = page.locator(".project-badge").first();
  await expect(badge).toHaveText("A");
  await expect(badge).toHaveCSS("filter", /hue-rotate/);
});

test("a project's icon can be set on this device", async ({ page }) => {
  await signInAndOpen(page);
  await showSidebar(page);
  const head = page.getByTestId("focused-project");
  // The folder switcher, not the "New chat in alpha" button beside it.
  await head.locator(".focus-switch").click();
  await page.getByRole("menuitem", { name: "Set an icon…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Icon for / });
  await dialog.getByLabel(/A letter or an emoji/).fill("★");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".project-badge").first()).toHaveText("★");
  // It lives in this browser: a reload keeps it.
  await page.reload();
  await showSidebar(page);
  await expect(page.locator(".project-badge").first()).toHaveText("★");
});

test("a selection of sessions can be settled at once, and undone", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first selectable");
  await newTab(page);
  await sendAndWait(page, "second selectable");
  await showSidebar(page);
  const row = (name: string) => page.locator(".session-item", { hasText: name }).first();

  await row("first selectable").locator(".session").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Select sessions" }).click();
  const bar = page.locator(".selection-bar");
  await expect(bar).toContainText("1 selected");
  // Shift extends from the anchor to the row clicked, in the order shown.
  await row("second selectable").locator(".session").click({ modifiers: ["Shift"] });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Settle" }).click();
  await expect(page.getByTestId("toast")).toContainText("2 sessions updated");
  await expect(page.locator(".session-item", { hasText: "first selectable" })).toHaveCount(0);
  await expect(page.locator(".session-item", { hasText: "second selectable" })).toHaveCount(0);
  await expect(bar).toHaveCount(0);

  // One undo puts both back.
  await page.locator(".chat-header h1").click();
  await page.keyboard.press("Control+KeyZ");
  await expect(page.locator(".session-item", { hasText: "first selectable" })).toHaveCount(1);
  await expect(page.locator(".session-item", { hasText: "second selectable" })).toHaveCount(1);
});

test("the shown tab's underline glides to the tab picked, and reduced motion makes it jump", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "glide alpha");
  await newTab(page);
  await sendAndWait(page, "glide beta");
  const line = page.locator(".tab-active-line");
  await expect(line).toBeVisible();
  const betaBox = (await tab(page, "glide beta").boundingBox())!;
  // On the second tab, the line sits inside its span.
  const onBeta = (await line.boundingBox())!;
  expect(onBeta.x + onBeta.width / 2).toBeGreaterThanOrEqual(betaBox.x);
  expect(onBeta.x + onBeta.width / 2).toBeLessThanOrEqual(betaBox.x + betaBox.width);

  // Picking the first tab starts a glide: the line's transition moves both edges.
  await tab(page, "glide alpha").click();
  const transition = await line.evaluate((node) => getComputedStyle(node).transitionProperty);
  expect(transition).toContain("left");
  await expect.poll(async () => {
    const b = (await line.boundingBox())!;
    const a = (await tab(page, "glide alpha").boundingBox())!;
    return b.x + b.width / 2 >= a.x && b.x + b.width / 2 <= a.x + a.width;
  }).toBe(true);

  // Reduced motion: the glide has no duration at all.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const duration = await line.evaluate((node) => getComputedStyle(node).transitionDuration);
  expect(duration).toBe("0s");
});
