// The sidebar's quick filters: Running, Needs you, and Today choices in the
// filter disclosure, combined with the text search and remembered per device.
// An active choice is one removable token beside the search. The server is
// shared with the other specs, so these look for their own sessions by title.
import { expect, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sessions" });
const tokenFor = (filter: RegExp) => `Clear ${String(filter).replace(/^\/\^/, "").replace(/ \d.*$/, "")} filter`;
const chip = (page: Page, name: RegExp) => ({
  async click() {
    if (await sidebar(page).getByRole("button", { name: tokenFor(name), exact: true }).count()) {
      await sidebar(page).getByRole("button", { name: tokenFor(name), exact: true }).click();
      return;
    }
    await sidebar(page).getByRole("button", { name: /^Filters/ }).click();
    await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name }).click();
    await page.keyboard.press("Escape");
  },
});
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
  await running.click();
  await expect(sidebar(page).getByRole("button", { name: "Clear Running filter" })).toBeVisible();
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

test("a chat waiting on you is Needs you, never also Running", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  // A run first, so the Running chip is on show whatever else this shared server holds.
  await send(page, "slow stream for the one-chip rule");
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
  await showSidebar(page);
  const running = chip(page, /^Running \d+$/);
  await running.click();
  await expect(sidebar(page).getByRole("button", { name: "Clear Running filter" })).toBeVisible();
  // Now a second chat asks for an approval. Its harness still reports a run while the card waits, and the
  // list must not call that working; the selected filter stays on as its own run settles.
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await send(page, "please ask first, for the one-chip rule");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await showSidebar(page);
  await expect(sidebar(page).getByRole("button", { name: "Clear Running filter" })).toBeVisible();
  await expect(row(page, "please ask first, for the one-chip rule")).toHaveCount(0);
  // It sits in the other attention filter instead.
  await running.click();
  await expect(sidebar(page).getByRole("button", { name: "Clear Running filter" })).toHaveCount(0);
  const needs = chip(page, /^Needs you \d+$/);
  await needs.click();
  await expect(row(page, "slow stream for the one-chip rule")).toHaveCount(0);
  await needs.click();
  await page.getByTestId("approval-card").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
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
  await expect(sidebar(page).getByRole("button", { name: "Filters", exact: true })).toBeVisible({ timeout: 10_000 });
  await needs.click();
  await expect(sidebar(page).getByRole("button", { name: "Clear Needs you filter" })).toBeVisible();
  await expect(row(page, "please ask first, for the needs filter")).toHaveCount(1);
  await expect(row(page, "settled chat for the needs filter")).toHaveCount(0);
  // A chat waiting on you is not working: the row wears an amber "Needs you" mark, not the run's spinner, and a
  // screen reader hears the state it is in.
  const asking = row(page, "please ask first, for the needs filter");
  const mark = asking.getByRole("img", { name: "Needs you" });
  await expect(mark).toBeVisible();
  await expect(mark).toHaveCSS("width", "7px");
  await expect(asking.getByRole("img", { name: "Working" })).toHaveCount(0);
  // Amber is the theme's warning role, never a colour written into the rule.
  const tones = await mark.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--warn)";
    document.body.append(probe);
    const warn = getComputedStyle(probe).color;
    probe.remove();
    return { mark: getComputedStyle(el).backgroundColor, warn };
  });
  expect(tones.mark).toBe(tones.warn);

  // The filter and the search both apply.
  await search(page).fill("settled chat");
  await expect(sidebar(page).getByText("No sessions match")).toBeVisible();
  await search(page).press("Escape");
  await expect(search(page)).toHaveValue("");
  await expect(sidebar(page).getByRole("button", { name: "Clear Needs you filter" })).toBeVisible();
  await search(page).press("Escape");
  await expect(sidebar(page).getByRole("button", { name: "Clear Needs you filter" })).toHaveCount(0);
  await expect(row(page, "settled chat for the needs filter")).toHaveCount(1);

  // Clicking the chip that is on switches it off.
  await needs.click();
  await expect(sidebar(page).getByRole("button", { name: "Clear Needs you filter" })).toBeVisible();
  await needs.click();
  await expect(sidebar(page).getByRole("button", { name: "Clear Needs you filter" })).toHaveCount(0);

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
  await expect(sidebar(page).getByRole("button", { name: "Clear Today filter" })).toBeVisible();
  await expect(row(page, "chat for the today filter")).toHaveCount(1);
  await page.reload();
  await showSidebar(page);
  await expect(sidebar(page).getByRole("button", { name: "Clear Today filter" })).toBeVisible();
  await expect(row(page, "chat for the today filter")).toHaveCount(1);
  await sidebar(page).getByRole("button", { name: "Clear Today filter" }).click();
  await expect(sidebar(page).getByRole("button", { name: "Clear Today filter" })).toHaveCount(0);
});

test("the inactive filter row is absent and Filters sits inside the search", async ({ page }) => {
  await signInAndOpen(page);
  await showSidebar(page);
  const aside = sidebar(page);
  await expect(aside.locator(".quick-filters")).toHaveCount(0);
  const side = await aside.boundingBox();
  const field = await aside.locator(".search-field").boundingBox();
  const filters = await aside.getByRole("button", { name: /Filters/ }).boundingBox();
  expect(field && filters && filters.x >= field.x && filters.x + filters.width <= field.x + field.width).toBe(true);
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
