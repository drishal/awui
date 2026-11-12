// An answered request folds into one line, a queued message glides into the
// conversation, and the model picker grows out of its chip (type to search).
import { expect, test } from "@playwright/test";
import { newChat, openChat, send, signInAndOpen } from "./helpers.js";

test("an answered request folds into one line naming the answer", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask before reading");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Waiting for approval");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
  const folded = page.getByTestId("approval-folded");
  await expect(folded).toHaveText("Approved: Allow tool: read");
  // It leaves by itself; the conversation keeps the record.
  await expect(folded).toHaveCount(0, { timeout: 6_000 });
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
});

test("a denied request folds into a line that says so", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "ask before reading");
  const card = page.getByTestId("approval-card");
  await card.getByRole("textbox", { name: "Reason for denial (optional)" }).fill("Read instead of changing the file.");
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByTestId("approval-folded")).toContainText("Denied: Allow tool: read");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
  await page.locator(".process-card").last().getByTestId("process-toggle").click();
  await expect(page.getByTestId("request-row")).toContainText("Denied");
  await page.getByTestId("request-row").getByRole("button").click();
  await expect(page.getByTestId("request-row")).toContainText("Denial reason: Read instead of changing the file.");
});

test("a queued follow-up leaves the queue and becomes the next prompt", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow work");
  await page.getByRole("textbox", { name: "Message" }).fill("then summarize");
  await page.getByRole("button", { name: "Follow-up" }).click();
  const row = page.getByTestId("queue-row").filter({ hasText: "then summarize" });
  await expect(row).toBeVisible();
  // The row leaves when the agent takes it, and the same words are the next prompt (the glide itself is motion, not tested).
  await expect(row).toHaveCount(0, { timeout: 20_000 });
  // It lights up for a moment as it lands.
  await expect(page.getByTestId("user-prompt").last()).toHaveClass(/is-landed/);
  await expect(page.getByTestId("user-prompt")).toHaveText(["slow work", "then summarize"]);
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
});

test("typing on the focused model chip opens the picker with that text searched", async ({ page }) => {
  await signInAndOpen(page);
  await openChat(page);
  const picker = page.getByTestId("model-picker");
  await picker.focus();
  await page.keyboard.type("gpt55");
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog).toBeVisible();
  // The panel morphs out of the chip's measured rect, not just its corner.
  await expect(dialog).toHaveAttribute("data-morph", "");
  await expect(page.getByRole("combobox", { name: "Search models" })).toHaveValue("gpt55");
  await expect(dialog.getByRole("option")).toHaveText([/GPT-5\.5/, /GPT-5\.5 Mini/]);
  // The first match is the one Enter takes.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(picker).toHaveAccessibleName(/^Model: GPT-5\.5$/);
});
