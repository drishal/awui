import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { OpenCodeAdapter } from "../../src/server/harness/opencode.js";
import { liveOpenCodeServers } from "../../src/server/harness/opencode-server.js";
import { formQuestions, formValue, permissionCard, permissionReply, toModelInfo, transcriptOf, usageOf } from "../../src/server/harness/opencode-messages.js";
import { historyToItems } from "../../src/server/harness/agent-events.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-opencode.mjs");
chmodSync(script, 0o755);

let home: string;
let project: string;
let state: string;
let adapter: OpenCodeAdapter;
const open: LiveChat[] = [];
/** Adapters a test made for its own environment (a refused registration, a config dir to leave alone). */
const extras: OpenCodeAdapter[] = [];

beforeEach(() => {
  home = tempDir("awui-opencode-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new OpenCodeAdapter({ command: script, env: { ...process.env, FAKE_OPENCODE_STATE: state } });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  for (const extra of extras.splice(0)) await extra.shutdown();
  await adapter.shutdown();
  expect(liveOpenCodeServers()).toBe(0);
});

const ws = (): WorkspaceInfo => ({ id: "w", path: project, name: "proj" });

async function openChat(resumeNativeId?: string, toolEnv?: NodeJS.ProcessEnv) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}), ...(toolEnv ? { toolEnv } : {}) });
  open.push(live);
  return { live, chat: await Chat.open(`c${open.length}`, adapter, ws(), live) };
}

async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const replies = (): Array<Record<string, unknown>> => {
  try {
    return (JSON.parse(readFileSync(state, "utf8")) as { replies: Array<Record<string, unknown>> }).replies;
  } catch {
    return [];
  }
};
const answered = (chat: Chat, text: string) => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes(text));
const prompts = (chat: Chat) => chat.snapshot().items.flatMap((i) => (i.kind === "user" ? [i.text] : []));

describe("opencode adapter (scripted server)", () => {
  it("finds OpenCode 2, and lists its models with their variants as levels, never their settings", async () => {
    expect(await adapter.discover()).toMatchObject({ available: true, version: "2.0.27" });
    const models = await adapter.listModels(project);
    expect(models).toEqual([
      { key: "opencode/fast-free", provider: "opencode", id: "fast-free", name: "Fast Free", reasoning: true, levels: ["low", "high"], vision: true },
      { key: "acme/plain", provider: "acme", id: "plain", name: "Plain", vision: false },
    ]);
    expect(JSON.stringify(models)).not.toContain("sk-fake");
  });

  it("names the server's default model for a new session", async () => {
    expect(await adapter.defaultModel(project)).toEqual({ model: "opencode/fast-free", thinkingLevel: null });
  });

  it("makes the session on the first message, then streams a turn with thinking and usage", async () => {
    const { chat, live } = await openChat();
    expect(live.nativeId).toBeNull();
    expect(chat.snapshot().config).toMatchObject({ model: "opencode/fast-free", thinkingLevel: null, thinkingLevels: ["low", "high"] });
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo: hello there"));
    expect(live.nativeId).toMatch(/^ses_/);
    const snap = chat.snapshot();
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(snap.items[1]).toMatchObject({ text: "Echo: hello there", thinking: "thinking about it", streaming: false });
    expect(await live.getUsage()).toMatchObject({ turns: 1, steps: 1, input: 100, cachedInput: 1000, output: 25, cost: 0.002 });
    expect(await live.getContextUsage()).toEqual({ tokens: 1125, window: 100000, percent: 1.125 });
    // OpenCode titled it from the prompt.
    expect(snap.title).toBe("hello there");
  });

  it("takes a short reply that arrives whole, with no deltas", async () => {
    const { chat } = await openChat();
    await chat.send("short one", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo: short one"));
  });

  it("folds a read and an edit under the turn, the edit as its diff", async () => {
    const { chat } = await openChat();
    await chat.send("tool and edit", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo: tool and edit"));
    const tools = chat.snapshot().items.filter((i) => i.kind === "tool");
    expect(tools.map((t) => (t.kind === "tool" ? [t.name, t.category, t.status] : []))).toEqual([
      ["read", "read", "done"],
      ["edit", "edit", "done"],
    ]);
    expect(tools[1]).toMatchObject({ diffStat: { added: 1, removed: 1 }, paths: ["note.txt"] });
  });

  it("asks for permission, and answers OpenCode once or not at all", async () => {
    const { chat } = await openChat();
    await chat.send("ask first", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    expect(chat.snapshot().pending[0]).toMatchObject({ title: "Allow shell?", message: "echo hi", options: ["Allow once", "Always allow (echo *)", "Deny"] });
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle" && answered(chat, "Echo: ask first"));
    expect(chat.snapshot().items.find((i) => i.kind === "tool")).toMatchObject({ name: "shell", category: "command", status: "done", output: "hi\n" });
    await chat.send("ask again", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Deny" });
    await until(() => chat.status === "idle" && answered(chat, "Echo: ask again"));
    expect(replies().filter((r) => r.kind === "permission")).toEqual([
      { kind: "permission", decision: "once", message: null },
      { kind: "permission", decision: "reject", message: "Denied in awui" },
    ]);
    expect(chat.snapshot().items.filter((i) => i.kind === "tool")[1]).toMatchObject({ status: "error" });
  });

  it("asks a form's question as a card and sends the option's value back", async () => {
    const { chat } = await openChat();
    await chat.send("question please", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    expect(chat.snapshot().pending[0]).toMatchObject({ kind: "select", title: "Indentation", message: "Tabs or spaces?", options: ["Tabs", "Spaces"], optionDetails: ["Indent with tabs", "Indent with spaces"] });
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Spaces" });
    await until(() => chat.status === "idle" && answered(chat, "You chose Spaces"));
    expect(replies().filter((r) => r.kind === "form")).toEqual([{ kind: "form", answer: { q0: "Spaces" } }]);
  });

  it("steers into the running turn and queues follow-ups for after it", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.send("also this", "steer");
    await chat.send("and then that", "followUp");
    await until(() => chat.snapshot().queue.steering.length + chat.snapshot().queue.followUp.length === 2);
    expect(chat.snapshot().queue).toEqual({ steering: ["also this"], followUp: ["and then that"] });
    await until(() => chat.status === "idle" && answered(chat, "Echo: and then that"), 15_000);
    expect(prompts(chat)).toEqual(["slow please", "also this", "and then that"]);
    expect(answered(chat, "Steered: also this")).toBe(true);
    expect(chat.snapshot().queue).toEqual({ steering: [], followUp: [] });
  });

  it("stops a run, dropping what was queued behind it", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.send("never run", "followUp");
    await chat.abort();
    await until(() => chat.status === "idle");
    expect(prompts(chat)).toEqual(["slow please"]);
    const answer = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(answer && answer.kind === "assistant" && answer.text.split(" ").length).toBeLessThan(31);
  });

  it("reports a failed step as an error and still settles", async () => {
    const { chat } = await openChat();
    await chat.send("fail now", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "notice" || (i.kind === "assistant" && i.error)));
    expect(JSON.stringify(chat.snapshot().items)).toContain("The provider refused the request");
  });

  it("follows a subagent's child session live, and opens its transcript from the run", async () => {
    const { chat, live } = await openChat();
    await chat.send("delegate this", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo: delegate this"));
    const tool = chat.snapshot().items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ name: "subagent", category: "agent", status: "done", output: "Found README.md, a fake project." });
    const run = tool && tool.kind === "tool" ? tool.subagents?.runs[0] : undefined;
    expect(run).toMatchObject({ agent: "explorer", status: "done", model: "opencode-go/mini", toolCount: 1, tokens: 540, cost: 0.003, transcript: true, output: "Found README.md, a fake project." });
    expect(run?.id).toMatch(/^ses_/);
    expect(run?.task).toBe("List the files and read README.md");
    const transcript = await chat.subagentTranscript(tool?.id as string, run?.id as string);
    expect(transcript.items.map((i) => (i.kind === "tool" ? `tool:${i.name}` : i.kind))).toEqual(["user", "tool:read", "assistant"]);
    // The child is no session of the project's own.
    expect((await adapter.listSessions(project)).map((s) => s.nativeId)).toEqual([live.nativeId]);
    // Reopened, the run keeps its child: its model, its answer, and its transcript.
    const items = await live.history();
    const again = items.find((i) => i.kind === "tool");
    expect(again && again.kind === "tool" ? again.subagents?.runs[0] : null).toMatchObject({ id: run?.id, agent: "explorer", status: "done", model: "opencode-go/mini", cost: 0.003, transcript: true });
    // Another chat's run is not this chat's to read.
    await expect(adapter.subagentTranscript({ nativeId: "ses_other", cwd: project }, run as never)).resolves.toBeNull();
  });

  it("keeps OpenCode's todo list as the chat's todos", async () => {
    const { chat, live } = await openChat();
    await chat.send("todo list", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo: todo list"));
    expect(await live.getTodos()).toEqual([
      { text: "write tests", status: "in_progress" },
      { text: "ship", status: "pending" },
    ]);
  });

  it("changes model and level for this session, before and after it exists", async () => {
    const { chat, live } = await openChat();
    await chat.setConfig({ thinkingLevel: "high" });
    expect(chat.snapshot().config).toMatchObject({ model: "opencode/fast-free", thinkingLevel: "high" });
    await chat.send("hello", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo: hello"));
    await chat.setConfig({ model: "acme/plain" });
    expect(chat.snapshot().config).toMatchObject({ model: "acme/plain", thinkingLevel: null });
    const info = await adapter.sessionInfo(live.nativeId as string);
    expect(info?.model).toEqual({ providerID: "acme", id: "plain", variant: "default" });
    expect((await live.listCommands())[0]).toEqual({ name: "review", description: "review changes", source: "command" });
  });

  it("renames, lists, resumes, replaces a past prompt in place, and forks before one", async () => {
    const { chat, live } = await openChat();
    await chat.send("first prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo: first prompt"));
    await chat.send("second tool prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo: second tool prompt"));
    await chat.rename("Named session");
    const nativeId = live.nativeId as string;
    expect((await adapter.listSessions(project)).map((s) => [s.nativeId, s.title])).toEqual([[nativeId, "Named session"]]);
    expect((await adapter.listSessions(home)).length).toBe(0);
    expect((await adapter.listRecentSessions(10)).map((s) => s.cwd)).toEqual([project]);
    expect(await adapter.readTranscript({ cwd: home, nativeId })).toBeNull();
    expect((await adapter.readTranscript({ cwd: project, nativeId }))?.items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant", "tool", "assistant"]);
    expect((await adapter.readUsage({ cwd: project, nativeId }))?.length).toBe(3);

    await chat.rewind(2, "second, said again");
    await until(() => chat.status === "idle" && answered(chat, "Echo: second, said again"));
    expect(prompts(chat)).toEqual(["first prompt", "second, said again"]);
    expect((await live.history()).flatMap((i) => (i.kind === "user" ? [i.text] : []))).toEqual(["first prompt", "second, said again"]);
    await chat.dispose("done");

    const { chat: resumed, live: again } = await openChat(nativeId);
    expect(again.title).toBe("Named session");
    expect(resumed.snapshot().items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant"]);

    const fork = await adapter.forkSession({ cwd: project, nativeId, throughTurns: 1 });
    const { chat: copy } = await openChat(fork.nativeId);
    expect(copy.snapshot().items.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual(["first prompt", "Echo: first prompt"]);
  });

  it("compacts and waits for OpenCode to finish", async () => {
    const { chat } = await openChat();
    await chat.send("first prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Echo"));
    await chat.compact();
    expect(chat.status).toBe("idle");
    expect(chat.snapshot().items.some((i) => i.kind === "notice" && i.text === "Compacted conversation")).toBe(true);
    expect((await open[0]?.history())?.map((i) => i.kind)).toEqual(["user", "assistant", "notice"]);
  });

  it("refuses a session that is not this project's", async () => {
    await expect(adapter.openChat({ cwd: project, resumeNativeId: "ses_doesnotexist" })).rejects.toThrow(/not found/);
  });
});

describe("OpenCode's shapes", () => {
  it("reads stored messages as history: thinking, text, calls with their results, an interrupted step, a compaction", () => {
    const messages = [
      { id: "u1", type: "user", time: { created: 1 }, text: "Read README.md" },
      {
        id: "a1",
        type: "assistant",
        time: { created: 2 },
        model: { providerID: "opencode", id: "m" },
        content: [
          { type: "reasoning", text: "read it" },
          { type: "tool", id: "c1", name: "read", state: { status: "completed", input: { path: "README.md" }, content: [{ type: "text", text: "1: # Probe" }] }, time: { completed: 3 } },
          { type: "tool", id: "c2", name: "shell", state: { status: "error", input: { command: "false" }, error: { message: "Denied" } } },
        ],
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } },
        cost: 0,
      },
      { id: "a2", type: "assistant", time: { created: 4 }, content: [{ type: "text", text: "partial" }], error: { type: "aborted", message: "Step interrupted" } },
      { id: "i1", type: "idle", time: { created: 5 }, outcome: "interrupted" },
      { id: "k1", type: "compaction", time: { created: 6 }, status: "completed", summary: "## Objective" },
    ];
    const items = historyToItems(transcriptOf(messages));
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "assistant", "notice"]);
    expect(items[1]).toMatchObject({ thinking: "read it", model: "opencode/m" });
    expect(items[2]).toMatchObject({ name: "read", status: "done", output: "1: # Probe" });
    expect(items[3]).toMatchObject({ name: "shell", status: "error", output: "Denied" });
    expect(items[4]).toMatchObject({ text: "partial", error: "Stopped" });
    expect(usageOf(messages)).toEqual([{ at: 2, model: "opencode/m", input: 10, cachedInput: 5, cacheWrite: 0, output: 3, cost: 0 }]);
  });

  it("reads a model without passing its settings on", () => {
    const info = toModelInfo({ id: "x", providerID: "p", name: "X", variants: [{ id: "none" }, { id: "default" }, { id: "max" }], settings: { apiKey: "secret" } });
    expect(info).toEqual({ key: "p/x", provider: "p", id: "x", name: "X", reasoning: true, levels: ["max"] });
    expect(toModelInfo({ id: "x", providerID: "p", enabled: false })).toBeNull();
  });

  it("asks a permission with its saved pattern, and maps each card's answer", () => {
    const card = permissionCard({ id: "per_1", action: "shell", resources: ["rm -rf build"], save: ["rm *"] }, 7);
    expect(card).toEqual({ id: "per_1", kind: "select", title: "Allow shell?", message: "rm -rf build", options: ["Allow once", "Always allow (rm *)", "Deny"], createdAt: 7 });
    expect([permissionReply("Allow once"), permissionReply("Always allow (rm *)"), permissionReply("Deny"), permissionReply(null)]).toEqual(["once", "always", "reject", "reject"]);
  });

  it("asks each form field in its own way and answers in its type", () => {
    const form = {
      id: "frm_1",
      title: "Questions",
      fields: [
        { key: "pick", title: "Pick", type: "multiselect", options: [{ value: "a", label: "Alpha" }] },
        { key: "ok", title: "OK?", type: "boolean" },
        { key: "n", title: "How many", type: "integer" },
        { key: "why", type: "string" },
      ],
    };
    const qs = formQuestions(form, 1);
    expect(qs.map((q) => [q.key, q.request.kind, q.shape])).toEqual([
      ["pick", "select", "list"],
      ["ok", "confirm", "boolean"],
      ["n", "input", "number"],
      ["why", "input", "text"],
    ]);
    expect(qs[3]?.request.title).toBe("Questions");
    expect([formValue(qs[0]!, form, "Alpha"), formValue(qs[1]!, form, true), formValue(qs[2]!, form, "3"), formValue(qs[3]!, form, "because")]).toEqual([["a"], true, 3, "because"]);
  });
});

/** The tokens ChatManager mints per chat, one pair per chat number. */
function tokens(n: number): NodeJS.ProcessEnv {
  return {
    AWUI_RENDER_URL: "http://127.0.0.1:4783/api/render",
    AWUI_RENDER_TOKEN: `${n}`.padStart(32, "a"),
    AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration",
    AWUI_ORCH_TOKEN: `${n}`.padStart(32, "b"),
  };
}

interface FakeState {
  sessions: Record<string, { permissions?: Array<{ action: string; resource: string; effect: string }> }>;
  pid?: number;
  mcpAdds?: Array<{ directory: string; server: string; config: { type: string; command: string[]; environment: Record<string, string>; codemode?: boolean } }>;
  mcpRemoves?: Array<{ directory: string; server: string }>;
}

const fakeState = (): FakeState => JSON.parse(readFileSync(state, "utf8")) as FakeState;
const adds = () => fakeState().mcpAdds ?? [];

/** One chat's tools a test calls by name, from what the fake server was given. */
const toolsOf = (chatNumber: number) => {
  const mine = [tokens(chatNumber).AWUI_RENDER_TOKEN, tokens(chatNumber).AWUI_ORCH_TOKEN];
  return adds().filter((add) => Object.values(add.config.environment).some((value) => mine.includes(value)));
};

describe("awui's tools in an OpenCode chat", () => {
  it("registers its two servers for the chat, wired to awui's bridges, and scopes the session", async () => {
    const { chat, live } = await openChat(undefined, tokens(1));
    await chat.send("hello", "normal");
    await until(() => adds().length === 2 && (fakeState().sessions[live.nativeId as string]?.permissions?.length ?? 0) === 3);
    const [render, orchestrate] = toolsOf(1);
    // One server per family, named for this chat and carrying no token in its name.
    expect(render?.server).toMatch(/^awui-r-[0-9a-f]{16}$/);
    expect(orchestrate?.server).toMatch(/^awui-o-[0-9a-f]{16}$/);
    expect(render?.server).not.toContain(tokens(1).AWUI_RENDER_TOKEN as string);
    expect(render?.directory).toBe(project);
    expect(render?.config).toMatchObject({ type: "local", codemode: false });
    expect(render?.config.command[1]).toMatch(/render-html-mcp\.mjs$/);
    expect(render?.config.environment).toEqual({ AWUI_RENDER_URL: tokens(1).AWUI_RENDER_URL, AWUI_RENDER_TOKEN: tokens(1).AWUI_RENDER_TOKEN });
    expect(orchestrate?.config.command[1]).toMatch(/orchestrate-mcp\.mjs$/);
    expect(orchestrate?.config.environment).toEqual({ AWUI_ORCH_URL: tokens(1).AWUI_ORCH_URL, AWUI_ORCH_TOKEN: tokens(1).AWUI_ORCH_TOKEN });
    // The session's own rules deny every awui server, then allow this chat's two.
    const session = fakeState().sessions[live.nativeId as string];
    expect(session?.permissions).toEqual([
      { action: "awui-*", resource: "*", effect: "deny" },
      { action: `${render?.server}_*`, resource: "*", effect: "allow" },
      { action: `${orchestrate?.server}_*`, resource: "*", effect: "allow" },
    ]);
  });

  it("keeps the user's own OpenCode config untouched: the servers exist only over the API", async () => {
    const configDir = path.join(home, "xdg", "opencode");
    const own = new OpenCodeAdapter({ command: script, env: { ...process.env, FAKE_OPENCODE_STATE: state, XDG_CONFIG_HOME: path.join(home, "xdg") } });
    extras.push(own);
    const live = await own.openChat({ cwd: project, toolEnv: tokens(2) });
    open.push(live);
    const chat = await Chat.open("cfg", own, ws(), live);
    await chat.send("hello", "normal");
    await until(() => adds().length === 2);
    expect(existsSync(configDir)).toBe(false);
  });

  it("lets two chats in one project share the server but not the tools", async () => {
    const { chat: first } = await openChat(undefined, tokens(1));
    const { chat: second } = await openChat(undefined, tokens(3));
    await first.send("hello", "normal");
    await second.send("hello", "normal");
    await until(() => adds().length === 4 && [first, second].every((c) => c.status === "idle"));
    const ours = toolsOf(1)[0]?.server as string;
    const theirs = toolsOf(3)[0]?.server as string;
    expect(ours).not.toBe(theirs);
    // This chat calls its own render tool: the session's allow rule runs it without a prompt.
    await first.send(`mcpcall ${ours}_render_html`, "normal");
    await until(() => first.status === "idle" && first.snapshot().items.some((i) => i.kind === "tool"));
    expect(first.snapshot().items.find((i) => i.kind === "tool")).toMatchObject({ name: `${ours}_render_html`, status: "done" });
    // The chat next door calls it instead: the deny rule refuses, and no card is raised.
    await second.send(`mcpcall ${ours}_render_html`, "normal");
    await until(() => second.status === "idle" && second.snapshot().items.some((i) => i.kind === "tool"));
    expect(second.snapshot().items.find((i) => i.kind === "tool")).toMatchObject({ name: `${ours}_render_html`, status: "error", output: "Denied" });
    expect(second.snapshot().pending).toEqual([]);
  });

  it("takes its servers off the shared one when the chat closes", async () => {
    const { live } = await openChat(undefined, tokens(1));
    const chat = await Chat.open("close", adapter, ws(), live);
    await chat.send("hello", "normal");
    await until(() => adds().length === 2);
    await live.dispose();
    expect(fakeState().mcpRemoves?.map((r) => r.server).sort()).toEqual(adds().map((a) => a.server).sort());
  });

  it("keeps the chat working when the server refuses the tools, and says so once", async () => {
    const refusing = new OpenCodeAdapter({ command: script, env: { ...process.env, FAKE_OPENCODE_STATE: state, FAKE_OPENCODE_MCP_FAIL: "1" } });
    extras.push(refusing);
    const live = await refusing.openChat({ cwd: project, toolEnv: tokens(1) });
    open.push(live);
    const chat = await Chat.open("refused", refusing, ws(), live);
    const said: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void said.push(String(line)));
    try {
      await chat.send("hello", "normal");
      await until(() => chat.status === "idle" && answered(chat, "Echo: hello"));
      await chat.send("hello again", "normal");
      await until(() => answered(chat, "Echo: hello again"));
    } finally {
      spy.mockRestore();
    }
    // The turn ran; the tools did not, and the reason (never a token) was said once.
    expect(said.filter((line) => line.includes("awui's tools"))).toHaveLength(1);
    expect(said.join("\n")).not.toContain(tokens(1).AWUI_RENDER_TOKEN as string);
  });

  it("registers again before a turn when the shared server has restarted", async () => {
    const { chat } = await openChat(undefined, tokens(1));
    await chat.send("hello", "normal");
    await until(() => adds().length === 2);
    const pid = fakeState().pid as number;
    process.kill(pid, "SIGTERM");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    // The restarted server has no runtime set: the next turn puts the servers back.
    await chat.send("hello again", "normal");
    await until(() => adds().length === 4);
    await until(() => answered(chat, "Echo: hello again"));
    expect(new Set(adds().map((a) => a.server)).size).toBe(2);
  });

  it("publishes a page from an awui render call, live and from the session's stored messages", async () => {
    expect(adapter.capabilities.supportsHtmlRender).toBe(true);
    const { chat, live } = await openChat(undefined, tokens(1));
    await chat.send("hello", "normal");
    await until(() => adds().length === 2 && chat.status === "idle");
    await chat.send("render one", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "tool" && i.htmlRender !== undefined));
    const page = { id: "0123456789abcdef0123456789abcdef", title: "Probe page", height: 240 };
    const shown = chat.snapshot().items.find((i) => i.kind === "tool");
    expect(shown).toMatchObject({ htmlRender: page });
    // The marker line is not part of the card's text.
    expect(shown?.kind === "tool" ? shown.output : "").not.toContain("awui-html-render:");
    // Reloaded from the session's messages, the page is still there.
    const items = await adapter.readTranscript({ cwd: project, nativeId: live.nativeId as string });
    expect(items?.items.find((i) => i.kind === "tool")).toMatchObject({ htmlRender: page });
  });
});
