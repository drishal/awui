// A project's own awui.yml in the worktree picker: what it asks for, the trust button
// that records one version of it, and the setup command that runs only after a tick.
// The project (delta) is a git repository made for this spec; the server is shared with
// the rest of the suite, so nothing here counts another spec's worktrees.
import { expect, type Page, test } from "@playwright/test";
import { signInAndOpen } from "./helpers.js";

const picker = (page: Page) => page.getByRole("dialog", { name: "Worktrees for delta" });
const configPanel = (page: Page) => page.getByTestId("project-config");

/** The palette's worktree entry (Ctrl+K), which opens the picker over the current project. */
async function openWorktrees(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill("worktrees");
  await page.getByRole("option", { name: /^Worktrees/ }).click();
  await expect(picker(page)).toBeVisible();
}

test("an untrusted awui.yml is shown but runs nothing, and a trusted one sets a new tree up on request", async ({ page }) => {
  await signInAndOpen(page, "delta");
  await openWorktrees(page);

  // The file is read, named by hash, and its command is on the record — but not offered yet.
  await expect(configPanel(page)).toContainText("awui.yml");
  await expect(configPanel(page)).toContainText("starts from main");
  await expect(configPanel(page)).toContainText("has a setup command");
  const trust = configPanel(page).getByRole("button", { name: /^Trust this awui\.yml/ });
  await expect(trust).toBeVisible();
  await expect(configPanel(page).getByRole("checkbox")).toHaveCount(0);

  // The base the file names fills the form.
  await expect(picker(page).getByLabel("Base branch or commit")).toHaveValue("main");

  // Trusting that exact version offers the command, still unticked.
  await trust.click();
  await expect(configPanel(page)).toContainText("Trusted (");
  await expect(configPanel(page)).toContainText("echo set-up > setup.txt");
  const setupBox = configPanel(page).getByRole("checkbox");
  await expect(setupBox).not.toBeChecked();
  await setupBox.check();

  await picker(page).locator("form").first().getByLabel("Task name").fill("trusted-setup");
  await picker(page).getByRole("button", { name: "Create worktree" }).click();

  // The tree opens as the project and the setup's output is reported in a notice.
  await expect(picker(page)).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText(/Setup in awui\/trusted-setup-.* finished/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /^What should .* (do in|work on) trusted-setup/ })).toBeVisible({ timeout: 30_000 });
});
