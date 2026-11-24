// Agent presets: one list kept by the server for atui and every other client, replaced whole,
// names unique ignoring case, bounded, and written to the state folder so a restart keeps it.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_AGENT_PRESETS } from "../../src/shared/protocol.js";
import { AgentPresets } from "../../src/server/agent-presets.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("agent presets", () => {
  it("starts empty, replaces the whole list, and refuses a name used twice", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    expect((await agent.get("/api/presets")).body).toEqual({ presets: [] });
    const list = [
      { name: "Explore", harnessId: "fake", model: "echo", thinkingLevel: "low" },
      { name: "Deep work", harnessId: "fake", permissionMode: "acceptEdits" },
    ];
    expect((await agent.put("/api/presets").send({ presets: list })).body).toEqual({ presets: list });
    expect((await agent.get("/api/presets")).body.presets).toEqual(list);
    expect((await agent.put("/api/presets").send({ presets: [list[0], { ...list[0], name: "explore" }] })).status).toBe(409);
    // The refused write left the list as it was; an empty list clears it.
    expect((await agent.get("/api/presets")).body.presets).toEqual(list);
    expect((await agent.put("/api/presets").send({ presets: [] })).body).toEqual({ presets: [] });
  });

  it("is bounded and takes a one-line name only", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const many = Array.from({ length: MAX_AGENT_PRESETS + 1 }, (_, i) => ({ name: `p${i}`, harnessId: "fake" }));
    expect((await agent.put("/api/presets").send({ presets: many })).status).toBe(400);
    expect((await agent.put("/api/presets").send({ presets: [{ name: "two\nlines", harnessId: "fake" }] })).status).toBe(400);
  });

  it("keeps the list across a restart", async () => {
    const dir = tempDir("awui-presets-");
    const store = await AgentPresets.open(dir);
    await store.replace([{ name: "Review", harnessId: "claude", model: "opus" }]);
    expect((await AgentPresets.open(dir)).list()).toEqual([{ name: "Review", harnessId: "claude", model: "opus" }]);
  });
});
