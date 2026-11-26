// The notice stack (background chats that finish stack as cards, fan out on hover,
// open their chat, and are dismissed by button or by a swipe on a phone) and the
// phone session row's swipe actions.
import { expect, test, type Page } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const cards = (page: Page) => page.getByTestId("notice");
const tab = (page: Page, title: string) => page.getByRole("tablist", { name: "Open tabs" }).getByRole("tab", { name: new RegExp(title) });

/** The notice keeps only a restrained lift, not the large floating surface shadow. */
async function expectNoticeShadow(page: Page): Promise<void> {
  const card = cards(page).first();
  await expect(card).toHaveCSS("box-shadow", "rgba(0, 0, 0, 0.2) 0px 1px 2px 0px, rgba(0, 0, 0, 0.4) 0px 4px 10px 0px");
}

/** The edge is measured by the component; compare it with the exact computed custom property. */
async function expectNoticeEdge(page: Page, edgeProperty: "--toast-right" | "--toast-top" | "--toast-bottom"): Promise<void> {
  await expect.poll(() => page.getByTestId("toast-stack").evaluate((el, edgeProperty) => {
    const style = getComputedStyle(el);
    const inset = style[edgeProperty === "--toast-right" ? "right" : edgeProperty === "--toast-top" ? "top" : "bottom"];
    const measured = style.getPropertyValue(edgeProperty).trim();
    return /^\d+(?:\.\d+)?px$/.test(measured) && parseFloat(measured) === parseFloat(inset) ? measured : inset;
  }, edgeProperty)).toBe(await page.getByTestId("toast-stack").evaluate((el, property) => getComputedStyle(el)[property === "--toast-right" ? "right" : property === "--toast-top" ? "top" : "bottom"], edgeProperty));
}
/** Two chats left running in the background, and a third shown, so both finish "while away". */
async function twoFinishInTheBackground(page: Page, tag: string): Promise<void> {
  await signInAndOpen(page);
  // A send from the start screen returns before its chat is shown, and showing it closes the drawer: wait for
  // the prompt, or the next New chat's drawer can open first and be shut under it.
  for (const which of ["one", "two"]) {
    await newChat(page);
    await send(page, `slow ${tag} ${which}`);
    await expect(page.getByTestId("user-prompt").last()).toHaveText(`slow ${tag} ${which}`);
  }
  await newChat(page);
  await sendAndWait(page, `meanwhile ${tag}`);
}

test("two background chats finishing stack as cards that fan out on hover and open their chat", async ({ page }) => {
  await twoFinishInTheBackground(page, "stacked");
  await expect(cards(page)).toHaveCount(2, { timeout: 25_000 });
  await expect(cards(page).filter({ hasText: "stacked one" })).toContainText("finished");
  await expect(cards(page).filter({ hasText: "stacked two" })).toContainText("finished");

  const stack = page.getByTestId("toast-stack");
  // The stack hangs off the right edge, below the header: it used to be centred over the header's row.
  await expectNoticeShadow(page);
  await expectNoticeEdge(page, "--toast-right");
  await expectNoticeEdge(page, "--toast-top");
  const stackBox = await stack.boundingBox();
  const header = await page.locator(".chat-header").boundingBox();
  expect(stackBox!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  expect(stackBox!.x + stackBox!.width).toBeLessThanOrEqual((await page.evaluate(() => window.innerWidth)) + 1);
  // One live region for the whole stack: the cards are its contents, so a status role inside each card
  // would announce every notice twice.
  await expect(stack).toHaveAttribute("role", "status");
  await expect(page.locator(".toast[role=status]")).toHaveCount(0);
  const gap = async () => {
    const [a, b] = await Promise.all([cards(page).nth(0).boundingBox(), cards(page).nth(1).boundingBox()]);
    return Math.abs((b?.y ?? 0) - (a?.y ?? 0));
  };
  // Stacked: the second card peeks a few pixels from behind the first.
  await expect(stack).toHaveAttribute("data-open", "false");
  await expect.poll(gap).toBeLessThan(20);
  await cards(page).first().hover();
  await expect(stack).toHaveAttribute("data-open", "true");
  await expect.poll(gap).toBeGreaterThan(40);

  // A card is a link to its chat; opening it takes it away. Other notices (an ask
  // from an earlier spec, say) may still be stacked; this one is gone.
  await cards(page).filter({ hasText: "stacked one" }).getByRole("link").click();
  await expect(tab(page, "stacked one")).toHaveAttribute("aria-selected", "true");
  await expect(cards(page).filter({ hasText: "stacked one" })).toHaveCount(0);

  // The dismiss button sends the other away.
  await cards(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(cards(page)).toHaveCount(0);
});

test("a notice keeps its lane left of the context rail", async ({ page }) => {
  await twoFinishInTheBackground(page, "rail lane");
  await expect(cards(page).first()).toBeVisible();
  const rail = await page.locator(".context-panel").boundingBox();
  const stack = await page.getByTestId("toast-stack").boundingBox();
  // The rail is a column of its own (its header, its buttons, its first rows): a notice starts where it ends.
  await expectNoticeEdge(page, "--toast-right");
  expect(stack!.x + stack!.width).toBeLessThanOrEqual(rail!.x + 1);
  // And the rail's own control is still there to take: nothing of the stack sits over it.
  const toggle = page.locator(".context-panel .context-top button").first();
  await expect(toggle).toBeVisible();
  const button = (await toggle.boundingBox())!;
  expect(stack!.x + stack!.width).toBeLessThanOrEqual(button.x + 1);
});

test("a notice raised on the start screen keeps its lane left of the rail once a chat opens", async ({ page }) => {
  await signInAndOpen(page);
  const ws = (await (await page.request.post("/api/workspaces/open", { data: { path: `${process.env.AWUI_E2E_ROOT as string}/alpha` } })).json()) as { id: string };
  const start = async (text: string) => {
    const chat = (await (await page.request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
    if (text) await page.request.post(`/api/chats/${chat.chatId}/messages`, { data: { text, mode: "normal" } });
    return chat.chatId;
  };
  // An idle chat to open later: opening it raises and dismisses nothing, so the notices' count never changes
  // and only the page's structure does. The other chat is idle too, until the page is on the start screen.
  await start("late rail idle");
  const asker = await start("late rail quiet");
  // A fresh load lands on the start screen: no rail, and the stack will measure a page without one.
  await page.goto("/");
  await expect(page.locator(".context-panel")).toHaveCount(0);
  await showSidebar(page);
  await expect(page.locator(".session", { hasText: "late rail idle" }).first()).toBeVisible();
  // A chat that starts waiting on you while you are elsewhere raises its notice here.
  await page.request.post(`/api/chats/${asker}/messages`, { data: { text: "ask late rail", mode: "normal" } });
  await expect(cards(page).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  // A chat opens under it and the rail mounts: the stack must move over to make room, not cover it.
  await expectNoticeEdge(page, "--toast-right");
  await page.locator(".session", { hasText: "late rail idle" }).first().click();
  await expect(page.locator(".context-panel")).toBeVisible();
  const rail = (await page.locator(".context-panel").boundingBox())!;
  await expect.poll(async () => {
    const stack = await page.getByTestId("toast-stack").boundingBox();
    return stack ? stack.x + stack.width <= rail.x + 1 : true;
  }).toBe(true);
});

test("chats already waiting when the page loads raise no notice; only a new question does", async ({ page }) => {
  await signInAndOpen(page);
  const ws = (await (await page.request.post("/api/workspaces/open", { data: { path: `${process.env.AWUI_E2E_ROOT as string}/alpha` } })).json()) as { id: string };
  const chat = (await (await page.request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.request.post(`/api/chats/${chat.chatId}/messages`, { data: { text: "ask already waiting", mode: "normal" } });
  await page.goto("/");
  await showSidebar(page);
  await expect(page.locator(".session", { hasText: "ask already waiting" }).first()).toBeVisible();
  // The list has arrived and it has a chat asking: that is the page's baseline, not news.
  await page.waitForTimeout(1500);
  await expect(cards(page)).toHaveCount(0);
});

test("a notice about the chat you open goes with the arrival", async ({ page }) => {
  await twoFinishInTheBackground(page, "arrival");
  await expect(cards(page).filter({ hasText: "arrival one" })).toHaveCount(1, { timeout: 25_000 });
  // Opening it from its tab, not from the card: what the card said is now the chat itself.
  await tab(page, "arrival one").click();
  await expect(cards(page).filter({ hasText: "arrival one" })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a notice docks clear of the composer and the last prompt", async ({ page }) => {
  await twoFinishInTheBackground(page, "phone-dock");
  const toast = cards(page).first();
  await expect(toast).toBeVisible();
  const a = await toast.boundingBox();
  const composer = await page.locator('[data-pane="main"] .composer').boundingBox();
  const prompt = await page.getByTestId("user-prompt").last().boundingBox();
  expect(a!.y + a!.height).toBeLessThan(composer!.y);
  expect(a!.y).toBeGreaterThan(prompt!.y + prompt!.height);
  const timing = await page.getByTestId("answer-timing").last().locator(".answer-timing-short").innerText();
  expect(timing).toMatch(/^(?:<1s|\d+(?:\.\d)?s|\d+m)/);
  await expect(page.getByTestId("answer-timing").last().locator(".answer-timing-full")).toBeHidden();
});

  test("a notice clears the approval card that took the composer's place, and the drawer covers it", async ({ page }) => {
    await signInAndOpen(page);
    // One chat runs long; the next one asks, so the approval card is the dock's top.
    await newChat(page);
    await send(page, "slow phone dock");
    await newChat(page);
    await send(page, "ask please, phone dock");
    await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 25_000 });
    const notice = page.getByTestId("notice").filter({ hasText: "phone dock" }).first();
    await expect(notice).toBeVisible({ timeout: 30_000 });
    const card = (await notice.boundingBox())!;
    const approval = (await page.getByTestId("approval-card").boundingBox())!;
    // The dock grew when the request arrived; the notice followed it up instead of landing on it.
    await expectNoticeEdge(page, "--toast-bottom");
    expect(card.y + card.height).toBeLessThanOrEqual(approval.y - 12);
    // The drawer covers the same corner: a notice under it is unreadable, so the stack steps out.
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByTestId("toast-stack")).toBeHidden();
  });

test("a notice card swipes sideways away, and a short swipe springs back", async ({ page }) => {
    await twoFinishInTheBackground(page, "swiped");
    await expect(cards(page).filter({ hasText: "swiped one" })).toHaveCount(1, { timeout: 25_000 });
    const card = cards(page).filter({ hasText: "swiped one" }).first();
    const box = await card.boundingBox();
    if (!box) throw new Error("no card");
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const drag = async (from: number, to: number) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: (from + to) / 2, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: to, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    // Short: it comes back.
    await drag(box.x + 120, box.x + 90);
    await expect(cards(page).filter({ hasText: "swiped one" })).toHaveCount(1);
    // Long: it goes, and other notices (an earlier spec's ask) may stay.
    await drag(box.x + 250, box.x + 100);
    await expect(cards(page).filter({ hasText: "swiped one" })).toHaveCount(0);
  });

  /** A finger dragged left along a row, through the DevTools touch input. */
  async function dragRow(page: Page, title: string, fraction: number) {
    const row = page.locator(".sidebar").locator(".session", { hasText: title }).first();
    // A shared server's list is long: a row scrolled out of the drawer has a box the finger cannot reach.
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    if (!box) throw new Error("no row");
    const y = box.y + box.height / 2;
    const from = box.x + box.width - 20;
    const to = from - box.width * fraction;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: x === undefined ? [] : [{ x, y }] });
    await touch("touchStart", from);
    for (let i = 1; i <= 6; i++) await touch("touchMove", from + ((to - from) * i) / 6);
    await touch("touchEnd");
  }

  test("a session row slides left for its actions, and a full swipe runs the first", async ({ page }) => {
    await signInAndOpen(page);
    await newChat(page);
    await sendAndWait(page, "swipe row one");
    await newChat(page);
    await sendAndWait(page, "swipe row two");
    await showSidebar(page);
    const sidebar = page.locator(".sidebar");

    // Part way: Pin, Archive and Snooze show.
    await dragRow(page, "swipe row one", 0.5);
    const actions = sidebar.getByRole("group", { name: "Actions for swipe row one" });
    await expect(actions.getByRole("button", { name: "Pin" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Snooze" })).toBeVisible();
    await actions.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByTestId("toast")).toContainText("Archived “swipe row one”");
    await expect(sidebar.locator(".session", { hasText: "swipe row one" })).toHaveCount(0);

    // All the way: the first action, Pin, runs.
    await dragRow(page, "swipe row two", 0.9);
    await expect(page.getByTestId("toast")).toContainText("Pinned “swipe row two”");
    await expect(sidebar.getByRole("group", { name: "Actions for swipe row two" })).toHaveCount(0);
  });
});
