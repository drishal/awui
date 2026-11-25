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
  // With a pointer the grip is out of flow on the dock's top edge, so the lone lane sits at the dock's edge
  // instead of under a 14px empty ridge row of its own (round 7: a navy band over "master not pushed").
  const geometry = await page.locator(".status-stack").evaluate((stack) => {
    const top = stack.getBoundingClientRect().top;
    const grip = stack.querySelector(".stack-ridge") as HTMLElement;
    const lane = stack.querySelector('[data-testid="git-row"]') as HTMLElement;
    return {
      position: getComputedStyle(grip).position,
      gripTop: Math.round(grip.getBoundingClientRect().top - top),
      laneTop: lane.getBoundingClientRect().top - top,
    };
  });
  expect(geometry.position).toBe("absolute");
  expect(geometry.gripTop).toBe(0);
  expect(geometry.laneTop).toBeLessThanOrEqual(2);
  // The grip starts at the dock's edge, not over the prompt's resize strip: a press on the strip's centre is the
  // strip's, or the prompt could not be dragged taller in a chat whose dock is one lane.
  const strip = page.getByRole("separator", { name: "Resize the prompt box" });
  const stripBox = (await strip.boundingBox()) as { x: number; y: number; width: number; height: number };
  const underStrip = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x as number, y as number)?.getAttribute("aria-label") ?? document.elementFromPoint(x as number, y as number)?.className,
    [stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2],
  );
  expect(underStrip).toBe("Resize the prompt box");
  const ridge = page.getByRole("button", { name: "Hide status" });
  await ridge.click();
  await expect(row).toBeHidden();
  await page.getByRole("button", { name: "Show status" }).click();
  await expect(row).toBeVisible();
});
