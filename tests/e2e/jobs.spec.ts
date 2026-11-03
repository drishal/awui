// Background jobs end to end with the fake harness's omp-shaped "bgjob": a command
// left running, a wait streaming the job's widget, then its report. The card
// shows above the composer while it runs and in the wait's row, and a reload
// draws the same from the transcript.
import { expect, test, type Page } from "@playwright/test";
import { newChat, send, signInAndOpen } from "./helpers.js";

/** Open the last turn's work, which a reloaded (settled) turn draws folded. */
async function openFold(page: Page) {
  const toggle = page.locator(".process-card").last().getByTestId("process-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("a background job shows its progress above the composer and in the wait that watches it", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "bgjob");
  const background = page.getByTestId("background-jobs");
  const card = background.getByTestId("job-card");
  await expect(card).toHaveAttribute("data-job", "bg_1", { timeout: 10_000 });
  await expect(card).toContainText("Running the e2e suite");
  await expect(card.getByRole("img", { name: "Running" })).toBeVisible();
  // omp's widget: a meter that fills as tests finish, the passed and failed counts, a square a test.
  const meter = card.getByRole("progressbar", { name: "tests done" });
  await expect.poll(async () => Number(await meter.getAttribute("aria-valuenow")), { timeout: 10_000 }).toBeGreaterThan(20);
  await expect(card.locator(".job-stat")).toHaveCount(2);
  await expect(card.locator(".job-cell.tone-error")).toHaveCount(1);
  // The wait's row says what it waits on and draws the same card while it waits.
  await expect(page.locator('[data-tool="wait"] .tool-sentence')).toHaveText("Waiting on bg_1: Running the e2e suite");
  await expect(page.locator('[data-tool="wait"]').getByTestId("job-card")).toBeVisible();
  // Reported done: the card says so, and the command's row says it ran in the background.
  await expect(page.locator(".answer-actions").last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-tool="wait"] .tool-sentence')).toHaveText("Waited on bg_1: Running the e2e suite");
  await expect(page.locator('[data-tool="bash"] .tool-fact')).toHaveText("in background · bg_1");
  await expect(card.getByRole("img", { name: "Done" })).toBeVisible();
  // A reload reads the job back from the transcript: the wait still holds it, done.
  await page.reload();
  await openFold(page);
  const row = page.locator('[data-tool="wait"]');
  await expect(row.locator(".tool-sentence")).toHaveText("Waited on bg_1: Running the e2e suite", { timeout: 10_000 });
  await row.locator(".tool-head").click();
  await expect(row.getByTestId("job-card").getByRole("img", { name: "Done" })).toBeVisible();
});
