// Delegated tasks end to end, with the fake harness's `delegate` scenario (which posts to the
// real orchestration endpoint): the parent's panel in the status stack, the child chat opened
// beside it with its lineage chip, and the panel's own Cancel. A slow child keeps a row running
// long enough to stop; the fast one is there to check a finished row.
import { expect, test } from "@playwright/test";
import { newChat, send, signInAndOpen } from "./helpers.js";

test("a delegated task shows, opens beside its parent, and cancels", async ({ page }) => {
  // The side pane needs the split layout, which a phone does not have.
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAndOpen(page, "beta");
  await newChat(page);
  await send(page, "delegate a slow task to another agent");

  const rows = page.getByRole("list", { name: "Delegated tasks" }).getByTestId("task-row");
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  const row = rows.first();
  // The chip, the title, the agent, and Open: what a row carries.
  await expect(row.getByText("Working")).toBeVisible();
  await expect(row.getByRole("button", { name: "Open" })).toBeEnabled();
  await expect(row).toContainText("Fake");

  // Open shows the child chat beside its parent, reachable by keyboard.
  const open = row.getByRole("button", { name: "Open" });
  await open.focus();
  await page.keyboard.press("Enter");
  const beside = page.getByRole("region", { name: "Chat beside" });
  await expect(beside).toBeVisible();
  const chip = beside.getByRole("button", { name: /^Delegated by / });
  await expect(chip).toBeVisible();
  // The chip goes back up to the parent.
  await expect(chip).toHaveAttribute("title", /Open the chat that delegated this one/);

  // Cancel stops the run: the row says so, and the button is spent.
  const stop = row.getByRole("button", { name: /^Cancel Fake delegated task$/ });
  await stop.click();
  await row.getByRole("button", { name: /^Confirm: Cancel Fake delegated task$/ }).click();
  await expect(row.getByText("Cancelled")).toBeVisible({ timeout: 20_000 });
  await expect(rows.first().getByRole("button", { name: /^Cancel Fake delegated task$/ })).toBeDisabled();
});
