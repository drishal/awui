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

test("the dock keeps its own frost, so its face does not pick up the hue of what sits behind it", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await page.goto(`/#chat=${chat.chatId}`);
  await expect(page.getByTestId("git-row")).toBeVisible();
  // The shared glass (glass.css) gives 76% of the face behind a saturate(1.6), which turned the dock navy while an
  // approval card sat under it (round 7: the same dock grey in one frame, blue in the next). The dock keeps 92%
  // of its face and boosts nothing, so its colour is the surface's in every state.
  const frost = await page.locator(".status-stack").evaluate((stack) => {
    const cs = getComputedStyle(stack);
    return { tint: cs.getPropertyValue("--glass-tint").trim(), saturate: cs.getPropertyValue("--glass-saturate").trim(), filter: cs.backdropFilter };
  });
  expect(frost.tint).toBe("92%");
  expect(frost.saturate).toBe("1");
  expect(frost.filter).toContain("saturate(1)");
});

test("a lone branch lane wears the composer's face, with no frame of its own", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  const chat = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  {
    // (The suite's server paints one scheme whatever the media says; the dark and light frames of this were
    // checked by hand with /api/theme stubbed, and the face is one token, so the equality below is the invariant.)
    const scheme = "default";
    await page.goto(`/#chat=${chat.chatId}`);
    await expect(page.getByTestId("git-row")).toBeVisible();
    // Computed colours, not pixels: the lane and the composer resolve the same --dock-face (the lane opaque, the
    // composer's frost at 92%), so their channels agree to rounding. Before, the lane painted --surface-2: 0.008 off
    // here, and above the composer in one scheme and below the page in the other.
    const faces = await page.evaluate(() => {
      const channels = (el: Element) => {
        const nums = (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        return nums.map((n) => (n > 1 ? n / 255 : n));
      };
      const stack = document.querySelector(".status-stack.is-base-only") as HTMLElement;
      return {
        lane: channels(document.querySelector('[data-testid="git-row"]') as Element),
        composer: channels(document.querySelector(".composer-card") as Element),
        frame: getComputedStyle(stack).borderTopWidth,
        stackFace: getComputedStyle(stack).backgroundColor,
      };
    });
    faces.lane.forEach((c, i) => expect(Math.abs(c - (faces.composer[i] as number)), `${scheme}: channel ${i}`).toBeLessThan(0.002));
    // One outline, not a frame around a pill: the stack itself has neither a border nor a face.
    expect(faces.frame, `${scheme}: no frame`).toBe("0px");
    expect(faces.stackFace, `${scheme}: no surface`).toBe("rgba(0, 0, 0, 0)");
  }
});

test("a chat switch lands with the dock whole, its branch lane already in place", async ({ page, request }) => {
  const root = process.env.AWUI_E2E_ROOT as string;
  const ws = (await (await request.post("/api/workspaces/open", { data: { path: `${root}/gamma` } })).json()) as { id: string };
  // Two chats in one project: one whose dock is the git row alone, and one with a run's Todos above that row.
  const plain = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${plain.chatId}/messages`, { data: { text: "say hello to the dock", mode: "normal" } });
  const title = "todo for the dock switch";
  const work = (await (await request.post("/api/chats", { data: { harnessId: "fake", workspaceId: ws.id } })).json()) as { chatId: string };
  await request.post(`/api/chats/${work.chatId}/messages`, { data: { text: title, mode: "normal" } });
  await expect
    .poll(async () => ((await (await request.get(`/api/chats/${work.chatId}`)).json()) as { status: string }).status)
    .toBe("idle");
  await page.goto(`/#chat=${plain.chatId}`);
  await expect(page.getByTestId("git-row")).toBeVisible();
  // Sample every frame of the switch: a git status belongs to the project, so the dock already has it on the
  // frame the transcript lands. Without that, the lane arrives a round trip later and pushes the composer up.
  const frames = await page.evaluate(async (title) => {
    const out: Array<{ turns: number; height: number }> = [];
    const row = [...document.querySelectorAll<HTMLElement>(".sidebar .session")].find((el) => el.querySelector(".session-title")?.textContent === title);
    if (!row) throw new Error(`no sidebar session titled ${title}`);
    row.click();
    // Up to two seconds for the switch to land (a resumed harness starts first), then eight frames of it.
    for (let i = 0; i < 120; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const transcript = document.querySelector(".conversation, .thread");
      const stack = document.querySelector(".status-stack");
      out.push({ turns: transcript ? transcript.querySelectorAll(".turn, .bubble, .drow").length : 0, height: stack ? Math.round(stack.getBoundingClientRect().height) : 0 });
      if (out.filter((frame) => frame.turns > 0).length >= 8) break;
    }
    return out;
  }, title);
  const landed = frames.findIndex((frame) => frame.turns > 0);
  expect(landed).toBeGreaterThanOrEqual(0);
  // Whole on that frame: neither absent (a base-only dock waiting for its reading) nor short of the Todos row.
  const settled = frames[frames.length - 1]?.height ?? 0;
  expect(settled).toBeGreaterThan(32);
  expect(frames[landed]?.height).toBe(settled);
});
