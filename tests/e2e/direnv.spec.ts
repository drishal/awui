// The blocked-.envrc prompt: a project whose direnv file was never allowed shows the
// allow row above the chat's composer, and Allow clears it (writes the user's direnv
// consent, as `direnv allow` does). Skipped where the test machine has no direnv.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

const HAS_DIRENV = (() => {
  try {
    execFileSync("direnv", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!HAS_DIRENV, "no direnv on this machine");

test("a blocked .envrc offers an allow prompt above the composer", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT as string, "withenvrc");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, ".envrc"), "export AWUI_E2E_ENVRC=on\n");
  await signInAndOpen(page, "withenvrc");
  await newChat(page);
  // The hero needs one turn before the chat's composer (and its note) exists.
  await sendAndWait(page, "hello");
  const note = page.getByTestId("direnv-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText(".envrc");
  await page.getByTestId("direnv-allow").click();
  await expect(note).toHaveCount(0);
});

test("an allowed .envrc shows no prompt", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT as string, "withenvrc");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, ".envrc"), "export AWUI_E2E_ENVRC=on\n");
  execFileSync("direnv", ["allow"], { cwd: project });
  await signInAndOpen(page, "withenvrc");
  await newChat(page);
  await sendAndWait(page, "hello");
  await expect(page.getByTestId("direnv-note")).toHaveCount(0);
  // The loaded environment is an indicator at the top of the composer's status stack, above the todos.
  const row = page.getByTestId("direnv-row");
  await expect(row).toBeVisible();
  await expect(row).toContainText("direnv");
  await expect(row).toContainText(".envrc");
});

test("the direnv pill and the git pill are one family", async ({ page }) => {
  // A repository, so both pills stand above the composer: the environment at the top of the dock, git at its base.
  const project = path.join(process.env.AWUI_E2E_ROOT as string, "direnvgit");
  mkdirSync(project, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "E2E");
  git("config", "user.email", "e2e@example.com");
  writeFileSync(path.join(project, "readme.md"), "# Direnv and git\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  writeFileSync(path.join(project, ".envrc"), "export AWUI_E2E_ENVRC=on\n");
  await signInAndOpen(page, "direnvgit");
  await newChat(page);
  await sendAndWait(page, "hello");
  const note = page.getByTestId("direnv-note");
  if (await note.isVisible()) await page.getByTestId("direnv-allow").click();
  await expect(page.getByTestId("direnv-row")).toBeVisible();
  await expect(page.getByTestId("git-row")).toBeVisible();
  const box = async (sel: string) => {
    const at = await page.locator(sel).first().boundingBox();
    expect(at).not.toBeNull();
    return at as NonNullable<typeof at>;
  };
  const env = await box('[data-testid="direnv-row"]');
  const gitPill = await box('[data-testid="git-row"]');
  // One family: the same left and right edge and the same height...
  expect(Math.abs(env.x - gitPill.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(env.width - gitPill.width)).toBeLessThanOrEqual(0.5);
  expect(env.height).toBe(gitPill.height);
  // ...and the composer card's own edges, since the pair is the column's last rows.
  const card = await box(".composer-card");
  expect(Math.abs(env.x - card.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(env.width - card.width)).toBeLessThanOrEqual(1);
});

test("a project without an .envrc shows no direnv row", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT as string, "noenvrc");
  mkdirSync(project, { recursive: true });
  await signInAndOpen(page, "noenvrc");
  await newChat(page);
  await sendAndWait(page, "hello");
  await expect(page.getByTestId("direnv-row")).toHaveCount(0);
});
