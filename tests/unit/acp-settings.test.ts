import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcpAgentConfig } from "../../src/server/config.js";
import { AcpAdapter, liveAcpAdapterChildren } from "../../src/server/harness/acp.js";
import { liveAcpChildren } from "../../src/server/harness/acp-client.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-acp.mjs");
chmodSync(script, 0o755);

let t: TestApp;
const close: Array<() => Promise<void>> = [];
/** The chats a test opened on its own agents, and the agents themselves, torn down after it. */
const chats: LiveChat[] = [];
const agents: AcpAdapter[] = [];

beforeEach(async () => {
  t = await makeTestApp({ withSettings: true });
});

afterEach(async () => {
  for (const chat of chats.splice(0)) await chat.dispose();
  for (const adapter of agents.splice(0)) await adapter.shutdown();
  for (const done of close.splice(0)) await done();
  await t.close();
});

/** config.yml in the test server's settings folder (the folder exists, the file does not). */
function config(yaml: string): void {
  const dir = path.join(t.root, "settings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.yml"), yaml);
}

/** A live chat of this agent, as one of awui's own chats opens it: its child belongs to the agent's key. */
async function liveChat(agent: AcpAgentConfig): Promise<LiveChat> {
  const adapter = new AcpAdapter(agent, { home: t.root, stateDir: path.join(t.root, "state") });
  agents.push(adapter);
  const live = await adapter.openChat({ cwd: t.project });
  chats.push(live);
  return live;
}

describe("the ACP agents settings route", () => {
  it("tests a saved agent with one handshake and reports what it advertises, and leaves no child", async () => {
    config(`harnesses:\n  acp:\n    - id: acp-fake\n      command: ${script}\n`);
    const agent = await signedIn(t);
    const res = await agent.post("/api/settings/acp/test").send({ id: "acp-fake" }).expect(200);
    expect(res.body).toEqual({
      agentName: "Fake ACP",
      version: "0.9.1",
      resume: true,
      replay: true,
      images: true,
      mcpHttp: true,
      authMethods: ["agent-login", "api-key"],
      warnings: [],
    });
    expect(liveAcpChildren()).toBe(0);
  });

  it("names an entry config.yml does not have", async () => {
    config("port: 4783\n");
    const agent = await signedIn(t);
    const missing = await agent.post("/api/settings/acp/test").send({ id: "nope" }).expect(404);
    expect(missing.body.code).toBe("unknown_acp_agent");
  });

  it("reports a handshake that never came as a bounded reason, without the child's stderr", async () => {
    config(`harnesses:\n  acp:\n    - id: acp-broken\n      command: ${path.join(t.root, "no-such-agent")}\n`);
    const agent = await signedIn(t);
    const res = await agent.post("/api/settings/acp/test").send({ id: "acp-broken" }).expect(502);
    expect(res.body.code).toBe("acp_handshake_failed");
    expect(String(res.body.error)).toMatch(/could not start/);
    expect(String(res.body.error)).not.toContain(script);
  });

  it("answers how an agent that died ended, never the secret it printed on stderr", async () => {
    config(`harnesses:\n  acp:\n    - id: acp-dying\n      command: ${script}\n      env:\n        FAKE_ACP_DIE_ON_INIT: sk-not-a-real-secret\n`);
    const agent = await signedIn(t);
    const res = await agent.post("/api/settings/acp/test").send({ id: "acp-dying" }).expect(502);
    expect(res.body.code).toBe("acp_handshake_failed");
    expect(String(res.body.error)).toBe("acp-dying exited before it answered the initialize handshake (exit code 7)");
    expect(JSON.stringify(res.body)).not.toContain("sk-not-a-real-secret");
    expect(liveAcpChildren()).toBe(0);
  });

  /**
   * A chat of the agent being tested keeps its own child: the Test's handshake is its own, and
   * shutting a throwaway adapter down must not reach the children of a live chat.
   */
  it("leaves a live chat of the agent it tests running", async () => {
    const state = path.join(t.root, "live.json");
    config(`harnesses:\n  acp:\n    - id: acp-live\n      command: ${script}\n`);
    const live = await liveChat({ id: "acp-live", name: "acp-live", command: script, args: [], env: { FAKE_ACP_STATE: state }, authMethod: null });
    expect(liveAcpAdapterChildren("acp-live")).toBe(1);
    const agent = await signedIn(t);
    await agent.post("/api/settings/acp/test").send({ id: "acp-live" }).expect(200);
    expect(liveAcpAdapterChildren("acp-live")).toBe(1);
    await live.dispose();
    expect(liveAcpAdapterChildren("acp-live")).toBe(0);
  });

  /** Two entries may share a free-text name; only the tested entry's own children belong to it. */
  it("keeps one agent's children apart when two share a name", async () => {
    config(`harnesses:\n  acp:\n    - id: acp-one\n      name: Same Agent\n      command: ${script}\n    - id: acp-two\n      name: Same Agent\n      command: ${script}\n`);
    const one = await liveChat({ id: "acp-one", name: "Same Agent", command: script, args: [], env: { FAKE_ACP_STATE: path.join(t.root, "one.json") }, authMethod: null });
    const two = await liveChat({ id: "acp-two", name: "Same Agent", command: script, args: [], env: { FAKE_ACP_STATE: path.join(t.root, "two.json") }, authMethod: null });
    const agent = await signedIn(t);
    await agent.post("/api/settings/acp/test").send({ id: "acp-one" }).expect(200);
    expect(liveAcpAdapterChildren("acp-one")).toBe(1);
    expect(liveAcpAdapterChildren("acp-two")).toBe(1);
    // The Test's own child is gone: two live chats are all that is left.
    expect(liveAcpChildren()).toBe(2);
    await one.dispose();
    await two.dispose();
  });

  it("shows which variables an entry sets, never their values", async () => {
    config(`harnesses:\n  acp:\n    - id: acp-fake\n      command: ${script}\n      env:\n        FAKE_ACP_STATE: ${path.join(t.root, "state.json")}\n`);
    const agent = await signedIn(t);
    const res = await agent.get("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body.values.acpAgents).toEqual([{ id: "acp-fake", name: "acp-fake", command: script, args: [], envNames: ["FAKE_ACP_STATE"], authMethod: null }]);
    expect(JSON.stringify(res.body)).not.toContain(path.join(t.root, "state.json"));
    expect(readFileSync(path.join(t.root, "settings", "config.yml"), "utf8")).toContain("FAKE_ACP_STATE");
  });
});
