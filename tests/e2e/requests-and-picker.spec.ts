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
  // While the card says the whole request, the row above names only what is asked about, and no outcome the
  // card is already stating.
  await expect(page.getByTestId("request-row")).toContainText("Approval");
  await expect(page.getByTestId("request-subject")).toHaveText("read");
  // The fold names the same state as the header and the card — the person it waits on, not a run — and its
  // row's mark is a still amber dot, since the card below is the thing that pulses.
  await expect(page.getByTestId("process-toggle").last().getByRole("status")).toHaveText("Waiting for you");
  const waitMark = page.locator(".request-row .drow-icon .request-wait-dot");
  await expect(waitMark).toBeVisible();
  await expect(waitMark).toHaveCSS("width", "6px");
  await expect(page.getByTestId("request-row")).not.toContainText("Waiting for you");
  // The fold's own status column wears that dot too, not the working mark: nothing in it spins while a person is
  // the bottleneck (it used to say "Waiting for you" beside the same starburst a live run shows).
  const foldStatus = page.getByTestId("process-status").last();
  await expect(foldStatus.locator(".request-wait-dot")).toBeVisible();
  await expect(foldStatus.locator(".rays")).toHaveCount(0);
  // And so does the chat's tab: the amber "Needs you" dot, not the run's ring, and a screen reader hears it so.
  await expect(page.getByRole("tab").filter({ has: page.getByRole("img", { name: "Needs you" }) })).toHaveCount(1);
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
  // The note is behind a word, not a box every approval has to look past.
  await expect(card.getByRole("textbox", { name: "Reason for denial (optional)" })).toHaveCount(0);
  await card.getByRole("button", { name: "Add reason…" }).click();
  await card.getByRole("textbox", { name: "Reason for denial (optional)" }).fill("Read instead of changing the file.");
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByTestId("approval-folded")).toContainText("Denied: Allow tool: read");
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
  await page.locator(".process-card").last().getByTestId("process-toggle").click();
  await expect(page.getByTestId("request-row")).toContainText("Denied");
  await page.getByTestId("request-row").getByRole("button").click();
  await expect(page.getByTestId("request-row")).toContainText("Denial reason: Read instead of changing the file.");
});

test("a whole-form question is filled in its own sandboxed frame", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "formquestion");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Answer the form");
  const form = card.frameLocator("iframe");
  await expect(form.getByText(/Which models are safe to delete/)).toBeVisible();
  await form.getByRole("textbox", { name: "Notes" }).fill("keep mirai");
  // The free-text Other row a group of two or more gets, appended to its array.
  await form.getByRole("textbox", { name: "Other answer for t1" }).fill("bonsai");
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByTestId("approval-folded")).toHaveText("Submitted: Answer the form");
  await expect(page.getByText(/"t1":\["mirai","lfm","bonsai"\]/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/"notes":"keep mirai"/)).toBeVisible();
  await expect(page.getByText(/"count":2/)).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 15_000 });
});

test("a queued follow-up leaves the queue and becomes the next prompt", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "slow work");
  // The start screen is held, inert, until the chat draws; words typed before then are dropped, so wait for the chat.
  await expect(page.getByTestId("chat-status")).toHaveText("Working");
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
