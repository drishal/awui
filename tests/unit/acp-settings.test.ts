import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveAcpChildren } from "../../src/server/harness/acp-client.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-acp.mjs");
chmodSync(script, 0o755);

let t: TestApp;
const close: Array<() => Promise<void>> = [];

beforeEach(async () => {
  t = await makeTestApp({ withSettings: true });
});

afterEach(async () => {
  for (const done of close.splice(0)) await done();
  await t.close();
});

/** config.yml in the test server's settings folder (the folder exists, the file does not). */
function config(yaml: string): void {
  const dir = path.join(t.root, "settings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.yml"), yaml);
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
