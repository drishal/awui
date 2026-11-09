// A read of a picture answers with an image block next to its text. The row
// keeps the picture as a reference (never the bytes on the wire), on both
// paths: a live call as it ends, and a session read back from its file.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, ToolItem } from "../../src/shared/protocol.js";
import type { Obj } from "../../src/server/harness/agent-events.js";
import { historyToItems, normalizeAgentEvent } from "../../src/server/harness/agent-events.js";
import { storedImage } from "../../src/server/image-store.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A 1×1 PNG: the smallest picture a read can hand back. */
const PICTURE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const toolResult = (text: string): Obj => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  content: [
    { type: "text", text },
    { type: "image", mimeType: "image/png", data: PICTURE },
  ],
  isError: false,
});

const toolOf = (items: ChatSnapshot["items"]): ToolItem => {
  const tool = items.find((item) => item.kind === "tool");
  if (!tool || tool.kind !== "tool") throw new Error("no tool item");
  return tool;
};

describe("a picture a call returned", () => {
  it("rides on the row when the session is read back, and the store serves its bytes", () => {
    const items = historyToItems([
      { role: "user", content: [{ type: "text", text: "read the picture" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "docs/screenshots/usage.png" } }] },
      toolResult("Read image file [image/png]"),
    ]);
    const tool = toolOf(items);
    expect(tool.output).toContain("Read image file");
    expect(tool.images).toHaveLength(1);
    const ref = tool.images?.[0];
    expect(ref?.mimeType).toBe("image/png");
    expect(ref?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(storedImage(ref?.id ?? "")?.bytes.length).toBeGreaterThan(0);
  });

  it("is named in the call's end as a reference, not as bytes, and the row keeps it while live", async () => {
    const [event] = normalizeAgentEvent(
      { type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: { content: toolResult("Read image file [image/png]").content }, isError: false },
      "agent_settled",
    );
    expect(event).toMatchObject({ type: "tool_end" });
    const images = event && "images" in event ? event.images : undefined;
    expect(images).toHaveLength(1);
    expect(JSON.stringify(images)).not.toContain(PICTURE);

    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const live = () => (t as TestApp).manager.get(chat.chatId);

    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "imagecall" });
    await until(() => live().status === "idle");
    const tool = toolOf(live().snapshot().items);
    const ref = tool.images?.[0];
    expect(ref?.mimeType).toBe("image/png");
    // The browser fetches the picture by id, with the same session it read the chat with.
    const image = await agent.get(`/api/images/${ref?.id ?? ""}`);
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
  });
});
