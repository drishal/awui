// Routines: a prompt on a cadence, made from the palette, listed, and removed.
import { expect, test } from "@playwright/test";
import { signInAndOpen } from "./helpers.js";

test("a routine is created, listed with its cadence, switched off, and deleted", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("routines");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Routines" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("No routines yet");

  await dialog.getByLabel("Routine name").fill("Nightly");
  await dialog.getByLabel("Prompt").fill("Review today's commits");
  await dialog.getByLabel("Precheck command").fill("git diff --quiet HEAD");
  await dialog.getByRole("button", { name: "Add routine" }).click();
  const list = dialog.getByRole("list", { name: "Routines" });
  await expect(list).toContainText("Nightly");
  await expect(list).toContainText("every day at 09:00");
  await expect(list).toContainText("next");
  await expect(list).toContainText("precheck: git diff --quiet HEAD");

  // Off, then gone.
  await dialog.getByLabel("Enable Nightly").uncheck();
  await expect(dialog.getByLabel("Enable Nightly")).not.toBeChecked();
  await dialog.getByLabel("Delete Nightly").click();
  await expect(dialog).toContainText("No routines yet");
});
