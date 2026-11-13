// The sidebar's quick filters: Running, Needs you, and Today chips under the
// search box, one on at a time, combined with the text search, remembered per
// device. The server is shared with the other specs, so these look for their
// own sessions by title rather than counting.
import { expect, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });
const chip = (page: Page, name: RegExp) => sidebar(page).getByRole("group", { name: "Filter sessions" }).locator(".quick-chip[aria-pressed]").filter({ hasText: name });
const row = (page: Page, title: string) => sidebar(page).locator(".session-item", { hasText: title });
const tab = (page: Page, title: string) => page.getByRole("tablist", { name: "Open tabs" }).getByRole("tab", { name: new RegExp(title) });
const search = (page: Page) => sidebar(page).getByRole("searchbox", { name: "Search sessions" });

test("Running lists only the chats that are working, and Clear filter brings the rest back", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "idle chat for the filter");
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await send(page, "slow stream for the running filter");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await showSidebar(page);
  const running = chip(page, /^Running \d+$/);
  await expect(running).toHaveAttribute("aria-pressed", "false");
  await running.click();
  await expect(running).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "slow stream for the running filter")).toHaveCount(1);
  await expect(row(page, "idle chat for the filter")).toHaveCount(0);
  // The run ends; the chip stays on, so the list says nothing matches and offers the way out.
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await showSidebar(page);
  const clear = sidebar(page).getByRole("button", { name: "Clear filter" });
  await expect(clear).toBeVisible({ timeout: 10_000 });
  await clear.click();
  await expect(sidebar(page).getByRole("button", { name: "Clear filter" })).toHaveCount(0);
  await expect(row(page, "idle chat for the filter")).toHaveCount(1);
  await expect(row(page, "slow stream for the running filter")).toHaveCount(1);
});

test("Needs you lists the chats waiting on an answer, and Escape clears the search, then the filter", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "settled chat for the needs filter");
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await send(page, "please ask first, for the needs filter");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await showSidebar(page);
  const needs = chip(page, /^Needs you \d+$/);
  await expect(needs).toBeVisible({ timeout: 10_000 });
  await needs.click();
  await expect(needs).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "please ask first, for the needs filter")).toHaveCount(1);
  await expect(row(page, "settled chat for the needs filter")).toHaveCount(0);

  // The filter and the search both apply.
  await search(page).fill("settled chat");
  await expect(sidebar(page).getByText("No sessions match")).toBeVisible();
  await search(page).press("Escape");
  await expect(search(page)).toHaveValue("");
  await expect(needs).toHaveAttribute("aria-pressed", "true");
  await search(page).press("Escape");
  await expect(needs).toHaveAttribute("aria-pressed", "false");
  await expect(row(page, "settled chat for the needs filter")).toHaveCount(1);

  // Clicking the chip that is on switches it off.
  await needs.click();
  await expect(needs).toHaveAttribute("aria-pressed", "true");
  await needs.click();
  await expect(needs).toHaveAttribute("aria-pressed", "false");

  // Leave the shared server with nothing waiting.
  await page.getByTestId("approval-card").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await tab(page, "settled chat").click();
});

test("Today shows today's sessions and is remembered after a reload", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "chat for the today filter");
  await showSidebar(page);
  const today = chip(page, /^Today \d+$/);
  await today.click();
  await expect(today).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "chat for the today filter")).toHaveCount(1);
  await page.reload();
  await showSidebar(page);
  await expect(chip(page, /^Today \d+$/)).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "chat for the today filter")).toHaveCount(1);
  await chip(page, /^Today \d+$/).click();
  await expect(chip(page, /^Today \d+$/)).toHaveAttribute("aria-pressed", "false");
});

test("every chip stays whole and the Filters button stays inside the sidebar", async ({ page }) => {
  await signInAndOpen(page);
  await showSidebar(page);
  const aside = sidebar(page);
  const group = aside.getByRole("group", { name: "Filter sessions" });
  const chips = group.locator(".quick-chip[aria-pressed]");
  await expect(chips.first()).toBeVisible();
  const side = await aside.boundingBox();
  const boxes = await chips.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { right: r.right, height: Math.round(r.height), clipped: el.scrollWidth > el.clientWidth }; }));
  // No chip wrapped its own words (a second text line would make it taller), none is cut by the edge, none is scrolled out of reach.
  expect(boxes.length).toBeGreaterThanOrEqual(1);
  for (const b of boxes) {
    expect(b.height).toBeLessThan(32);
    expect(b.clipped).toBe(false);
    expect(side && b.right <= side.x + side.width).toBe(true);
  }
  const filters = await aside.getByRole("button", { name: /^Filters/ }).boundingBox();
  expect(side && filters && filters.x + filters.width <= side.x + side.width).toBe(true);
});

test("Filters hides a chat on the default branch, keeps the one on screen, and remembers it", async ({ page }) => {
  // gamma is the suite's only git repository, on main: its chats are "on the default branch".
  await signInAndOpen(page, "gamma");
  await newChat(page);
  await sendAndWait(page, "settled on the default branch");
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await sendAndWait(page, "the chat on screen for the hide filter");
  await showSidebar(page);

  const filters = sidebar(page).getByRole("button", { name: /^Filters/ });
  await expect(row(page, "settled on the default branch")).toHaveCount(1);
  await filters.click();
  const hide = page.getByRole("group", { name: "Hide sessions" });
  await hide.getByRole("checkbox", { name: /On the default branch/ }).check();
  // The quiet one goes, the one on screen stays (so it can still be closed from here).
  await expect(row(page, "settled on the default branch")).toHaveCount(0);
  await expect(row(page, "the chat on screen for the hide filter")).toHaveCount(1);
  await hide.getByRole("button", { name: "Show everything" }).click();
  await expect(row(page, "settled on the default branch")).toHaveCount(1);

  // The choice is kept per device like the chips are.
  await hide.getByRole("checkbox", { name: /On the default branch/ }).check();
  await expect(filters).toHaveAttribute("aria-label", "Filters, 1 hiding sessions");
  await page.reload();
  await showSidebar(page);
  await expect(sidebar(page).getByRole("button", { name: /^Filters, 1 hiding sessions$/ })).toBeVisible();
  // Back to showing everything, for the specs that share this server.
  await sidebar(page).getByRole("button", { name: /^Filters, 1 hiding sessions$/ }).click();
  await page.getByRole("group", { name: "Hide sessions" }).getByRole("checkbox", { name: /On the default branch/ }).uncheck();
  await expect(row(page, "settled on the default branch")).toHaveCount(1);
});
