// Actual makeTestApp paths for named native agents and durable group completion.
// No assumed session format, model calls, speculative global provider routing or store mutation.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";
import type { ChatSnapshot, ChatItem } from "../../src/shared/protocol.js";

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function setup() {
  const app = await makeTestApp();
  t = app;
  const agent = await signedIn(app);
  const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body;
  const parent = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  const token = app.manager.list().find((chat) => chat.chatId === parent.chatId)?.orchestration?.token;
  if (!token) throw new Error("token missing");
  return { agent, parent, ws, token, app };
}

async function call(agent: Awaited<ReturnType<typeof signedIn>>, token: string, tool: string, args: unknown) {
  return agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool, args });
}
async function waitUntil(probe: () => boolean, what: string, ms = 15_000) {
  const started = Date.now();
  while (!probe()) {
    if (Date.now() - started > ms) throw new Error(`wait for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
function records(): Array<{ outcome: string | null; wake: { pendingSince: number | null }; completionGroup: string | null }> {
  return JSON.parse(readFileSync(path.join(t!.stateDir, "orchestration", "tasks.json"), "utf8")).tasks;
}
function wakes(snapshot: ChatSnapshot): Array<Extract<ChatItem, { kind: "user" }>> {
  return snapshot.items.filter((item): item is Extract<ChatItem, { kind: "user" }> => item.kind === "user" && item.text.includes("[awui delegate "));
}

describe("A11 persistent named harness chats", () => {
  it("reopens one session, applies a redacted scoped memory, and keeps same-name callers apart", async () => {
    const { agent, token, parent, app } = await setup();
    const started = await call(agent, token, "resident_agent", { name: "reviewer", prompt: "Inspect parser", note: { key: "focus", text: "Core only. apiKey=abc123XYZ456 Bearer unsafeTokenSHOULDNOTLEAK" } });
    expect(started.status).toBe(200);
    const nativeId = started.body.data.nativeId as string;
    const current = t!.manager.list().find((chat) => chat.nativeId === nativeId);
    expect(current).toBeDefined();
    const raw = readFileSync(path.join(t!.stateDir, "orchestration", "residents.json"), "utf8");
    expect(raw).not.toContain("abc123XYZ456");
    expect(raw).not.toContain("unsafeTokenSHOULDNOTLEAK");
    expect(raw).toContain("Core only");
    expect(raw).toContain("[redacted credential]");
    await agent.post(`/api/chats/${current?.chatId}/dispose`).send({});

    const again = await call(agent, token, "resident_agent", { name: "reviewer", prompt: "Continue" });
    expect(again.status).toBe(200);
    expect(again.body.data.nativeId).toBe(nativeId);
    expect(t!.manager.list().filter((chat) => chat.nativeId === nativeId)).toHaveLength(1);
    await waitUntil(() => t!.manager.list().find((chat) => chat.nativeId === nativeId)?.status === "idle", "resident second run");
    expect(t!.manager.list().find((chat) => chat.nativeId === nativeId)?.snapshot().items.filter((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user").at(-1)?.text).toContain("Core only");

    const other = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: parent.workspace.id })).body as ChatSnapshot;
    const otherToken = t!.manager.list().find((chat) => chat.chatId === other.chatId)?.orchestration?.token;
    const otherResident = await call(agent, otherToken as string, "resident_agent", { name: "reviewer", prompt: "A different own purpose" });
    expect(otherResident.status).toBe(200);
    expect(otherResident.body.data.nativeId).not.toBe(nativeId);
    expect(t!.manager.list().filter((chat) => chat.nativeId === nativeId)).toHaveLength(1);
  });
});

describe("A11 group-synchronized wake", () => {
  it("retains first results until last member completes, then produces one consolidated wake", async () => {
    const { agent, token, parent } = await setup();
    const quick = await call(agent, token, "delegate_task", { brief: "inspect work", completionGroup: "pr-review" });
    const slow = await call(agent, token, "delegate_task", { brief: "ask before doing tests", completionGroup: "pr-review" });
    expect(slow.status).toBe(200);
    const blockedId = slow.body.data.childChatId as string;
    await waitUntil(() => blocked().size > 0, "slow request before checking wake");
    await waitUntil(() => records().some((r) => r.completionGroup === "pr-review" && r.outcome === "done"), "quick first member");
    await new Promise((resolve) => setTimeout(resolve, 2700));
    expect(wakes((await agent.get(`/api/chats/${parent.chatId}`)).body as ChatSnapshot)).toHaveLength(0);

    for (const requestId of blocked()) {
      const answered = await agent.post(`/api/chats/${blockedId}/requests/${encodeURIComponent(requestId)}`).send({ answer: { kind: "confirm", confirmed: true } });
      expect(answered.status).toBe(200);
    }
    await waitUntil(() => wakes(t!.manager.get(parent.chatId).snapshot()).length === 1, "single wake after approvals");
    const snapshot = (await agent.get(`/api/chats/${parent.chatId}`)).body as ChatSnapshot;
    const added = wakes(snapshot);
    expect(added[0]?.text).toContain(quick.body.data.taskId);
    expect(added[0]?.text).toContain(slow.body.data.taskId);
    await waitUntil(() => records().filter((r) => r.completionGroup === "pr-review").every((r) => r.outcome === "done" && r.wake.pendingSince === null), "the consolidated delivery itself persisted");
    expect(records().filter((r) => r.completionGroup === "pr-review").every((r) => r.outcome === "done" && r.wake.pendingSince === null)).toBe(true);

    function blocked(): Set<string> {
      return new Set(t!.manager.get(blockedId).snapshot().pending.filter((r) => r.kind === "confirm").map((r) => r.id));
    }
  });
});
