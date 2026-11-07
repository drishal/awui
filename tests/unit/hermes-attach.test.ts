import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { HermesAdapter, liveHermesLinks } from "../../src/server/harness/hermes.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

// Attaching, rather than starting a gateway of our own: the scripted gateway fixture
// serves a home's control socket and /api/ws — translating the canonical session wire
// onto the same scripts the stdio fake runs — so a test drives the real client path
// without a real Hermes: identify → ticket → upgrade → canonical verbs. The launcher
// points nowhere, so anything that fell back to starting a child would fail loudly
// instead of quietly passing.
const gatewayScript = path.join(import.meta.dirname, "..", "fixtures", "fake-hermes-gateway.mjs");
chmodSync(gatewayScript, 0o755);

let home: string;
let project: string;
let state: string;
let gateway: ChildProcess | null = null;
let adapter: HermesAdapter;
const savedHome = process.env.HERMES_HOME;
const savedState = process.env.FAKE_HERMES_STATE;

beforeEach(async () => {
  home = tempDir("awui-hermes-gateway-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      spawns: [],
      rows: [{ id: "20261002_120000_fake1", title: "Fake Hermes session", cwd: project, last_active: 1790921090, message_count: 3 }],
    }),
  );
  process.env.HERMES_HOME = home;
  process.env.FAKE_HERMES_STATE = state;
  adapter = new HermesAdapter({ launcher: path.join(home, "no-such-hermes") });
  gateway = spawn(process.execPath, [gatewayScript, home], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    gateway?.stdout?.once("data", () => resolve());
    setTimeout(() => reject(new Error("the scripted gateway did not start")), 8_000);
  });
});

afterEach(async () => {
  await adapter.shutdown();
  gateway?.kill("SIGKILL");
  gateway = null;
  expect(liveHermesLinks()).toBe(0);
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  if (savedState === undefined) delete process.env.FAKE_HERMES_STATE;
  else process.env.FAKE_HERMES_STATE = savedState;
});

const canonical = (): { name: string; params: Record<string, unknown> }[] => {
  try {
    const calls = JSON.parse(readFileSync(`${state}.canonical.json`, "utf8"));
    return Array.isArray(calls) ? calls : [];
  } catch {
    return [];
  }
};

async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function openChat() {
  const live = await adapter.openChat({ cwd: project });
  const ws: WorkspaceInfo = { id: "w", path: project, name: "proj" };
  return { live, chat: await Chat.open("c1", adapter, ws, live) };
}

describe("a Hermes home whose gateway is running", () => {
  it("reads availability and the version from the gateway itself, with no CLI to fall back on", async () => {
    const found = await adapter.discover();
    expect(found).toMatchObject({ available: true, version: "1.2.3", versionDetail: "1.2.3 · gateway fakesha1" });
    // A running owner is the normal state now: chats ride it too, so nothing is warned about.
    expect(found.warnings).toEqual([]);
    expect(liveHermesLinks()).toBe(0);
  });

  it("reads session rows through the attachment", async () => {
    const rows = await adapter.listRecentSessions(5);
    expect(rows.map((row) => row.nativeId)).toEqual(["20261002_120000_fake1"]);
    expect(rows[0]).toMatchObject({ title: "Fake Hermes session", cwd: project });
    // One short-lived attachment per read, and nothing of ours left behind.
    expect(liveHermesLinks()).toBe(0);
  });

  it("reads a project's sessions and its models over the attachment", async () => {
    expect((await adapter.listSessions(project)).map((row) => row.nativeId)).toEqual(["20261002_120000_fake1"]);
    expect((await adapter.listModels(project, true)).map((model) => model.key)).toEqual(["fake/fake-model", "fake/fake-mini"]);
    expect(liveHermesLinks()).toBe(0);
  });

  it("reads a session's own rows, so a chat opens before its gateway does", async () => {
    // A chat opened and left unused has no rows, but its session is this folder's: the deferred
    // resume shows an empty transcript and opens it, instead of refusing it as unknown.
    const fresh = await adapter.openChat({ cwd: project });
    const nativeId = fresh.nativeId as string;
    expect(await adapter.readTranscript({ cwd: project, nativeId })).toEqual({ items: [], title: "Fake Hermes session" });
    await fresh.dispose();
    // The gateway resolves a session by id alone, so another folder must not read it here: null
    // sends the manager to its session-list guard, which says exactly that.
    expect(await adapter.readTranscript({ cwd: "/", nativeId })).toBeNull();
    expect(liveHermesLinks()).toBe(0);
  });

  it("runs a chat on the gateway: create, submit with an input id, stream, settle", async () => {
    const { chat, live } = await openChat();
    expect(live.nativeId).toBe("20261002_120000_fake1");
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle");
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ text: "hermes says hello there", streaming: false });
    const names = canonical().map((call) => call.name);
    expect(names).toEqual(expect.arrayContaining(["runtime.describe", "session.create", "prompt.submit"]));
    const create = canonical().find((call) => call.name === "session.create");
    expect(create?.params).toMatchObject({ source: "gui", cwd: project });
    expect(create?.params.request_id).toEqual(expect.any(String));
    const submit = canonical().find((call) => call.name === "prompt.submit");
    expect(submit?.params).toMatchObject({ session_id: "4242", text: "hello there", queued: true });
    expect(submit?.params.input_id).toEqual(expect.any(String));
  });

  it("asks the session to stream its reasoning on create and on resume", async () => {
    const created = await adapter.openChat({ cwd: project });
    const nativeId = created.nativeId;
    expect(nativeId).toBe("20261002_120000_fake1");
    await created.dispose();
    if (!nativeId) throw new Error("the created chat has no session id");
    const resumed = await adapter.openChat({ cwd: project, resumeNativeId: nativeId });
    await resumed.dispose();
    const shows = canonical().filter((call) => call.name === "config.set" && call.params.key === "show_reasoning");
    expect(shows.map((call) => call.params)).toEqual([
      { session_id: "4242", key: "show_reasoning", value: "1" },
      { session_id: "4242", key: "show_reasoning", value: "1" },
    ]);
    const names = canonical().map((call) => call.name);
    expect(names.indexOf("session.create")).toBeLessThan(names.indexOf("config.set"));
    expect(names.indexOf("session.resume")).toBeLessThan(names.lastIndexOf("config.set"));
  });

  it("turns a gateway approval event into a card and its answer into approval.respond", async () => {
    const { chat } = await openChat();
    await chat.send("ask please", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const request = chat.snapshot().pending[0];
    expect(request).toMatchObject({ kind: "select", options: ["once", "session", "always", "deny"] });
    expect(chat.answer(request?.id as string, { kind: "select", value: "once" })).toContain("once");
    await until(() => chat.status === "idle");
    const respond = canonical().find((call) => call.name === "approval.respond");
    expect(resend(respond)).toMatchObject({ choice: "once", prompt_id: expect.any(String), execution_generation: expect.any(Number) });
    // The run continued past the approval to its answer.
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ text: "hermes says ask please" });
  });

  it("sends model and reasoning changes as fenced session mutations", async () => {
    const { chat, live } = await openChat();
    await chat.setConfig({ model: "fake/fake-mini" });
    await chat.setConfig({ thinkingLevel: "xhigh" });
    const model = canonical().find((call) => call.name === "session.mutate" && call.params.operation === "model");
    expect(model?.params).toMatchObject({ expected_generation: expect.any(Number), expected_revision: expect.any(Number), payload: { model: "fake-mini", provider: "fake" } });
    const reasoning = canonical().find((call) => call.name === "session.mutate" && call.params.operation === "reasoning");
    expect(reasoning?.params.payload).toEqual({ effort: "xhigh" });
    await chat.send("whoami", "normal");
    await until(() => chat.status === "idle");
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ text: "on fake as fake-mini" });
    expect(await live.getUsage()).toMatchObject({ turns: 1 });
  });

  it("changes the model after a turn, when the owner has moved the execution generation", async () => {
    const { chat } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle");
    // The turn's start moved the generation past the one the submit receipt named; the change presents the current one.
    await chat.setConfig({ model: "fake/fake-mini" });
    expect(chat.snapshot().config.model).toBe("fake/fake-mini");
    const models = canonical().filter((call) => call.name === "session.mutate" && call.params.operation === "model");
    expect(models).toHaveLength(1);
    await chat.send("whoami", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.filter((i) => i.kind === "assistant").length === 2);
    expect(chat.snapshot().items.filter((i) => i.kind === "assistant").at(-1)).toMatchObject({ text: "on fake as fake-mini" });
  });

  it("retries a model change once at the fences a stale-revision refusal names", async () => {
    const { chat } = await openChat();
    await chat.send("silentrename now", "normal");
    await until(() => chat.status === "idle");
    // The revision moved with no event this client saw: the first attempt is refused, the retry presents the owner's.
    await chat.setConfig({ model: "fake/fake-mini" });
    expect(chat.snapshot().config.model).toBe("fake/fake-mini");
    const models = canonical().filter((call) => call.name === "session.mutate" && call.params.operation === "model");
    expect(models).toHaveLength(2);
    expect(Number(models[1]?.params.expected_revision)).toBe(Number(models[0]?.params.expected_revision) + 1);
  });

  it("rewinds with a mutation before the reworded prompt", async () => {
    const { chat } = await openChat();
    for (const text of ["one", "two", "three"]) {
      await chat.send(text, "normal");
      await until(() => chat.status === "idle");
    }
    await chat.rewind(2, "two, reworded");
    await until(() => chat.status === "idle");
    const users = chat.snapshot().items.flatMap((i) => (i.kind === "user" ? [i.text] : []));
    expect(users).toEqual(["one", "two, reworded"]);
    const calls = canonical();
    const rewind = calls.findIndex((call) => call.name === "session.mutate" && call.params.operation === "rewind");
    expect(rewind).toBeGreaterThanOrEqual(0);
    expect(calls[rewind]?.params.payload).toEqual({ target_message_id: expect.any(Number) });
    // The new prompt is submitted after the cut.
    expect(calls.map((call) => call.name).lastIndexOf("prompt.submit")).toBeGreaterThan(rewind);
  });

  it("detaches on close and never ends the gateway's session", async () => {
    const { chat } = await openChat();
    await chat.dispose("Closed by user");
    const names = canonical().map((call) => call.name);
    expect(names).toContain("session.detach");
    expect(names).not.toContain("session.close");
    // end_reason closes the conversation. Leaving is a detach without one.
    expect(canonical().filter((call) => call.name === "session.detach").every((call) => call.params.end_reason === undefined)).toBe(true);
  });

  it("shows a resumed transcript when the gateway returns stored rows, not display text", async () => {
    const { chat, live } = await openChat();
    await chat.send("tool please", "normal");
    await until(() => chat.status === "idle");
    const items = await live.history();
    expect(items.find((item) => item.kind === "user")).toMatchObject({ text: "tool please" });
    expect(items.find((item) => item.kind === "tool")).toMatchObject({ name: "read", output: "file.txt", summary: "README.md" });
    const assistant = items.find((item) => item.kind === "assistant");
    expect(assistant && assistant.kind === "assistant" ? assistant.text : "").toContain("hermes says tool please");
  });

  it("shows a session the gateway will not mount from state.db, and says so", async () => {
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_call_id TEXT, tool_calls TEXT, reasoning TEXT, timestamp REAL, active INTEGER)");
    db.prepare("INSERT INTO sessions (id, cwd, title) VALUES (?, ?, ?)").run("refused-webui", project, "Old awui chat");
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, ?)").run("refused-webui", "user", "hello from the store", 1, 1);
    db.close();
    const transcript = await adapter.readTranscript({ cwd: project, nativeId: "refused-webui" });
    expect(transcript?.title).toBe("Old awui chat");
    expect(transcript?.items.find((item) => item.kind === "user")).toMatchObject({ text: "hello from the store" });
    // Another folder is not this workspace's to open.
    expect(await adapter.readTranscript({ cwd: "/", nativeId: "refused-webui" })).toBeNull();
    await expect(adapter.openChat({ cwd: project, resumeNativeId: "refused-webui" })).rejects.toThrow(/source webui/);
  });
});

describe("a Hermes home with no gateway of its own", () => {
  it("ensures one (`hermes gateway ensure`) and runs the chat on it", async () => {
    // Nothing answers the home now: the fixture gateway is gone and its socket is stale.
    gateway?.kill("SIGKILL");
    gateway = null;
    const launcher = path.join(home, "hermes-stub");
    writeFileSync(
      launcher,
      `#!/bin/sh
#!/bin/sh
case "$1" in
  gateway)
    [ "$2" = "ensure" ] || exit 1
    echo called > "${home}/ensured"
    rm -f "${home}/gateway.sock"
    node "${gatewayScript}" "${home}" > "${home}/gateway.log" 2>&1 &
    echo $! > "${home}/gateway-pid"
    # Ready is the fixture's last line, once its control socket answers.
    for i in $(seq 1 200); do grep -q ready "${home}/gateway.log" 2>/dev/null && exit 0; sleep 0.05; done
    exit 1 ;;
  --version) echo "Hermes Agent v2026.9.24"; exit 0 ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(launcher, 0o755);
    const ensured = new HermesAdapter({ launcher });
    try {
      const live = await ensured.openChat({ cwd: project });
      const ws: WorkspaceInfo = { id: "w", path: project, name: "proj" };
      const chat = await Chat.open("c2", ensured, ws, live);
      await chat.send("hello there", "normal");
      await until(() => chat.status === "idle");
      const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
      expect(assistant).toMatchObject({ text: "hermes says hello there" });
      expect(existsSync(path.join(home, "ensured"))).toBe(true);
      await chat.dispose("Closed by user");
    } finally {
      await ensured.shutdown();
      const pid = Number(readFileSync(path.join(home, "gateway-pid"), "utf8").trim());
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
});

/** A recorded `…respond` call's params, or a failing match object when it never happened. */
function resend(call: { params: Record<string, unknown> } | undefined): Record<string, unknown> {
  return call?.params ?? { missing: true };
}
