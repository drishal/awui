import { expect, test } from "@playwright/test";
import { newChat, sendAndWait, signInAndOpen } from "./helpers.js";

// C7 hibernation, driven through the real server: a chat parked by its bounded hidden clock
// comes back through its tab with the same conversation present read-only, its session intact,
// and a second writer never appears. The fake harness takes no real resume delay, so the park
// and the reopen are the parts under test, not the harness's own start time.

test("a parked chat reopens with its conversation and works again", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "hello there");
  // Park it by hand through the same dispose the scheduler takes; the reopen is the part
  // the client sees: the tab's session id reopens the native session, no second writer.
  const parked = await page.evaluate(async () => {
    const id = window.location.hash.slice("#chat=".length);
    await fetch(`/api/chats/${id}/dispose`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return id;
  });
  // The tab's banner names why the chat is gone, but only for the moment before its session reopens on its own (a
  // gone chat comes back through its tab at once), so the chat id changing is the steady thing to wait for.
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toBe(`#chat=${parked}`);
  // Reopen through the sidebar row: the same session, its conversation present.
  await page.locator(".session").filter({ hasText: "hello there" }).first().click();
  await expect(page.getByTestId("chat-status")).toHaveText("Idle", { timeout: 20_000 });
  await expect(page.getByTestId("turn").last().getByTestId("answer")).toContainText("Echo: hello there");
  // It works again: one more turn, the only writer for this session.
  await sendAndWait(page, "and again");
  await expect(page.getByTestId("turn")).toHaveCount(2);
});
