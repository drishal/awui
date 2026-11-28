// awui on a phone: a 390×844 touch screen. Gestures are real touch events
// (DevTools' Input.dispatchTouchEvent): a long press on a message opens its
// actions, a swipe from the left edge opens the drawer, a drag down on a
// sheet's handle closes it. Also stopping a run from the composer, Search in
// the chat menu, tabs in the drawer, the home-screen shortcuts, a share from
// another app arriving in a new chat's composer, the composer's settings folded
// into one chip, and the permission list kept on screen from its row in that sheet.
import { expect, test, type Page } from "@playwright/test";
import { newChat, openChat, send, sendAndWait, signInAndOpen } from "./helpers.js";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function touch(page: Page, points: Array<{ type: "touchStart" | "touchMove" | "touchEnd"; x: number; y: number; waitMs?: number }>) {
  const cdp = await page.context().newCDPSession(page);
  for (const p of points) {
    await cdp.send("Input.dispatchTouchEvent", { type: p.type, touchPoints: p.type === "touchEnd" ? [] : [{ x: p.x, y: p.y }] });
    if (p.waitMs) await page.waitForTimeout(p.waitMs);
  }
}

async function center(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("a long press on a message opens its actions as a sheet, and a drag down on the handle closes it", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await newChat(page);
  await page.keyboard.press("Escape");
  await sendAndWait(page, "hello from a phone");
  const at = await center(page, '[data-testid="user-prompt"]');
  await touch(page, [
    { type: "touchStart", ...at, waitMs: 700 },
    { type: "touchEnd", ...at },
  ]);
  const sheet = page.getByRole("dialog", { name: "Message" });
  await expect(sheet).toBeVisible();
  // The sheet's header says when the message was sent.
  await expect(sheet.getByRole("heading")).toHaveText(/^Message · .*\d{1,2}:\d{2}/);
  await expect(sheet.getByRole("menuitem", { name: "Copy", exact: true })).toBeVisible();
  await expect(sheet.getByRole("menuitem", { name: "Retry" })).toBeVisible();
  // Drag its handle down past the threshold.
  const grip = await center(page, "dialog[open] .sheet-grip");
  await touch(page, [
    { type: "touchStart", ...grip },
    { type: "touchMove", x: grip.x, y: grip.y + 60 },
    { type: "touchMove", x: grip.x, y: grip.y + 160 },
    { type: "touchEnd", x: grip.x, y: grip.y + 160 },
  ]);
  await expect(sheet).toBeHidden();
});

test("a swipe from the left edge opens the drawer and a swipe left closes it", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await newChat(page);
  await page.keyboard.press("Escape");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).not.toHaveClass(/is-open/);
  await touch(page, [
    { type: "touchStart", x: 6, y: 420 },
    { type: "touchMove", x: 60, y: 424 },
    { type: "touchMove", x: 140, y: 426 },
    { type: "touchEnd", x: 140, y: 426 },
  ]);
  await expect(sidebar).toHaveClass(/is-open/);
  await touch(page, [
    { type: "touchStart", x: 300, y: 420 },
    { type: "touchMove", x: 200, y: 422 },
    { type: "touchEnd", x: 120, y: 422 },
  ]);
  await expect(sidebar).not.toHaveClass(/is-open/);
});

test("a running chat stops from the composer's Stop; Search lives in the chat menu", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await newChat(page);
  await page.keyboard.press("Escape");
  await send(page, "slow stream please");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  // Stop is on the screen, not scrolled into by the test: the folded row used to hold Steer, Follow-up and Stop
  // beside the box and the ring, and Stop sat 60 px past the right edge. (A clipped app frame cannot be scrolled
  // sideways to reach it, so this is also what keeps `overflow: clip` honest.)
  const stopBox = await page.getByRole("button", { name: "Stop the agent" }).boundingBox();
  expect(stopBox!.x).toBeGreaterThanOrEqual(0);
  expect(stopBox!.x + stopBox!.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Stop the agent" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
  // The header's Search button is folded into the chat menu here.
  await expect(page.getByRole("button", { name: "Commands" })).toBeHidden();
  await page.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "Search and commands" }).click();
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
});

test("open tabs move into the drawer, and the home-screen shortcuts open a new chat or the sessions", async ({ page }) => {
  // Two tabs, made where the strip shows, then a phone.
  await page.setViewportSize({ width: 1200, height: 800 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "first tab");
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await sendAndWait(page, "second tab");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".tab-strip")).toBeHidden();
  await page.getByRole("button", { name: "Open menu" }).click();
  const tabs = page.getByRole("navigation", { name: "Open tabs" });
  await expect(tabs.getByRole("button", { name: /^first tab/ })).toBeVisible();
  await tabs.getByRole("button", { name: /^first tab/ }).click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/is-open/);
  await expect(page.getByTestId("user-prompt").first()).toHaveText("first tab");

  await page.goto("/?sessions=1");
  await expect(page.locator(".sidebar")).toHaveClass(/is-open/);
  await expect(page).not.toHaveURL(/[?](sessions|new)=/);
  await page.goto("/?new=1");
  // The start screen, whichever of its two headings the restored folder allows
  // (the live folder comes back from the server, which can lag a loaded suite).
  await expect(page.getByRole("heading", { name: /^What should .* (do in|work on)/ })).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/[?](sessions|new)=/);
});

test("a share from another app opens a new chat with the text and image in its composer", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  // The worker has to control the page before it can take a share.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.controller !== null || new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", () => r(true))));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
  // What Android's share sheet sends: a multipart POST to the manifest's share_target.
  const status = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("text", "look at this screenshot");
    form.append("images", new File([bytes], "shot.png", { type: "image/png" }));
    const res = await fetch("/share", { method: "POST", body: form, redirect: "manual" });
    return res.type === "opaqueredirect" ? 303 : res.status;
  }, png);
  expect(status).toBe(303);
  await page.goto("/?share=1");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("look at this screenshot");
  await expect(page.getByRole("list", { name: "Attached images" }).getByRole("listitem")).toHaveCount(1);
});

test("a phone composer folds its pickers into one settings chip", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await openChat(page);
  // Folded to one row while idle, the card still says which model answers: the chip is that row's one
  // setting, and the pickers' own row stays out of the way.
  const chip = page.getByTestId("config-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Fake Echo");
  await expect(chip).toContainText("Low");
  const settingsGeometry = await chip.boundingBox();
  const cardGeometry = await page.locator(".composer-card").boundingBox();
  expect(settingsGeometry, "the phone settings button exists").not.toBeNull();
  expect(cardGeometry, "the phone composer exists").not.toBeNull();
  // Full width, not the old 40vw cutoff that clipped role and effort after only two characters.
  expect(settingsGeometry!.width).toBeGreaterThanOrEqual(cardGeometry!.width - 14);
  expect(settingsGeometry!.height).toBeGreaterThanOrEqual(44);
  // The folded row's own words fit the box the chip leaves it: "Message the agent…" is 146px in a 112px box, so
  // the row read "Message the …". The placeholder stays one word plus its ellipsis, and the box stays unclipped.
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute("data-placeholder", "Message…");
  const fitted = await page.getByRole("textbox", { name: "Message" }).evaluate((el) => {
    const probe = document.createElement("span");
    probe.textContent = el.getAttribute("data-placeholder") ?? "";
    const cs = getComputedStyle(el);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`;
    el.appendChild(probe);
    const natural = probe.getBoundingClientRect().width;
    probe.remove();
    return { natural, box: el.getBoundingClientRect().width };
  });
  expect(fitted.natural).toBeLessThan(fitted.box - 8);
  // And the model it still states reads at the chip's 12px, not the 11.5px footer size it was cut to.
  await expect(chip).toHaveCSS("font-size", "12px");
  expect(await chip.locator(".config-summary").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(page.locator(".composer-pickers")).toBeHidden();
  // Writing opens the card; the same chip then carries the whole summary (harness, effort, mode).
  await page.getByRole("textbox", { name: "Message" }).click();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Fake");
  await expect(page.getByTestId("context-ring")).toHaveAccessibleName(/^Context used: \d+% of 100K/);
  await expect(page.locator(".context-pct")).toBeVisible();
  await expect(page.locator(".context-pct")).toHaveCSS("font-size", "10px");
  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Chat settings" });
  await expect(sheet).toBeVisible();
  // The harness is inline (changing it is a handoff); the chat's own one is checked.
  await expect(sheet.getByRole("button", { name: /^Fake This chat/ })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: /Fake B/ })).toContainText("Copies the conversation");
  // A row opens that picker's own sheet over this one; picking closes both.
  await sheet.getByRole("button", { name: /Fake Echo/ }).click();
  const models = page.getByRole("listbox", { name: "Models" });
  await expect(models.getByRole("option", { name: /Fake Slow/ })).toBeVisible();
  await models.getByRole("option", { name: /Fake Slow/ }).click();
  await expect(sheet).toBeHidden();
  await expect(chip).toContainText("Fake Slow");
});

test("a phone keeps prompts and tool rows compact", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  // A long prompt clamps at four lines on a phone (six on a wide screen).
  await newChat(page);
  const long = Array.from({ length: 10 }, (_, i) => `line ${i + 1} of a prompt long enough to wrap twice over on a phone screen`).join("\n");
  await sendAndWait(page, long);
  const bubble = page.getByTestId("user-prompt").last();
  await expect(bubble).toHaveClass(/is-clamped/);
  const box = await bubble.evaluate((el) => ({ height: el.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(el).lineHeight) }));
  expect(box.height).toBeLessThanOrEqual(4 * box.line + 16.5);
  // A tool call is a line and, when it has facts, a muted second line under it: ten of them must not be a screen and a half.
  await newChat(page);
  // One call is its own card, its row in view.
  await sendAndWait(page, "tool please");
  const row = page.locator(".drow-head").first();
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(58);
});

test("the permission list opens on screen from the settings sheet", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await openChat(page);
  // On a phone the composer's pickers live behind one chip; the folded card
  // opens when the box takes focus.
  await page.getByRole("textbox", { name: "Message" }).click();
  await page.getByTestId("config-chip").click();
  await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("permission-picker").click();
  const list = page.getByRole("listbox", { name: "Permission mode" });
  await expect(list.getByRole("option", { name: "Accept edits" })).toBeVisible();
  // It pops in scaled (the placement must not depend on that): measure it where it settles.
  await list.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = (await list.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 8);
});

test("a long press on a reply offers Copy turn as Markdown", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await newChat(page);
  await page.keyboard.press("Escape");
  await sendAndWait(page, "please edit the app");
  const at = await center(page, '[data-testid="answer"]');
  await touch(page, [
    { type: "touchStart", ...at, waitMs: 700 },
    { type: "touchEnd", ...at },
  ]);
  await page.getByRole("dialog", { name: /^Reply/ }).getByRole("menuitem", { name: "Copy turn as Markdown" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/## Prompt\n\nplease edit the app[\s\S]*- \*\*Edit\*\* `src\/app\.ts`[\s\S]*## Answer/);
});

test("the start screen's composer stands on the same floor as a chat's", async ({ page }) => {
  await signInAndOpen(page);
  // The pane's own floor, measured from the window's bottom edge to the card's.
  const floor = (selector: string) => page.locator(selector).evaluate((el) => Math.round(window.innerHeight - el.getBoundingClientRect().bottom));
  // The hero carried 24px under the composer where a chat's dock is flush (round 7: frame 14 vs 15/18), so the
  // same box sat raised on the screen you begin from.
  const start = await floor(".composer-card");
  await sendAndWait(page, "hello from the floor");
  const chat = await floor(".composer-card");
  expect(chat).toBeLessThan(16);
  expect(start).toBe(chat);
});

test("the review pill names what it opens, and fits beside the title at 320px", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  await newChat(page);
  await page.keyboard.press("Escape");
  await sendAndWait(page, "please edit the app for the review pill");
  const pill = page.locator("button.review-open");
  await expect(pill).toBeVisible();
  // Not a bare pencil beside the title (which read as "rename"): a file mark and the word "Diff".
  await expect(pill.locator("svg.review-icon-file")).toBeVisible();
  await expect(pill.locator("svg.review-icon-edit")).toBeHidden();
  await expect(pill.locator(".review-label-short")).toHaveText("Diff");
  await expect(pill.locator(".review-label-short")).toBeVisible();
  // The full word stays in the name, so it is the same button a screen reader finds on any device.
  await expect(pill).toHaveAccessibleName("Review 1");
  // Narrower than a phone: the header keeps the pill whole and inside the window.
  await page.setViewportSize({ width: 320, height: 844 });
  const header = page.locator(".chat-header");
  const [box, head] = [await pill.boundingBox(), await header.boundingBox()];
  expect(box && head && box.x + box.width <= head.x + head.width).toBe(true);
  await expect(pill.locator(".review-label-short")).toBeVisible();
  await expect(pill.locator(".review-count")).toHaveText("1");
});

test("a lone branch lane's grip sits on the lane's top edge, not above it", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);
  const lane = page.getByTestId("git-row");
  await expect(lane).toBeVisible();
  const geometry = await page.evaluate(() => {
    const ridge = document.querySelector(".status-stack.is-base-only .stack-ridge") as HTMLElement;
    const row = document.querySelector('[data-testid="git-row"]') as HTMLElement;
    const r = ridge.getBoundingClientRect();
    return { position: getComputedStyle(ridge).position, ridgeMid: r.top + r.height / 2, laneTop: row.getBoundingClientRect().top };
  });
  // Out of flow, its bar straddling the lane's top edge: before, the 14 px row hung above the lane (about 20 px
  // above it under an approval, where the lane has no surface at all).
  expect(geometry.position).toBe("absolute");
  expect(Math.abs(geometry.ridgeMid - geometry.laneTop)).toBeLessThanOrEqual(2);
});

test("the drawer is a modal: the chat behind it is inert, Tab stays inside, and it hands the focus back", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Escape");
  const open = page.getByRole("button", { name: "Open menu" });
  await open.click();
  const drawer = page.getByRole("dialog", { name: "Sessions" });
  await expect(drawer).toBeVisible();
  // Nothing behind the drawer can be reached: the chat is inert, not merely covered.
  expect(await page.locator("main").evaluate((el) => (el as HTMLElement).inert)).toBe(true);

  // Tab walks the drawer's own controls and wraps at both ends, instead of stepping into the chat.
  const inDrawer = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest(".sidebar") !== null);
  await page.evaluate(() => (document.querySelector(".sidebar button") as HTMLElement | null)?.focus());
  await page.keyboard.press("Shift+Tab");
  expect(await inDrawer()).toBe(true);
  for (let i = 0; i < 40 && (await inDrawer()); i++) await page.keyboard.press("Tab");
  expect(await inDrawer()).toBe(true);

  // Closed, the focus is back on the button that opened it, so the drawer never drops it on the body.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(open).toBeFocused();
});
