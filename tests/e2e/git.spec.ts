// The git panel's writes (T3 Code's source control, minimal): stage a changed
// file, commit it with a message, and take a new file back out of the index.
// The project is the e2e suite's own repository (gamma, made in global-setup).
import { expect, test } from "@playwright/test";

test("the git panel stages a file, commits it, and unstages another", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);

  const row = page.getByTestId("git-row");
  await expect(row).toContainText("main");
  await row.click();
  const panel = page.getByRole("dialog", { name: "Git status" });
  await expect(panel).toBeVisible();
  // One modified file and one untracked one, before any write.
  await expect(panel.getByText("hello.txt")).toBeVisible();
  await expect(panel.getByText("new.txt")).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Commit/ })).toBeDisabled();

  await panel.getByRole("button", { name: "Stage hello.txt" }).click();
  const message = panel.getByRole("textbox", { name: "Commit message" });
  await expect(message).toBeEnabled();
  await expect(panel.getByRole("heading", { name: "Staged" })).toBeVisible();
  await message.fill("e2e: change hello");
  await panel.getByRole("button", { name: /^Commit 1$/ }).click();
  // The commit is in the branch the panel reports, and the staged group is gone.
  await expect(panel.getByText("e2e: change hello")).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Staged" })).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "Commit message" })).toBeDisabled();

  // The new file stages and comes back out of the index.
  await panel.getByRole("button", { name: "Stage new.txt" }).click();
  await expect(panel.getByRole("button", { name: "Unstage all" })).toBeVisible();
  await panel.getByRole("button", { name: "Unstage new.txt" }).click();
  await expect(panel.getByRole("button", { name: /^Commit/ })).toBeDisabled();
  await expect(panel.getByRole("heading", { name: "Untracked" })).toBeVisible();
});

test("the status stack's ridge folds the git row too, and brings it back", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);

  const row = page.getByTestId("git-row");
  await expect(row).toBeVisible();
  // The stack holds the git row alone (base-only): its ridge is the one pill above it.
  const ridge = page.getByRole("button", { name: "Hide status" });
  await ridge.click();
  await expect(row).toBeHidden();
  await page.getByRole("button", { name: "Show status" }).click();
  await expect(row).toBeVisible();
});
