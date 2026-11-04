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

test("a project without an .envrc shows no direnv row", async ({ page }) => {
  const project = path.join(process.env.AWUI_E2E_ROOT as string, "noenvrc");
  mkdirSync(project, { recursive: true });
  await signInAndOpen(page, "noenvrc");
  await newChat(page);
  await sendAndWait(page, "hello");
  await expect(page.getByTestId("direnv-row")).toHaveCount(0);
});
