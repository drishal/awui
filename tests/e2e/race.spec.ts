// Races: the comparison a "Compare agents in isolated worktrees" start records, its
// panel over the chats (each member's counts, a file's diff, picking a winner), the
// cleanup of its losers, and the same panel reached again later from the palette.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { showSidebar } from "./helpers.js";

/** A project of this spec's own: one commit the fake harness edits (its "edit" scenario). */
function project(name: string): string {
  const dir = path.join(process.env.AWUI_E2E_ROOT as string, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "E2E");
  git("config", "user.email", "e2e@example.com");
  writeFileSync(path.join(dir, "src", "app.ts"), "const a = 1;\nconst b = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return dir;
}

/** Open a project through the folder picker; the start screen then belongs to it. */
async function openProject(page: Page, dir: string): Promise<void> {
  await page.goto("/");
  await showSidebar(page);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose a project folder" });
  await picker.getByLabel("Or type a path").fill(dir);
  await picker.getByRole("button", { name: "Open", exact: true }).click();
  await expect(picker).toBeHidden();
}

/** Run one palette entry by its words. */
async function palette(page: Page, words: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands and sessions" }).fill(words);
  await page.keyboard.press("Enter");
}

/** Start a two-agent comparison of this prompt over the open project. */
async function compare(page: Page, prompt: string): Promise<Locator> {
  await palette(page, "compare agents");
  const dialog = page.getByRole("dialog", { name: /^Compare agents in / });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Fake", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Fake B", exact: true }).check();
  await dialog.getByLabel("Prompt").fill(prompt);
  await dialog.getByRole("button", { name: "Compare 2 agents" }).click();
  const panel = page.getByRole("dialog", { name: "Races" });
  await expect(panel).toBeVisible();
  return panel;
}

test("a comparison records its members, shows a file's diff, keeps a winner, and cleans up a loser", async ({ page }) => {
  const dir = project(`race-${Date.now()}`);
  await openProject(page, dir);
  const panel = await compare(page, "edit src/app.ts");

  // One row per agent, with what it changed against the point the branches forked from.
  await expect(panel.getByText(path.basename(dir))).toBeVisible();
  await expect(panel.getByRole("button", { name: "Pick Fake", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Pick Fake B" })).toBeVisible();
  await expect(panel.getByText("finished").first()).toBeVisible({ timeout: 20_000 });

  // A changed file opens its diff against the fork point.
  await panel.getByRole("button", { name: "src/app.ts" }).first().click();
  await expect(panel.getByText("const changed = true;")).toBeVisible();

  // Keeping a winner touches nothing; the cleanup step then lists the loser and why it stays.
  await panel.getByRole("button", { name: "Pick Fake", exact: true }).click();
  await expect(panel.getByText("Winner", { exact: true })).toBeVisible();
  const cleanup = panel.getByRole("region", { name: "Clean up the losers" });
  await expect(cleanup).toBeVisible();
  await expect(cleanup.getByText("has uncommitted work").first()).toBeVisible();
  await cleanup.getByRole("button", { name: "Clean up 1 loser" }).click();
  await expect(panel.getByRole("list", { name: "What the cleanup did" })).toContainText("kept: uncommitted work");

  // Reachable again later: the palette's Races list opens the same comparison.
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
  await palette(page, "Races: compare");
  const list = page.getByRole("dialog", { name: "Races" });
  await expect(list).toBeVisible();
  await list.getByRole("button", { name: new RegExp(path.basename(dir)) }).click();
  await expect(list.getByText("Winner", { exact: true })).toBeVisible();
});

test("the races panel is usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dir = project(`race-phone-${Date.now()}`);
  await openProject(page, dir);
  await palette(page, "Races: compare");
  const panel = page.getByRole("dialog", { name: "Races" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Refresh" })).toBeInViewport();
});
