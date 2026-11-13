import { expect, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

// A turn's Timing view: its steps and calls as bars on a time axis, the slowest marked.

test("the Timing view lists a turn's calls as named bars, with the slowest marked and keys moving between rows", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  // Reachable from the answer's action row by keyboard.
  const open = page.getByTestId("turn").last().getByRole("button", { name: "Timing" });
  await open.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Timing" });
  await expect(dialog).toBeVisible();
  const rows = dialog.getByRole("listitem");
  // Actual calls and the answer; adjacent plan rows compact into one.
  expect(await rows.count()).toBeGreaterThanOrEqual(9);
  const bash = dialog.getByRole("listitem", { name: /^Ran npm test -- --run tool-diff, .+ to .+/ });
  await expect(bash).toHaveCount(1);
  await expect(dialog.getByRole("listitem", { name: /^Edited src\/server\.ts, / })).toHaveCount(1);
  // One call is the slowest, and its name says so.
  await expect(dialog.getByTestId("timing-slowest")).toHaveCount(1);
  await expect(dialog.getByRole("listitem", { name: /slowest call$/ })).toHaveCount(1);
  // The axis starts at zero.
  await expect(dialog.locator(".timing-axis .timing-tick").first()).toHaveText("0");
  // Arrow keys step through the rows.
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the Timing sheet fits without sideways scroll", async ({ page }) => {
    await signInAndOpen(page);
    await page.keyboard.press("Escape");
    await newChat(page);
    await sendAndWait(page, "showcase");
    await page.getByTestId("turn").last().getByRole("button", { name: "Timing" }).click();
    const dialog = page.getByRole("dialog", { name: "Timing" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("timing-slowest")).toHaveCount(1);
    const fits = await dialog.evaluate((el) => {
      const rows = el.querySelector<HTMLElement>(".timing-rows");
      const box = el.getBoundingClientRect();
      return { dialogX: el.scrollWidth <= el.clientWidth + 1, rowsX: !rows || rows.scrollWidth <= rows.clientWidth + 1, inside: box.left >= 0 && box.right <= window.innerWidth + 1 };
    });
    expect(fits).toEqual({ dialogX: true, rowsX: true, inside: true });
  });
});
