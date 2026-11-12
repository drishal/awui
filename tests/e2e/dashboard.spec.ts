// The agent dashboard: three columns over every project, built from the sidebar's own
// overview — Needs you, Working, Done — with a card's last message, and a click that
// opens the chat. The server is shared with the rest of the suite, so this looks for its
// own chats by title instead of counting cards.
import { expect, type Page, test } from "@playwright/test";
import { newChat, send, sendAndWait, signInAndOpen, showSidebar } from "./helpers.js";

const board = (page: Page) => page.getByTestId("dashboard-board");
const column = (page: Page, name: "Needs you" | "Working" | "Done") => page.getByRole("region", { name });

async function openDashboard(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("agent dashboard");
  await page.getByRole("option", { name: /^Agent dashboard/ }).click();
  await expect(board(page)).toBeVisible();
}

test("the dashboard sorts chats into needs you, working, and done, and a card opens its chat", async ({ page }) => {
  await signInAndOpen(page);
  // One chat finishes, one waits on an approval: a card in Done and a card in Needs you.
  await newChat(page);
  await sendAndWait(page, "finished chat for the dashboard");
  await page.getByRole("button", { name: "New chat in a new tab" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await send(page, "please ask first, for the dashboard");
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await showSidebar(page);

  await openDashboard(page);
  await expect(column(page, "Needs you")).toContainText("please ask first, for the dashboard");
  await expect(column(page, "Done")).toContainText("finished chat for the dashboard");
  // A finished card previews its last answer, read from the server (never from the stream).
  await expect(column(page, "Done").getByTestId("dashboard-card").filter({ hasText: "finished chat for the dashboard" })).toContainText(/Echo: finished chat for the dashboard/);

  // The project filter narrows by name.
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("option", { name: /^alpha/ }).click();
  await expect(column(page, "Done")).toContainText("finished chat for the dashboard");

  // A card opens its chat, and the dashboard closes.
  await column(page, "Needs you").getByTestId("dashboard-card").filter({ hasText: "please ask first, for the dashboard" }).getByRole("button").first().click();
  await expect(board(page)).toBeHidden();
  await expect(page.getByTestId("approval-card")).toBeVisible();
  // Answer it so the shared server has nothing waiting for the next spec.
  await page.getByRole("button", { name: "Approve" }).click();
});
