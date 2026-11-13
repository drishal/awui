import { expect, test } from "@playwright/test";
// Assert navigations and workflow, not a screenshot/product claim. Real native cards and native scope only.
import { signInAndOpen, newChat, sendAndWait, send } from "./helpers.js";

test("work happens along with its chart: context count follows the original tool", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "subagents");
  const panel = page.getByRole("complementary", { name: "Chat context" });
  await expect(panel.getByRole("heading", { name: "Agents and lineage" })).toBeVisible();
  await expect(panel.locator(".context-count").first()).toHaveText("2");
  const briefButton = panel.getByRole("button", { name: "Open scout run", exact: true }).first();
  await briefButton.click();
  const toolRow = page.getByTestId("tool-row").filter({ hasText: "Ran 2 agents: scout, worker" });
  await expect(toolRow).toBeVisible();
  const agentRow = toolRow.locator(".run-head").first();
  if ((await agentRow.getAttribute("aria-expanded")) !== "true") await agentRow.click();
  await expect(toolRow.getByRole("button", { name: "Open transcript", exact: true })).toBeVisible();
  await toolRow.getByRole("button", { name: "Open transcript", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Transcript of/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /Transcript of/ })).toHaveCount(0);

  const usageFold = panel.getByRole("button", { name: "Context and usage", exact: true });
  if ((await usageFold.getAttribute("aria-expanded")) !== "true") await usageFold.click();
  await expect(panel.getByRole("button", { name: "Open context and timings" })).toBeVisible({ timeout: 10_000 });
  await usageFold.click();
  await expect(panel.locator(".context-section-memory .context-section-body")).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse context panel", exact: true }).click();
  await expect(panel).toHaveClass(/is-collapsed/);
  await expect(panel.getByRole("heading", { name: "Active work" })).toHaveCount(0);
  await expect.poll(async () => (await panel.evaluate((el) => getComputedStyle(el).flexBasis)), { timeout: 3000 }).toBe("40px");
  const box = await panel.boundingBox();
  expect(box?.width).toBeCloseTo(40, 1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("awui.context.folds") ?? "{}").memory)).toBe(false);
  await page.getByRole("button", { name: "Expand context panel", exact: true }).click();
  await expect(panel.locator(".context-section-memory .context-section-body")).toHaveCount(0);
});

test("background jobs and their native tool references remain reachable without duplicating job data", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "bgjob");
  const panel = page.getByRole("complementary", { name: "Chat context" });
  await expect(panel.getByRole("heading", { name: "Background jobs" })).toBeVisible({ timeout: 15_000 });
  const reported = panel.getByRole("button", { name: "Open reported output", exact: true }).last();
  await expect(reported).toBeVisible();
  await reported.click();
  const messageTool = page.getByTestId("tool-row").filter({ hasText: /Waiting on bg_1|Waited on bg_1/ });
  await expect(messageTool.first()).toBeVisible();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
});

test("returning to an ask card does not approve or deny it, and the narrow layout draws the same context sheet", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 860 });
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask");
  await expect(page.getByTestId("approval-card")).toContainText("Waiting for approval");
  await page.getByRole("button", { name: "Expand chat context", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Active chat context" });
  await expect(sheet).toContainText("This chat needs a human answer");
  await expect(sheet.locator(".context-count").nth(1)).toHaveText("1");
  await sheet.getByRole("button", { name: "Jump to the request", exact: true }).click();
  await expect(page.getByTestId("approval-card")).toContainText("Waiting for approval");
  await expect(page.getByRole("dialog", { name: "Active chat context" })).toHaveCount(0);
});

test("a short chat's composer sits on the bottom of the main column", async ({ page }) => {
  // Tall enough that a one-prompt chat is shorter than the window: the case where the wrapper's own height shows.
  await page.setViewportSize({ width: 1600, height: 1100 });
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hello");
  const main = await page.locator("main.main").boundingBox();
  const work = await page.locator(".context-work").boundingBox();
  const composer = await page.getByRole("textbox", { name: /message/i }).first().boundingBox();
  expect(main && work && composer).toBeTruthy();
  // The wrapper fills the column, and the composer is within a card's height of its bottom edge.
  expect(Math.abs((work!.y + work!.height) - (main!.y + main!.height))).toBeLessThan(2);
  expect((main!.y + main!.height) - (composer!.y + composer!.height)).toBeLessThan(160);
});
