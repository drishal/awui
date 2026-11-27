// The app's scrollbars are one thing: a thin, themed bar on whatever scrolls. The recipe used to be per
// container (the sidebar's list, the chat's thread, the usage dialog, a room's transcript), so the pickers,
// menus and dialogs fell back to the platform's own light bar with arrow buttons inside the dark panel. These
// tests open the two popovers that scroll and read the bar the browser resolves for them.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

/** A scroller's bar, as the browser resolves it: the width and the two colours the app sets. */
async function bar(el: Locator): Promise<{ overflow: string; width: string; color: string }> {
  return el.evaluate((node) => {
    const style = getComputedStyle(node);
    return { overflow: style.overflowY, width: style.scrollbarWidth, color: style.scrollbarColor };
  });
}

/** One scroller wears the app's thin token-coloured bar, not the platform's `auto` one. */
async function wearsThinBar(el: Locator, what: string): Promise<void> {
  const style = await bar(el);
  expect(style.overflow, `${what} is a scroller`).toMatch(/^(auto|scroll)$/);
  expect(style.width, `${what} wears the thin bar`).toBe("thin");
  expect(style.color, `${what}'s bar is coloured from a token`).not.toBe("auto");
}

test("the popovers that scroll wear the app's own bar, not the platform's", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "scrollbar bar");
  const sidebar = page.getByRole("complementary", { name: "Sessions" });

  // The harness picker: the one the user pointed at, and the smallest menu in the app.
  await sidebar.getByRole("button", { name: /^Harness: / }).click();
  const harnesses = page.getByRole("listbox", { name: "Harness" });
  await expect(harnesses).toBeVisible();
  await wearsThinBar(harnesses, "the harness picker");
  await page.keyboard.press("Escape");
  await expect(harnesses).toBeHidden();

  // The model picker: a list of every model each provider offers, long enough to scroll.
  await page.getByTestId("model-picker").click();
  const models = page.locator(".model-list");
  await expect(models).toBeVisible();
  await wearsThinBar(models, "the model picker");
  await page.keyboard.press("Escape");
  await expect(models).toBeHidden();

  // The composer's own field scrolls a long draft, and sits outside every one of those popovers.
  await wearsThinBar(page.getByRole("textbox", { name: "Message" }), "the composer");

  // The two scrollers that already said so themselves keep working, and a strip that hides its bar still does.
  await wearsThinBar(page.locator(".conversation").first(), "the chat's thread");
  await wearsThinBar(sidebar.locator(".session-list"), "the sidebar's list");
  expect((await bar(page.locator(".tab-list"))).width, "the tab strip keeps no bar at all").toBe("none");
});
