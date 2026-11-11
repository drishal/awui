// Board rooms end to end against the fake harnesses: a bot, a room, a bare
// message running only the lead, mention routing in rank order, one bounded
// consultation round nested under its requester, a stop, an answered approval,
// and the Markdown export. Rooms are the server's own state, so nothing here
// touches another spec's chats; every test makes its own bots and rooms.
import { expect, test, type Page } from "@playwright/test";
import { showSidebar, signInAndOpen } from "./helpers.js";

/** Create a bot through the room editor's entry (the only one), leaving the room dialog open. */
async function makeBot(page: Page, name: string) {
  await page.getByRole("button", { name: "New room" }).click();
  await page.getByRole("button", { name: /^(New bot|Create a bot)$/ }).click();
  await page.getByLabel("Bot name").fill(name);
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name: `Add ${name}` })).toBeVisible({ timeout: 10_000 });
}

/** Create a room (the New room dialog must be open) and open it. */
async function makeRoom(page: Page, room: string, bots: string[]) {
  await page.getByLabel("Room name").fill(room);
  for (const bot of bots) await page.getByRole("button", { name: `Add ${bot}` }).click();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("button", { name: `Open room ${room}` }).click();
  await expect(page.getByTestId("room-view")).toBeVisible({ timeout: 10_000 });
}

/** Send a message to the open room and wait for the turn to settle back to Idle. */
async function sendAndWait(page: Page, text: string) {
  const box = page.getByLabel("Message the room");
  await box.focus();
  await box.click();
  await box.pressSequentially(text);
  await page.getByRole("button", { name: "Send to the room" }).click();
  await expect
    .poll(() => page.getByTestId("room-status").textContent(), { timeout: 30_000 })
    .toBe("Idle");
}

test.beforeEach(async ({ page }) => {
  await signInAndOpen(page, "alpha");
  await showSidebar(page);
});

test("a bare message runs only the lead bot, and a reload replays the room without duplicates", async ({ page }) => {
  await makeBot(page, "Solo Lead");
  await makeRoom(page, "Solo Room", ["Solo Lead"]);
  await sendAndWait(page, "hello room");
  const runs = page.getByTestId("bot-run");
  await expect(runs).toHaveCount(1);
  await expect(page.getByTestId("bot-run").getByText("Solo Lead", { exact: true })).toBeVisible();
  await expect(page.getByTestId("bot-run-status")).toHaveText("Done");
  // The user message is one record, replayed exactly once after a reload.
  const messages = page.getByTestId("room-user-message");
  const count = await messages.count();
  await page.reload();
  await page.getByRole("button", { name: "Open room Solo Room" }).click();
  await expect(page.getByTestId("room-view")).toBeVisible();
  await expect(page.getByTestId("room-user-message")).toHaveCount(count);
});

test("mentions run exactly the named bots, in room rank order", async ({ page }) => {
  await makeBot(page, "Rank First");
  await page.getByRole("button", { name: /^(New bot|Create a bot)$/ }).click();
  await page.getByLabel("Bot name").fill("Rank Second");
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name: "Add Rank Second" })).toBeVisible({ timeout: 10_000 });
  await makeRoom(page, "Rank Room", ["Rank First", "Rank Second"]);
  // Address both by handle: the menu completes @handles into structured mentions.
  const box = page.getByLabel("Message the room");
  await box.fill("roomtwice @");
  await page.getByRole("option", { name: /rank first/i }).click();
  await box.pressSequentially("@");
  await page.getByRole("option", { name: /rank second/i }).click();
  await page.getByRole("button", { name: "Send to the room" }).click();
  await expect
    .poll(() => page.getByTestId("room-status").textContent(), { timeout: 30_000 })
    .toBe("Idle");
  const runs = page.getByTestId("bot-run");
  await expect(runs).toHaveCount(2);
  // Rank order, not mention order or name order: the first card is Rank First.
  await expect(runs.first().getByText("Rank First", { exact: true })).toBeVisible();
  await expect(page.getByTestId("bot-run-status").first()).toHaveText("Done");
});

test("a new room's lead is the bot marked Lead, not the first one added", async ({ page }) => {
  await makeBot(page, "First Pick");
  await page.getByRole("button", { name: /^(New bot|Create a bot)$/ }).click();
  await page.getByLabel("Bot name").fill("Marked Lead");
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name: "Add Marked Lead" })).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Room name").fill("Lead Room");
  await page.getByRole("button", { name: "Add First Pick" }).click();
  await page.getByRole("button", { name: "Add Marked Lead" }).click();
  // The first bot added leads until another is marked.
  await expect(page.getByRole("button", { name: "Make First Pick the lead" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Make Marked Lead the lead" }).click();
  await expect(page.getByRole("button", { name: "Make First Pick the lead" })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("button", { name: "Open room Lead Room" }).click();
  await page.getByRole("button", { name: "Room members" }).click();
  await expect(page.getByRole("button", { name: "Room lead", exact: true })).toHaveText(/Marked Lead/);
});

test("a consultation round nests under its requester and the requester answers plainly", async ({ page }) => {
  await makeBot(page, "Asker Bot");
  await page.getByRole("button", { name: /^(New bot|Create a bot)$/ }).click();
  await page.getByLabel("Bot name").fill("Sage Bot");
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name: "Add Sage Bot" })).toBeVisible({ timeout: 10_000 });
  await makeRoom(page, "Consult Room", ["Asker Bot", "Sage Bot"]);
  // The lead may consult the second member: both switches live in the members sheet.
  await page.getByRole("button", { name: "Room members" }).click();
  await page.getByLabel("Allow consulting Sage Bot").check();
  const asker = page.getByTestId("room-member").filter({ has: page.getByText("Asker Bot", { exact: true }) });
  await asker.getByText("May consult nobody").click();
  await page.getByLabel("Let Asker Bot consult Sage Bot").click();
  // The roster redraws from the patch's roundtrip, not optimistically: wait for the summary to say so.
  await expect(asker.getByText(/May consult 1 member/)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await sendAndWait(page, "consult");
  // One consultation record and two speakers: the requester (its control turn and synthesis share one
  // speaker line around the fold) and the consultant inside the fold.
  await expect(page.getByTestId("consultation")).toHaveCount(1);
  await expect(page.getByTestId("bot-run")).toHaveCount(2);
  const statuses = page.getByTestId("bot-run-status");
  await expect(statuses.first()).toHaveText("Done");
});

test("stop cancels a slow turn and the message queued behind it", async ({ page }) => {
  await makeBot(page, "Slow Bot");
  await makeRoom(page, "Slow Room", ["Slow Bot"]);
  const box = page.getByLabel("Message the room");
  await box.fill("slow");
  await page.getByRole("button", { name: "Send to the room" }).click();
  await expect(page.getByTestId("room-status")).toHaveText("Working", { timeout: 10_000 });
  // A second message queues behind the running turn; Stop must cancel it too, or it would charge later.
  await box.fill("queued behind");
  await page.getByRole("button", { name: "Send to the room" }).click();
  // Exact: the queued message's own text and the composer's queue note also contain "queued".
  await expect(page.getByText("Queued", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Stop the room's work" }).click();
  // The stopped turn clears the active slot, so the room is Idle again; the run itself says Stopped.
  await expect
    .poll(() => page.getByTestId("room-status").textContent(), { timeout: 30_000 })
    .toBe("Idle");
  await expect(page.getByTestId("bot-run-status").first()).toHaveText("Stopped", { timeout: 15_000 });
  await expect(page.getByText(/queued turn/i)).toBeVisible();
});

test("an approval a bot raises is answered from the room", async ({ page }) => {
  await makeBot(page, "Asking Bot");
  await makeRoom(page, "Ask Room", ["Asking Bot"]);
  const box = page.getByLabel("Message the room");
  await box.fill("ask");
  await page.getByRole("button", { name: "Send to the room" }).click();
  await expect(page.getByRole("region", { name: /Asking Bot is waiting for you/i })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect
    .poll(() => page.getByTestId("room-status").textContent(), { timeout: 30_000 })
    .toBe("Idle");
  await expect(page.getByTestId("bot-run-status").first()).toHaveText("Done");
});

test("the room exports as Markdown", async ({ page }) => {
  await makeBot(page, "Exported Bot");
  await makeRoom(page, "Export Room", ["Exported Bot"]);
  await sendAndWait(page, "hello room");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export room as Markdown" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
});

test("a room opens in its own tab named after it, and closing that tab shows the start screen", async ({ page }) => {
  await makeBot(page, "Tab Lead");
  await makeRoom(page, "Tab Room", ["Tab Lead"]);
  const strip = page.getByRole("tablist", { name: "Open tabs" });
  const tab = strip.getByRole("tab", { name: /Tab Room/ });
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveTitle(/Tab Room/);
  await page.getByRole("button", { name: "Close Tab Room" }).click();
  await expect(page.getByTestId("room-view")).toHaveCount(0);
  await expect(tab).toHaveCount(0);
  await expect(page).toHaveTitle("awui");
});
