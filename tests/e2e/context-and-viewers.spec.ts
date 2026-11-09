// Presence in the header (how many devices have a chat open) and the context panel
// (its sparkline and its hover). Each test opens its own chat.
import { expect, test } from "@playwright/test";
import { newChat, openChat, send, sendAndWait, signInAndOpen } from "./helpers.js";

test("a second page on the same chat shows '2 devices' in the header, and it goes away again", async ({ page, context }) => {
  await signInAndOpen(page);
  await openChat(page);
  await expect(page.getByTestId("chat-viewers")).toHaveCount(0);
  // The same browser profile restores the open tab, so this page attaches to the same live chat.
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByTestId("chat-status")).toHaveText("Idle");
  await expect(page.getByTestId("chat-viewers")).toHaveText("2 devices", { timeout: 10_000 });
  await expect(page.getByTestId("chat-viewers")).toHaveAttribute("title", /2 devices/);
  await expect(other.getByTestId("chat-viewers")).toHaveText("2 devices", { timeout: 10_000 });
  await other.close();
  await expect(page.getByTestId("chat-viewers")).toHaveCount(0, { timeout: 10_000 });
});

test("focusing a row in the context panel puts its share in the headline and dims the rest", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await page.getByTestId("context-ring").click();
  const panel = page.getByRole("dialog", { name: "Context and usage" });
  const headline = panel.getByTestId("context-headline");
  // The fake harness: 8,400 tokens of 100,000, of which the system prompt is 1,500.
  await expect(headline).toHaveText("8%");
  const row = panel.locator(".usage-row", { hasText: "System prompt" });
  await row.focus();
  await expect(headline).toHaveText("2%");
  await expect(panel.locator(".usage-row", { hasText: "Tool definitions" })).toHaveAttribute("data-state", "dim");
  await expect(panel.locator(".usage-bar span.is-dim")).toHaveCount(2);
  await panel.locator(".usage-row", { hasText: "Tool definitions" }).focus();
  await expect(headline).toHaveText("5%");
  await page.getByTestId("context-ring").focus();
  await expect(headline).toHaveText("8%");
  await expect(panel.locator(".usage-bar span.is-dim")).toHaveCount(0);
});

test("after a compaction the panel says 'Compacted' for a moment", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await send(page, "/compact");
  // Sending takes focus out of the panel and closes it, so open it again inside the two seconds.
  await page.getByTestId("context-ring").click();
  const note = page.getByRole("dialog", { name: "Context and usage" }).getByTestId("compacted");
  await expect(note).toHaveText("Compacted ✓");
  await expect(note).toBeHidden({ timeout: 5000 });
});

test("the context panel draws how the context grew, with a name a screen reader can read", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  await sendAndWait(page, "second question");
  await page.getByTestId("context-ring").click();
  const panel = page.getByRole("dialog", { name: "Context and usage" });
  await expect(panel.getByRole("img", { name: /^Context per turn: \d+% … \d+%/ })).toBeVisible();
});

test("'Show more' opens the chip's full view: the sections wide, the space left, and the turn's own timing", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "showcase");
  await page.getByTestId("context-ring").click();
  const peek = page.getByRole("dialog", { name: "Context and usage" });
  await peek.getByTestId("usage-more").click();
  const full = page.getByRole("dialog", { name: "Context, usage, and timing" });
  await expect(full).toBeVisible();
  // The peek gives way to it, with the same sections and the two the dialog adds.
  await expect(peek).toHaveCount(0);
  await expect(full.getByTestId("context-headline")).toBeVisible();
  await expect(full.locator(".usage-row", { hasText: "Free space" })).toHaveCount(1);
  // The turn's own waterfall: rows on an axis, the slowest call marked.
  await expect(full.getByTestId("timing")).toBeVisible();
  await expect(full.getByRole("listitem").first()).toBeVisible();
  await expect(full.getByTestId("timing-slowest")).toHaveCount(1);
  await expect(full.locator(".timing-axis .timing-tick").first()).toHaveText("0");
  await page.keyboard.press("Escape");
  await expect(full).toHaveCount(0);
  // The chip is still there, and its peek did not come back with it.
  await expect(page.getByTestId("context-ring")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
