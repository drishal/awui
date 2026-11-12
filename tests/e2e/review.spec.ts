// Review: a comment on a diff line becomes a thread on the server, a thread can
// be resolved, and the open ones go to an agent as one numbered prompt — to this
// chat, to a new chat, or to another chat of the same project.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { newChat, sendAndWait, showSidebar, signInAndOpen } from "./helpers.js";

const prompts = (page: Page) => page.getByTestId("user-prompt");

/** The chat header's Review button, or the palette's action, opens the sheet. */
async function openReview(page: Page): Promise<Locator> {
  await showSidebar(page);
  await page.locator("button.review-open").click();
  const dialog = page.getByRole("dialog", { name: "Review changes" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Comment on the diff line at `index` (0 is the first line of the first edit). */
async function comment(page: Page, dialog: Locator, index: number, text: string): Promise<void> {
  await dialog.locator(".review-edit .diff-line").nth(index).click();
  const box = dialog.getByRole("textbox", { name: "Comment" });
  await box.fill(text);
  await box.press("Control+Enter");
  await expect(dialog.getByText(text)).toBeVisible();
}

test("a comment on a line becomes a thread; resolved ones stay, and open ones go to this chat", async ({ page }) => {
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "edit src/app.ts");

  const dialog = await openReview(page);
  await expect(dialog.getByTestId("review-file")).toHaveCount(1);

  await comment(page, dialog, 0, "Call it with the config.");
  await expect(dialog.getByRole("status")).toContainText("1 open");

  await comment(page, dialog, 1, "This one is done already.");
  await expect(dialog.getByRole("status")).toContainText("2 open");

  // Resolving keeps the thread (struck through, with a tick) instead of throwing it away.
  await dialog.getByRole("button", { name: "Resolve" }).last().click();
  await expect(dialog.getByRole("status")).toContainText("1 open · 1 resolved");
  await dialog.getByRole("button", { name: "All" }).click();
  await expect(dialog.getByText("This one is done already.")).toBeVisible();

  // One batch, composed by the server from the threads it holds, to this chat.
  await dialog.getByRole("button", { name: "Send 1 comment" }).click();
  await expect(dialog.getByRole("radio", { name: /This chat/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Sent 1 comment to this chat");
  // Nothing was cleared: the thread stays, and says when it went.
  await expect(dialog.getByText(/^sent /)).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("1 open · 1 resolved");

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(prompts(page).last()).toContainText("Review comments on your changes:");
  await expect(prompts(page).last()).toContainText("1. src/app.ts");
  await expect(prompts(page).last()).toContainText("Call it with the config.");
  // The resolved one is counted, not sent.
  await expect(prompts(page).last()).toContainText("(1 open thread sent; 1 resolved thread not included)");
});

test("the batch goes to another chat of the same project, which receives one prompt", async ({ page }) => {
  await signInAndOpen(page, "alpha");
  await newChat(page);
  await sendAndWait(page, "edit src/app.ts");

  await newChat(page);
  await sendAndWait(page, "the second chat");

  // Back to the chat whose changes are under review.
  await showSidebar(page);
  await page.locator(".session", { hasText: "edit src/app.ts" }).first().click();
  const dialog = await openReview(page);
  await comment(page, dialog, 0, "Move this into the config.");

  await dialog.getByRole("button", { name: "Send 1 comment" }).click();
  await dialog.getByRole("radio", { name: /Another chat of this project/ }).check();
  await dialog.getByLabel("Chat to send to").selectOption({ label: "the second chat" });
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Sent 1 comment to the second chat");

  // The other chat got exactly one prompt, the batch the server composed. The dialog is modal: close it first.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await showSidebar(page);
  await page.locator(".session", { hasText: "the second chat" }).first().click();
  await expect(prompts(page)).toHaveCount(2);
  await expect(prompts(page).last()).toContainText("Review comments on your changes:");
  await expect(prompts(page).last()).toContainText("Move this into the config.");
});
