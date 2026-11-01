// The internal-owner seam: Board's rooms will drive harness sessions through
// ChatManager like any chat, marked so ordinary surfaces can keep them out.
// These tests pin the seam itself — the owner lands on the chat, an owned chat
// takes no ordinary checkpoints and no render token, and the settle wait an
// internal caller holds on is public. Ordinary chats are unchanged.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "../../src/server/checkpoints.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
const workspace: WorkspaceInfo = { id: "ws", path: path.join(path.sep, "proj"), name: "proj" };
const owner = { kind: "room" as const, roomId: "r1", membershipId: "m1" };

function managerWithCheckpoints(): ChatManager {
  const dir = mkdtempSync(path.join(tmpdir(), "awui-cp-"));
  const manager = new ChatManager();
  manager.render = { baseUrl: "http://127.0.0.1:4799" };
  manager.checkpoints = { service: new Checkpoints(dir), sessionsDir: path.join(dir, "sessions") };
  return manager;
}

describe("internal chat ownership (the Board seam)", () => {
  it("marks a chat created with an owner, and leaves ordinary chats unmarked", async () => {
    const manager = new ChatManager();
    const owned = await manager.create(new FakeAdapter(), workspace, owner);
    const ordinary = await manager.create(new FakeAdapter(), workspace);
    expect(owned.owner).toEqual(owner);
    expect(ordinary.owner).toBeUndefined();
    await manager.shutdown();
  });

  it("gives an owned chat no ordinary checkpoints and no render token; an ordinary chat gets both", async () => {
    const manager = managerWithCheckpoints();
    const owned = await manager.create(new FakeAdapter(), workspace, owner);
    const ordinary = await manager.create(new FakeAdapter(), workspace);
    expect(owned.checkpoints).toBeUndefined();
    expect(owned.render).toBeUndefined();
    expect(ordinary.checkpoints).toBeDefined();
    expect(ordinary.render).toMatchObject({ baseUrl: "http://127.0.0.1:4799" });
    await manager.shutdown();
  });

  it("never opens a second writer: resuming a live native session returns the chat that owns it", async () => {
    const manager = new ChatManager();
    const adapter = new FakeAdapter();
    const first = await manager.create(adapter, workspace, owner);
    expect(first.nativeId).toBeTruthy();
    // The by-session hit short-circuits: whoever asks second gets the live chat, never a second child.
    const second = await manager.resume(adapter, workspace, first.nativeId as string, { ...owner, membershipId: "m2" });
    expect(second.chatId).toBe(first.chatId);
    expect(manager.liveChatFor(adapter.id, first.nativeId as string)?.chatId).toBe(first.chatId);
    await manager.shutdown();
  });

  it("exposes the settle wait an internal caller holds on, resolving at once when idle", async () => {
    const manager = new ChatManager();
    const chat = await manager.create(new FakeAdapter(), workspace, owner);
    expect(chat.status).toBe("idle");
    await expect(chat.waitSettled()).resolves.toBeUndefined();
    await manager.shutdown();
  });
});
