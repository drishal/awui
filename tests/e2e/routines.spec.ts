// Routines: a prompt on a cadence, made from the palette, listed, run now, read back
// (its last runs), switched off, and removed.
import { expect, test } from "@playwright/test";
import { signInAndOpen } from "./helpers.js";

test("a routine is created, listed with its cadence, run once now, switched off, and deleted", async ({ page }) => {
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

  // Run now: the routine's own slot does not move, and what the run came to shows in its history.
  await dialog.getByRole("button", { name: "Run Nightly now" }).click();
  const runs = dialog.getByRole("list", { name: "Recent runs of Nightly" });
  await expect(runs).toBeVisible();
  await expect(runs).toContainText("posted");

  // Off, then gone.
  await dialog.getByLabel("Enable Nightly").uncheck();
  await expect(dialog.getByLabel("Enable Nightly")).not.toBeChecked();
  await dialog.getByLabel("Delete Nightly").click();
  await expect(dialog).toContainText("No routines yet");
});

test("a cron routine is made from an expression and says when it next runs", async ({ page }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("routines");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Routines" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Routine name").fill("Cron nightly");
  await dialog.getByLabel("Prompt").fill("Review today's commits");
  await dialog.getByLabel("When").selectOption("cron");
  await dialog.getByLabel("Cron expression").fill("0 9 * * 1-5");
  await dialog.getByLabel("Timezone").fill("Europe/Berlin");
  await dialog.getByRole("button", { name: "Add routine" }).click();
  const list = dialog.getByRole("list", { name: "Routines" });
  await expect(list).toContainText("cron 0 9 * * 1-5");
  await expect(list).toContainText("Europe/Berlin");

  // A schedule that cannot run is refused in the dialog, not after the save.
  await dialog.getByLabel("Routine name").fill("Bad cron");
  await dialog.getByLabel("Cron expression").fill("0 9 * *");
  await dialog.getByRole("button", { name: "Add routine" }).click();
  await expect(dialog.getByRole("alert")).toContainText("five fields");

  await dialog.getByLabel("Delete Cron nightly").click();
  await expect(dialog).toContainText("No routines yet");
});
