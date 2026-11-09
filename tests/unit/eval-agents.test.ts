// Agents omp's eval spawns from inside a cell belong to the eval call: its card
// holds their rows while the cell runs and their answers once it ends.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, ToolItem } from "../../src/shared/protocol.js";
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

const tools = (chat: ChatSnapshot): ToolItem[] => chat.items.filter((i): i is ToolItem => i.kind === "tool");

describe("agents an eval call spawns", () => {
  it("are the call's runs, live while it works and settled from its answers", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const live = () => (t as TestApp).manager.get(chat.chatId);

    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "spawn two with evalagents" });

    // The call itself is a code run; the agents it started are found from its cells.
    await until(() => (tools(live().snapshot())[0]?.subagents?.runs.length ?? 0) === 2);
    const running = tools(live().snapshot())[0];
    expect(running).toMatchObject({ name: "eval", status: "running", category: "command", subagents: { mode: "parallel" } });
    expect(running?.subagents?.runs.map((r) => [r.id, r.status, r.transcript])).toEqual([
      ["probe-one", "running", true],
      ["probe-two", "running", true],
    ]);

    await until(() => live().status === "idle");
    const settled = tools(live().snapshot())[0];
    const runs = settled?.subagents?.runs ?? [];
    expect(runs.map((r) => [r.id, r.status, r.model])).toEqual([
      ["probe-one", "done", "opencode-go/deepseek-v4.1-flash:high"],
      ["probe-two", "done", "opencode-go/deepseek-v4.1-flash:high"],
    ]);
    // The answer of an eval agent rides on its `yield`, not on an output field.
    expect(runs.map((r) => (r.output ?? "").includes("ONE") ? "ONE" : r.output?.includes("TWO") ? "TWO" : r.output)).toEqual(["ONE", "TWO"]);
  });
});
