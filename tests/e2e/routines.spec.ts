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
  // A precheck that passes in the e2e project (which is not a git repository).
  await dialog.getByLabel("Precheck command").fill("true");
  await dialog.getByRole("button", { name: "Add routine" }).click();
  const list = dialog.getByRole("list", { name: "Routines" });
  await expect(list).toContainText("Nightly");
  await expect(list).toContainText("every day at 09:00");
  await expect(list).toContainText("next");
  await expect(list).toContainText("precheck: true");

  // Run now: the routine's own slot does not move, and what the run came to shows in its history.
  await dialog.getByRole("button", { name: "Run Nightly now" }).click();
  const runs = dialog.getByRole("list", { name: "Recent runs of Nightly" });
  await expect(runs).toBeVisible();
  await expect(runs).toContainText(/running|posted/);

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

  // A schedule that cannot run is refused in the dialog, not after the save (the form
  // emptied itself when the first routine was saved).
  await dialog.getByLabel("Routine name").fill("Bad cron");
  await dialog.getByLabel("Prompt").fill("Review today's commits");
  await dialog.getByLabel("Cron expression").fill("0 9 * *");
  await dialog.getByRole("button", { name: "Add routine" }).click();
  await expect(dialog.getByRole("alert")).toContainText("five fields");

  await dialog.getByLabel("Delete Cron nightly").click();
  await expect(dialog).toContainText("No routines yet");
});

test("a routine takes a webhook: its URL and secret are shown, and a signed delivery runs it", async ({ page, request }) => {
  await signInAndOpen(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("routines");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Routines" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Routine name").fill("On a PR");
  await dialog.getByLabel("Prompt").fill("Look at this pull request: {{webhook}}");
  await dialog.getByLabel("Start on a webhook").check();
  await dialog.getByLabel("Webhook header value").fill("pull_request");
  await dialog.getByLabel("Webhook body path").fill("action");
  await dialog.getByLabel("Webhook body value").fill("opened");
  await dialog.getByRole("button", { name: "Add routine" }).click();

  // The endpoint and its secret are in the row, to copy into the sender's settings.
  const list = dialog.getByRole("list", { name: "Routines" });
  await expect(list).toContainText("webhook");
  await expect(list).toContainText("/api/hooks/");
  await expect(list).toContainText("secret");
  const secret = (await list.locator(".routine-hook code").nth(1).innerText()).trim();
  expect(secret).toMatch(/^[0-9a-f]{48}$/);

  // A delivery nobody signed is refused; one signed with that secret starts a run, and the
  // same delivery again runs nothing.
  // By name: the e2e server is shared, so "the first routine" may be another spec's.
  const routineId = (await page.evaluate(async () => (await (await fetch("/api/routines")).json()).routines.find((r: { name: string }) => r.name === "On a PR").id)) as string;
  const unsigned = await request.post(`/api/hooks/${routineId}`, { data: { action: "opened" }, headers: { "x-github-event": "pull_request" } });
  expect(unsigned.status()).toBe(401);
  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify({ action: "opened", number: 7 });
  const headers = {
    "x-github-event": "pull_request",
    "x-github-delivery": "e2e-delivery-1",
    "x-awui-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "content-type": "application/json",
  };
  const accepted = await request.post(`/api/hooks/${routineId}`, { data: body, headers });
  expect(accepted.status()).toBe(202);
  const repeat = await request.post(`/api/hooks/${routineId}`, { data: body, headers });
  expect(repeat.status()).toBe(200);
  expect((await repeat.json()) as { duplicate: boolean }).toMatchObject({ duplicate: true });
  // The run settles a moment later; its verdict lands in the history.
  await expect
    .poll(
      async () => {
        const history = (await (await request.get("/api/routines/runs")).json()) as { runs: Array<{ outcome: string }> };
        return history.runs.some((run) => run.outcome === "posted");
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await dialog.getByLabel("Delete On a PR").click();
  await expect(dialog).toContainText("No routines yet");
});
