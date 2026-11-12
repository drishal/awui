import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { firstPrompt, heldSessions, lastMessageAt, liveOmpChildren, OmpAdapter, ompVersionWarning } from "../../src/server/harness/omp.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-omp.mjs");
chmodSync(script, 0o755);

let home: string;
let project: string;
let state: string;
let adapter: OmpAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-omp-home-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new OmpAdapter({
    command: script,
    agentDir: null,
    sessionDir: null,
    home,
    env: { ...process.env, FAKE_OMP_STATE: state, PI_CODING_AGENT_DIR: "/belongs/to/pi" },
  });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveOmpChildren()).toBe(0);
});

const readState = () => JSON.parse(readFileSync(state, "utf8")) as {
  sessions: Record<string, { messages: unknown[] }>;
  spawns: Array<{ args: string[]; envPiDir: string | null }>;
  lastModel?: string;
  pinned?: string;
};

async function openChat(resumeNativeId?: string) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}) });
  open.push(live);
  const ws: WorkspaceInfo = { id: "w", path: project, name: "proj" };
  return { live, chat: await Chat.open("c1", adapter, ws, live) };
}

async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("omp adapter (scripted omp)", () => {
  it("discovers the version and refuses the home directory", async () => {
    const d = await adapter.discover();
    expect(d).toMatchObject({ available: true, version: "18.4.10", warnings: [] });
    expect(adapter.workspaceProblem(home)).toMatch(/home directory/);
    expect(adapter.workspaceProblem(project)).toBeNull();
  });

  it("softens the version warning to older builds and new major lines", () => {
    expect(ompVersionWarning("18.4.10")).toBeNull();
    expect(ompVersionWarning("18.4.11")).toBeNull();
    expect(ompVersionWarning("18.6.1")).toBeNull();
    expect(ompVersionWarning("18.12.0")).toBeNull();
    expect(ompVersionWarning("18.4.9")).toMatch(/older than/);
    expect(ompVersionWarning("18.3.0")).toMatch(/older than/);
    expect(ompVersionWarning("17.9.9")).toMatch(/different major/);
    expect(ompVersionWarning("19.0.0")).toMatch(/different major/);
    expect(ompVersionWarning("nightly")).toMatch(/written for/);
  });

  it("spawns one rpc-ui child with omp's normal tools and without Pi's PI_* overrides", async () => {
    const { chat } = await openChat();
    const spawns = readState().spawns;
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0];
    expect(spawn?.args.slice(0, 2)).toEqual(["--mode", "rpc-ui"]);
    expect(spawn?.args).not.toContain("--tools");
    expect(spawn?.args).not.toContain("--no-session");
    expect(spawn?.envPiDir).toBeNull();
    expect(chat.snapshot().config).toMatchObject({ model: "fakeomp/m1", thinkingLevel: "low" });
    expect(chat.snapshot().config).not.toHaveProperty("toolsMode");
    expect(JSON.stringify(chat.snapshot())).not.toMatch(/secret/);
    await until(() => chat.snapshot().extensionStatus.plan === "ready");
  });

  it("adds config.yml's arguments to each chat child, before the --cwd awui sets", async () => {
    adapter = new OmpAdapter({ command: script, args: ["--no-skills", "--verbose"], agentDir: null, sessionDir: null, home, env: { ...process.env, FAKE_OMP_STATE: state } });
    await openChat();
    const args = readState().spawns[0]?.args ?? [];
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc-ui"]);
    expect(args.indexOf("--verbose")).toBe(args.indexOf("--no-skills") + 1);
    expect(args.indexOf("--no-skills")).toBeLessThan(args.indexOf("--cwd"));
  });

  it("loads the orchestration extension only for a child that was given a chat token", async () => {
    await openChat();
    const plain = readState().spawns[0]?.args ?? [];
    expect(plain.some((a: string) => a.endsWith("extensions/orchestrate.ts"))).toBe(false);
    const live = await adapter.openChat({ cwd: project, toolEnv: { AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration", AWUI_ORCH_TOKEN: "t0ken" } });
    open.push(live);
    const armed = readState().spawns.at(-1)?.args ?? [];
    expect(armed.some((a: string) => a.endsWith("extensions/orchestrate.ts"))).toBe(true);
  });

  it("replaces a past prompt in place through the rewind-to extension it starts omp with", async () => {
    const { chat, live } = await openChat();
    expect(readState().spawns[0]?.args.some((a: string) => a.endsWith("extensions/rewind-to.ts"))).toBe(true);
    expect(chat.snapshot().capabilities.supportsRewind).toBe(true);
    for (const text of ["one", "two", "three"]) {
      await chat.send(text, "normal");
      await until(() => chat.status === "idle");
    }
    await chat.rewind(2, "two, again");
    await until(() => chat.status === "idle");
    const users = (items: Awaited<ReturnType<typeof live.history>>) => items.flatMap((i) => (i.kind === "user" ? [i.text] : []));
    expect(users(chat.snapshot().items)).toEqual(["one", "two, again"]);
    expect(users(await live.history())).toEqual(["one", "two, again"]);
  });

  it("carries omp's per-model thinking efforts into the model list", async () => {
    const models = await adapter.listModels(project);
    expect(models.find((m) => m.key === "fakeomp/m1")?.levels).toEqual(["low", "high", "max"]);
    const m2 = models.find((m) => m.key === "fakeomp/org/m2");
    expect(m2).toBeDefined();
    expect(m2?.levels).toBeUndefined();
  });

  it("serves the model list from its cache, and asks omp again once told to forget it", async () => {
    await adapter.listModels(project);
    await adapter.listModels(project);
    const probes = () => readState().spawns.filter((s: { args: string[] }) => s.args.includes("--no-session")).length;
    expect(probes()).toBe(1);
    // A Refresh after logging into a provider must reach omp, not the cache.
    adapter.forgetModels(project);
    await adapter.listModels(project);
    expect(probes()).toBe(2);
  });

  it("streams a prompt with a tool call and settles via session_settled", async () => {
    const { chat } = await openChat();
    await chat.send("run tool please", "normal");
    await until(() => chat.status === "idle");
    const items = chat.snapshot().items;
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect(items[2]).toMatchObject({ text: "omp says run tool please", streaming: false });
  });

  it("surfaces select approvals and answers them over the protocol", async () => {
    const { chat } = await openChat();
    await chat.send("ask then tool", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const request = chat.snapshot().pending[0];
    expect(request).toMatchObject({ kind: "select", options: ["Approve", "Deny"] });
    expect(chat.answer(request?.id as string, { kind: "select", value: "Approve" })).toBe("Chose “Approve”");
    await until(() => chat.status === "idle");
    expect(chat.snapshot().items.some((i) => i.kind === "tool")).toBe(true);
  });

  it("abort cancels pending dialogs and settles", async () => {
    const { chat } = await openChat();
    await chat.send("ask slow", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    await chat.abort();
    expect(chat.status).toBe("idle");
    expect(chat.snapshot().pending).toEqual([]);
  });

  it("lists sessions through omp acp and resumes the exact session", async () => {
    const { chat, live } = await openChat();
    await chat.send("remember this", "normal");
    await until(() => chat.status === "idle");
    const nativeId = live.nativeId as string;
    await live.dispose();
    const sessions = await adapter.listSessions(project);
    expect(sessions.map((s) => s.nativeId)).toEqual([nativeId]);
    const { chat: resumed } = await openChat(nativeId);
    expect(resumed.nativeId).toBe(nativeId);
    expect(resumed.snapshot().items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["remember this"]);
  });

  it("names untitled sessions by their first prompt, as omp's own picker does", async () => {
    const { chat, live } = await openChat();
    await chat.send("check why the dock does not show up", "normal");
    await until(() => chat.status === "idle");
    const nativeId = live.nativeId as string;
    await live.dispose();
    // omp never generated a title for these (the fixture now omits it, like omp does).
    const saved = JSON.parse(readFileSync(state, "utf8"));
    saved.sessions[nativeId].title = "";
    saved.sessions["01a0aaaa-0000-7000-8000-000000000000"] = { cwd: project, title: "", messages: [{ role: "user", content: "x" }] };
    writeFileSync(state, JSON.stringify(saved));
    // Only the first session has a file: <sessionDir>/<cwd dir>/<time>_<id>.jsonl.
    const dir = path.join(home, ".omp", "agent", "sessions", "-proj");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "title", v: 1, title: "" },
      { type: "session", version: 3, cwd: project },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "check why the dock\n  does not show up" }] } },
      { type: "message", message: { role: "assistant", content: [] } },
    ];
    writeFileSync(path.join(dir, `2026-10-01T19-34-02-238Z_${nativeId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
    const titles = Object.fromEntries((await adapter.listSessions(project)).map((s) => [s.nativeId, s.title]));
    expect(titles[nativeId]).toBe("check why the dock does not show up");
    expect(titles["01a0aaaa-0000-7000-8000-000000000000"]).toBe("Untitled");
  });

  it("finds a subagent's transcript beside its session, nested agents included", async () => {
    const saved = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { sessions: {}, spawns: [] };
    const parent = "01a0dddd-0000-7000-8000-000000000000";
    saved.sessions[parent] = { cwd: project, title: "delegating", messages: [{ role: "user", content: "x" }] };
    writeFileSync(state, JSON.stringify(saved));
    const dir = path.join(home, ".omp", "agent", "sessions", "-proj");
    const stem = path.join(dir, `2026-10-04T19-15-52-234Z_${parent}`);
    mkdirSync(path.join(stem, "CrookedThrush"), { recursive: true });
    writeFileSync(`${stem}.jsonl`, "");
    writeFileSync(path.join(stem, "CrookedThrush.jsonl"), "");
    writeFileSync(path.join(stem, "CrookedThrush", "CrookedThrush.GleamingTortoise.jsonl"), "");
    const run = (id: string) => ({ id, agent: "task", task: "", status: "done" as const });
    expect(await adapter.subagentTranscriptFile({ nativeId: parent, cwd: project }, run("CrookedThrush"))).toBe(path.join(stem, "CrookedThrush.jsonl"));
    expect(await adapter.subagentTranscriptFile({ nativeId: parent, cwd: project }, run("GleamingTortoise"))).toBe(path.join(stem, "CrookedThrush", "CrookedThrush.GleamingTortoise.jsonl"));
    expect(await adapter.subagentTranscriptFile({ nativeId: parent, cwd: project }, run("../escape"))).toBeNull();
    // A copy omp wrote of that session (parentSession) keeps the calls; the transcripts stay with the original.
    const copy = "01a0eeee-0000-7000-8000-000000000000";
    writeFileSync(path.join(dir, `2026-10-05T08-00-00-000Z_${copy}.jsonl`), `${JSON.stringify({ type: "session", id: copy, cwd: project, parentSession: parent })}\n`);
    mkdirSync(path.join(dir, `2026-10-05T08-00-00-000Z_${copy}`));
    expect(await adapter.subagentTranscriptFile({ nativeId: copy, cwd: project }, run("CrookedThrush"))).toBe(path.join(stem, "CrookedThrush.jsonl"));
    expect(await adapter.subagentTranscriptFile({ nativeId: copy, cwd: project }, run("NobodyAtAll"))).toBeNull();
  });

  it("orders sessions by their last message, not omp's exit records", async () => {
    // omp's session/list says every session changed just now (the fixture, like omp after a session_exit).
    const saved = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { sessions: {}, spawns: [] };
    const opened = "01a0bbbb-0000-7000-8000-000000000000";
    const talked = "01a0cccc-0000-7000-8000-000000000000";
    saved.sessions[opened] = { cwd: project, title: "opened, then closed", messages: [{ role: "user", content: "x" }] };
    saved.sessions[talked] = { cwd: project, title: "talked in", messages: [{ role: "user", content: "y" }] };
    writeFileSync(state, JSON.stringify(saved));
    const dir = path.join(home, ".omp", "agent", "sessions", "-proj");
    mkdirSync(dir, { recursive: true });
    const message = (at: string) => ({ type: "message", timestamp: at, message: { role: "user", content: "hi" } });
    const exit = (at: string) => ({ type: "custom", customType: "session_exit", data: { reason: "sigterm" }, timestamp: at });
    const write = (id: string, entries: object[]) => writeFileSync(path.join(dir, `2026-10-01T10-00-00-000Z_${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
    write(opened, [{ type: "session", cwd: project }, message("2026-10-01T10:00:00.000Z"), exit("2026-10-06T09:00:00.000Z")]);
    write(talked, [{ type: "session", cwd: project }, message("2026-10-02T10:00:00.000Z")]);
    const listed = (await adapter.listSessions(project)).filter((s) => s.nativeId === opened || s.nativeId === talked);
    expect(listed.map((s) => s.nativeId)).toEqual([talked, opened]);
    expect(listed[1]?.updatedAt?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });

  /** A saved session whose history no longer fits omp's 1 MiB v1 frame. */
  async function bigSession(): Promise<string> {
    const { chat, live } = await openChat();
    await chat.send("remember this", "normal");
    await until(() => chat.status === "idle");
    const nativeId = live.nativeId as string;
    await live.dispose();
    const saved = JSON.parse(readFileSync(state, "utf8"));
    saved.sessions[nativeId].messages.push({ role: "assistant", content: [{ type: "text", text: "x".repeat(3_000_000) }], stopReason: "stop", model: "m1" });
    writeFileSync(state, JSON.stringify(saved));
    return nativeId;
  }

  it("loads a history bigger than omp's 1 MiB frame, through protocol v2 chunks", async () => {
    const { chat } = await openChat(await bigSession());
    const long = chat.snapshot().items.find((i) => i.kind === "assistant" && i.text.length >= 3_000_000);
    expect(long).toBeDefined();
  });

  it("when a history cannot load, says why and leaves no omp process behind", async () => {
    const nativeId = await bigSession();
    await adapter.shutdown();
    expect(liveOmpChildren()).toBe(0);
    adapter = new OmpAdapter({ command: script, agentDir: null, sessionDir: null, home, env: { ...process.env, FAKE_OMP_STATE: state, FAKE_OMP_V1: "1" } });
    const ws: WorkspaceInfo = { id: "w", path: project, name: "proj" };
    // The session lister (omp acp) stays up by design; only the chat's own process must go.
    await adapter.listSessions(project);
    const lister = liveOmpChildren();
    await expect(new ChatManager().resume(adapter, ws, nativeId)).rejects.toMatchObject({
      code: "harness_load_failed",
      message: expect.stringContaining("exceeded the transport limit"),
    });
    expect(liveOmpChildren()).toBe(lister);
  });

  it("changes model and thinking in place, without restarting omp", async () => {
    const { chat } = await openChat();
    await chat.setConfig({ thinkingLevel: "high" });
    await chat.send("after config", "normal");
    await until(() => chat.status === "idle");
    expect(readState().spawns).toHaveLength(1);
  });

  it("reports omp context usage and flattens todo phases", async () => {
    const { chat } = await openChat();
    const snap = chat.snapshot();
    expect(snap.context).toEqual({
      tokens: 1200,
      window: 200000,
      percent: 0.6,
      // omp's own /context categories; free space is not usage.
      categories: [
        { id: "system-prompt", label: "System prompt", tokens: 1500 },
        { id: "system-tools", label: "System tools", tokens: 5200 },
        { id: "skills", label: "Skills", tokens: 300 },
        { id: "messages", label: "Messages", tokens: 527 },
      ],
    });
    // The probe ran locally: nothing reached the model or the session.
    expect(Object.values(readState().sessions).flatMap((s) => s.messages)).toEqual([]);
    expect(snap.todos).toEqual([
      { phase: "Plan", text: "Inspect", status: "completed" },
      { phase: "Plan", text: "Fix", status: "in_progress" },
    ]);
  });

  it("never sends /context unless omp lists it as a builtin", async () => {
    adapter = new OmpAdapter({
      command: script,
      agentDir: null,
      sessionDir: null,
      home,
      env: { ...process.env, FAKE_OMP_STATE: state, FAKE_OMP_CONTEXT: "extension" },
    });
    const { chat } = await openChat();
    expect(chat.snapshot().context).toEqual({ tokens: 1200, window: 200000, percent: 0.6 });
    expect(Object.values(readState().sessions).flatMap((s) => s.messages)).toEqual([]);
  });

  it("reports session tokens from omp and measures model timing from the stream", async () => {
    const { chat } = await openChat();
    await chat.send("hello", "normal");
    await until(() => chat.status === "idle" && (chat.snapshot().usage?.steps ?? 0) > 0);
    const usage = chat.snapshot().usage;
    expect(usage).toMatchObject({ turns: 1, steps: 1, input: 900, cachedInput: 300, cacheWrite: 0, output: 12, cost: 0.0042 });
    expect(usage?.llmMs).toBeGreaterThan(0);
    expect(usage?.ttftMs).not.toBeNull();
    expect(usage?.tokensPerSecond).toBeGreaterThan(0);
  });

  it("settles a typed builtin command and shows its output", async () => {
    const { chat } = await openChat();
    await chat.send("/context", "normal");
    await until(() => chat.status === "idle");
    const items = chat.snapshot().items;
    expect(items.find((i) => i.kind === "user")).toMatchObject({ text: "/context" });
    expect(items.find((i) => i.kind === "assistant")).toMatchObject({ text: expect.stringContaining("Context window: 200000 tokens") });
  });

  it("lists the commands omp runs over RPC, keeping rewind-to out of the composer's menu", async () => {
    const { chat, live } = await openChat();
    expect((await live.listCommands()).map((c) => [c.name, c.source])).toEqual([
      ["context", "builtin"],
      ["usage", "builtin"],
      ["rewind-to", "extension"],
    ]);
    expect((await chat.commands()).map((c) => c.name)).toEqual(["context", "usage"]);
  });

  it("splits provider/model keys at the first slash only", async () => {
    const { chat } = await openChat();
    await chat.setConfig({ model: "fakeomp/org/m2" });
    expect(readState().lastModel).toBe("fakeomp|org/m2");
  });

  it("reports a crashed child as a chat error", async () => {
    const { chat, live } = await openChat();
    const child = (live as unknown as { rpc: { proc: { child: { kill(s: string): void } } } }).rpc.proc.child;
    child.kill("SIGKILL");
    await until(() => chat.status === "error");
    expect(chat.snapshot().items.some((i) => i.kind === "notice" && i.level === "error" && /stopped unexpectedly/.test(i.text))).toBe(true);
  });
});

describe("lastMessageAt", () => {
  it("takes the newest message's time from a file's tail, skipping other entries and a cut-off line", () => {
    const jsonl = [
      'age":{"role":"user","content":"cut"},"timestamp":"2026-01-01T00:00:00.000Z"}',
      JSON.stringify({ type: "message", timestamp: "2026-10-04T19:10:48.008Z", message: { role: "assistant", content: [] } }),
      JSON.stringify({ type: "custom", customType: "session_exit", timestamp: "2026-10-06T09:06:24.801Z", data: { reason: "message" } }),
    ].join("\n");
    expect(lastMessageAt(jsonl)?.toISOString()).toBe("2026-10-04T19:10:48.008Z");
    expect(lastMessageAt(JSON.stringify({ type: "custom", timestamp: "2026-10-06T00:00:00Z" }))).toBeNull();
  });
});

describe("firstPrompt", () => {
  it("takes the first user message's text, on one line, and survives a cut-off read", () => {
    const jsonl = [
      JSON.stringify({ type: "title", title: "" }),
      JSON.stringify({ type: "message", message: { role: "system", content: "You are omp" } }),
      JSON.stringify({ type: "message", message: { role: "user", content: "  list the\nlast 5 commits " } }),
      '{"type":"message","message":{"role":"user","content":"cut of',
    ].join("\n");
    expect(firstPrompt(jsonl)).toBe("list the last 5 commits");
    expect(firstPrompt(JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "image" }] } }))).toBeNull();
    expect(firstPrompt(JSON.stringify({ type: "message", message: { role: "user", content: "y".repeat(200) } }))).toHaveLength(80);
  });

  it("finds native provider choice ids without exposing stored account identities", async () => {
    await adapter.listModels(project);
    const accounts = await adapter.accounts(project);
    expect(accounts.map((row) => row.id)).toEqual(["fakeomp:1", "fakeomp:2"]);
  });

  it("pins the current child with its native account-index command", async () => {
    const { live } = await openChat();
    if (!live.pinAccount) throw new Error("Omp session must support native pinning");
    await live.pinAccount(2);
    await until(() => readState().pinned === "2");
  });

  it("old prompt from example knows /session pin only in this current session", async () => {
    const { live } = await openChat();
    if (!live.pinAccount) throw new Error("This live harness must declare its own pin implementation");
    await live.pinAccount(1);
    expect(readState().pinned).toBe("1");
  });

  it("asks omp's session lease whether another omp holds a session, and says no when it cannot tell", async () => {
    const held = new OmpAdapter({ command: script, agentDir: null, sessionDir: null, home, env: { ...process.env, FAKE_OMP_STATE: state, FAKE_OMP_HELD: "01a1c595-held" } });
    expect(await held.heldElsewhere("01a1c595-held")).toBe(true);
    expect(await held.heldElsewhere("01a1c595-free")).toBe(false);
    const missing = new OmpAdapter({ command: path.join(home, "no-such-omp"), agentDir: null, sessionDir: null, home, env: process.env });
    expect(await missing.heldElsewhere("01a1c595-held")).toBe(false);
    // Recorded from omp 18.18.6: held while an omp runs it, empty once it exits.
    expect(heldSessions('{"held":["01a1c595-bded-7294-9358-d6ac8bd845ea"],"unknown":[]}')).toEqual(["01a1c595-bded-7294-9358-d6ac8bd845ea"]);
    expect(heldSessions('{"held":[],"unknown":[]}')).toEqual([]);
    expect(heldSessions("Unknown action: lease")).toEqual([]);
    await held.shutdown();
    await missing.shutdown();
  });
});
