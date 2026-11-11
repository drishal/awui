// The notice stack (background chats that finish stack as cards, fan out on hover,
// open their chat, and are dismissed by button or by a swipe on a phone) and the
// phone session row's swipe actions.
import { expect, test, type Page } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const cards = (page: Page) => page.getByTestId("notice");
const tab = (page: Page, title: string) => page.getByRole("tablist", { name: "Open tabs" }).getByRole("tab", { name: new RegExp(title) });

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

  // A card is a link to its chat; opening it takes it away.
  await cards(page).filter({ hasText: "stacked one" }).getByRole("link").click();
  await expect(tab(page, "stacked one")).toHaveAttribute("aria-selected", "true");
  await expect(cards(page)).toHaveCount(1);

  // The dismiss button sends the other away.
  await cards(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(cards(page)).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a notice card swipes sideways away, and a short swipe springs back", async ({ page }) => {
    await twoFinishInTheBackground(page, "swiped");
    await expect(cards(page)).toHaveCount(2, { timeout: 25_000 });
    const card = cards(page).first();
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
    await expect(cards(page)).toHaveCount(2);
    // Long: it goes, and the other stays.
    await drag(box.x + 250, box.x + 100);
    await expect(cards(page)).toHaveCount(1);
  });

  /** A finger dragged left along a row, through the DevTools touch input. */
  async function dragRow(page: Page, title: string, fraction: number) {
    const row = page.locator(".sidebar").locator(".session", { hasText: title }).first();
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
