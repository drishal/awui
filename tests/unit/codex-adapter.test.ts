import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { CodexAdapter, liveCodexChildren } from "../../src/server/harness/codex.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-codex.mjs");
chmodSync(script, 0o755);

let home: string;
/** The agent dir: what CODEX_HOME points at, never the developer's ~/.codex. */
let codexHome: string;
let project: string;
let state: string;
let adapter: CodexAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-codex-home-");
  codexHome = path.join(home, ".codex");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new CodexAdapter({ command: script, home, env: { ...process.env, CODEX_HOME: codexHome, FAKE_CODEX_HOME: codexHome, FAKE_CODEX_STATE: state } });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveCodexChildren()).toBe(0);
});

const ws = (): WorkspaceInfo => ({ id: "w", path: project, name: "proj" });

async function openChat(resumeNativeId?: string) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}) });
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

const recorded = (key: string): unknown[] => {
  try {
    return (JSON.parse(readFileSync(state, "utf8")) as Record<string, unknown[]>)[key] ?? [];
  } catch {
    return [];
  }
};

const calls = (method: string) => (recorded("calls") as Array<{ method: string; params: Record<string, unknown> }>).filter((c) => c.method === method);
const answered = (chat: Chat, text: string) => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes(text));
const toolItem = (chat: Chat) => {
  const item = chat.snapshot().items.find((i) => i.kind === "tool");
  if (!item || item.kind !== "tool") throw new Error("no tool item");
  return item;
};

describe("the codex adapter (scripted app-server)", () => {
  it("discovers the installed CLI, and reports a missing one with the reason to install it", async () => {
    const discovery = await adapter.discover();
    expect(discovery).toMatchObject({ available: true, version: "0.167.0", warnings: [], overrides: { CODEX_HOME: "set" } });
    const missing = new CodexAdapter({ command: path.join(home, "no-such-codex"), home, env: { ...process.env, CODEX_HOME: codexHome } });
    try {
      expect(await missing.discover()).toMatchObject({
        available: false,
        reason: "The codex CLI is not installed. Install Codex, run `codex login`, and try again.",
        warnings: [],
        overrides: { CODEX_HOME: "set" },
      });
    } finally {
      await missing.shutdown();
    }
  });

  it("starts a thread in auto mode, with the models and effort levels Codex lists", async () => {
    const { chat, live } = await openChat();
    expect(live.nativeId).toMatch(/^[0-9a-f-]{36}$/);
    const config = chat.snapshot().config;
    expect(config).toMatchObject({ model: "fake-1", thinkingLevel: "medium", permissionMode: "auto" });
    expect(config.models.map((m) => [m.key, m.provider, m.name, m.levels, m.vision])).toEqual([
      ["fake-1", "openai", "Fake One", ["low", "medium", "high"], true],
      ["fake-max", "openai", "Fake Max", ["low"], undefined],
    ]);
    expect(config.thinkingLevels).toEqual(["low", "medium", "high"]);
    expect(config.permissionModes?.map((m) => m.id)).toEqual(["read-only", "auto", "full-access"]);
    // The sandbox and approval policy went out with the thread, as awui's mode.
    expect(calls("thread/start")[0]?.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write", cwd: project });
  });

  it("starts on a model the account can run when the config names one it cannot", async () => {
    // As a free ChatGPT account with a paid model in config.toml: Codex fails every turn with modelNotFound.
    const paid = new CodexAdapter({ command: script, home, env: { ...process.env, CODEX_HOME: codexHome, FAKE_CODEX_HOME: codexHome, FAKE_CODEX_STATE: state, FAKE_CODEX_CONFIG_MODEL: "ghost-model" } });
    try {
      const live = await paid.openChat({ cwd: project });
      open.push(live);
      const chat = await Chat.open("paid", paid, ws(), live);
      expect(chat.snapshot().config.model).toBe("fake-1");
      expect(calls("thread/start")[0]?.params).toMatchObject({ model: "fake-1" });
      expect(await paid.defaultModel(project)).toEqual({ model: "fake-1", thinkingLevel: "medium" });
      await chat.send("hello there", "normal");
      await until(() => chat.status === "idle" && answered(chat, "Fake reply: hello there"));
    } finally {
      await paid.shutdown();
    }
  });

  it("streams a turn and counts its tokens and the window it filled", async () => {
    const { chat, live } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Fake reply: hello there"));
    const snap = chat.snapshot();
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(snap.items[1]).toMatchObject({ text: "Fake reply: hello there", streaming: false });
    expect(await live.getUsage()).toMatchObject({ turns: 1, steps: 1, input: 1000, cachedInput: 1000, cacheWrite: 0, output: 400, cost: null });
    expect(await live.getContextUsage()).toEqual({ tokens: 1200, window: 200000, percent: 0.6 });
  });

  it("shows a shell call with its category, summary, output, and exit code", async () => {
    const { chat } = await openChat();
    await chat.send("use the tool", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Listed the folder."));
    expect(toolItem(chat)).toMatchObject({ name: "shell", category: "command", summary: "ls", output: "fake output\n", status: "done", exitCode: 0 });
  });

  it("turns Codex's command approval into a card and sends the decision back", async () => {
    const { chat } = await openChat();
    await chat.send("ask to run it", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const card = chat.snapshot().pending[0];
    expect(card).toMatchObject({ kind: "select", title: "Run this command?", options: ["Allow once", "Allow for this session", "Deny"] });
    expect(card?.message).toContain("rm -rf build");
    chat.answer(card?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    expect(recorded("decisions")).toEqual([{ itemId: expect.stringMatching(/^exec-/), decision: "accept" }]);
    expect(toolItem(chat)).toMatchObject({ status: "done", output: "fake output\n" });
  });

  it("sends a denial as cancel, and the call shows as failed", async () => {
    const { chat } = await openChat();
    await chat.send("ask to run it", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Deny" });
    await until(() => chat.status === "idle" && toolItem(chat).status === "error");
    expect(recorded("decisions")).toEqual([{ itemId: expect.stringMatching(/^exec-/), decision: "cancel" }]);
    expect(chat.snapshot().pending).toEqual([]);
  });

  it("turns Codex's file change into the diff the chat folds, one hunk per file", async () => {
    const { chat } = await openChat();
    await chat.send("diff the file", "normal");
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    const tool = toolItem(chat);
    expect(tool).toMatchObject({ name: "apply_patch", category: "edit", diffStat: { added: 2, removed: 1 } });
    const lines = tool.diff?.lines ?? [];
    expect(lines.some((line) => line.kind === "del" && line.text === "old")).toBe(true);
    expect(lines.some((line) => line.kind === "add" && line.text === "new")).toBe(true);
    expect(lines.some((line) => line.kind === "add" && line.text === "fresh")).toBe(true);
    expect(lines.some((line) => line.kind === "hunk" && line.text.endsWith("b.txt"))).toBe(true);
  });

  it("asks Codex's question as a card and answers it by question id", async () => {
    const { chat } = await openChat();
    await chat.send("question please", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const card = chat.snapshot().pending[0];
    expect(card).toMatchObject({ kind: "select", title: "Color", message: "Which color?", options: ["Blue", "Green"], optionDetails: ["Calm", "Fresh"] });
    chat.answer(card?.id as string, { kind: "select", value: "Blue" });
    await until(() => chat.status === "idle" && answered(chat, "Got the answer."));
    expect(recorded("answers")).toEqual([{ q1: { answers: ["Blue"] } }]);
  });

  it("streams a thought before the answer, and an empty thought never makes an empty row", async () => {
    const { chat } = await openChat();
    await chat.send("think about it", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Fake reply: think about it"));
    const assistants = chat.snapshot().items.filter((i) => i.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({ text: "", thinking: "Checking the workspace." });
    expect(assistants.every((i) => i.kind === "assistant" && (i.text || i.thinking))).toBe(true);
  });

  it("steers into the active turn with its id as the precondition", async () => {
    const { chat } = await openChat();
    await chat.send("slow reply please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.send("make it shorter", "steer");
    await until(() => recorded("steers").length === 1);
    const steer = recorded("steers")[0] as { turnId: string; text: string };
    expect(steer.text).toBe("make it shorter");
    expect(steer.turnId).toMatch(/^[0-9a-f-]{36}$/);
    const turnStarted = chat.snapshot().items.find((i) => i.kind === "user" && i.text === "slow reply please");
    expect(turnStarted).toBeDefined();
    await until(() => chat.status === "idle");
    expect(chat.snapshot().items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text)).toEqual(["slow reply please", "make it shorter"]);
  });

  it("queues a follow-up in Codex's own queue and runs it as the next turn", async () => {
    const { chat } = await openChat();
    await chat.send("slow reply please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.send("queued please", "followUp");
    await until(() => chat.snapshot().queue.followUp.length === 1);
    expect(chat.snapshot().queue.followUp).toEqual(["queued please"]);
    await until(() => chat.status === "idle" && answered(chat, "Fake reply: queued please"), 12000);
    expect(recorded("prompts")).toEqual(["slow reply please", "queued please"]);
    expect(chat.snapshot().queue.followUp).toEqual([]);
  });

  it("replaces the queue by deleting Codex's submissions and adding the new ones", async () => {
    const { chat } = await openChat();
    await chat.send("slow reply please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.send("first queued", "followUp");
    await until(() => chat.snapshot().queue.followUp.length === 1);
    await chat.replaceQueue({ steering: [], followUp: ["replacement"] });
    await until(() => calls("thread/queue/delete").length === 1 && calls("thread/queue/add").length === 2);
    expect(chat.snapshot().queue.followUp).toEqual(["replacement"]);
    await chat.abort();
  });

  it("stops a slow run with turn/interrupt", async () => {
    const { chat } = await openChat();
    await chat.send("slow reply please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.abort();
    await until(() => chat.status === "idle");
    expect(calls("turn/interrupt")).toHaveLength(1);
    expect(chat.snapshot().items.some((i) => i.kind === "notice" && i.text === "Run stopped")).toBe(true);
  });

  it("reports a turn Codex failed, and still settles", async () => {
    const { chat } = await openChat();
    await chat.send("fail now", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "notice"));
    expect(chat.snapshot().items.find((i) => i.kind === "notice")).toMatchObject({ level: "error", text: "the fake model refused" });
    expect(recorded("prompts")).toEqual(["fail now"]);
  });

  it("changes model, effort, and permission mode through the thread's settings", async () => {
    const { chat } = await openChat();
    await chat.setConfig({ model: "fake-max" });
    expect(chat.snapshot().config.model).toBe("fake-max");
    await chat.setConfig({ thinkingLevel: "low" });
    expect(chat.snapshot().config.thinkingLevel).toBe("low");
    // A level the model does not list never reaches the wire.
    await expect(chat.setConfig({ thinkingLevel: "high" })).rejects.toMatchObject({ status: 422, code: "config_rejected" });
    await chat.setConfig({ permissionMode: "read-only" });
    expect(chat.snapshot().config.permissionMode).toBe("read-only");
    const settings = calls("thread/settings/update").map((c) => c.params);
    expect(settings[0]).toMatchObject({ model: "fake-max" });
    expect(settings.at(-1)).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  });

  it("renames the thread on Codex's own name, and shows the title it announces", async () => {
    const { chat } = await openChat();
    await chat.rename("a better name");
    await until(() => chat.snapshot().title === "a better name");
    expect(calls("thread/name/set")[0]?.params).toMatchObject({ name: "a better name" });
    expect((await adapter.listSessions(project))[0]?.title).toBe("a better name");
  });

  it("compacts through Codex and says so when the compaction lands", async () => {
    const { chat } = await openChat();
    await chat.send("hello", "normal");
    await until(() => chat.status === "idle");
    await chat.compact();
    expect(calls("thread/compact/start")).toHaveLength(1);
    expect(chat.snapshot().items.some((i) => i.kind === "notice" && i.text === "Compacted conversation")).toBe(true);
  });

  it("forks through Codex at the chosen turn", async () => {
    const { chat, live } = await openChat();
    await chat.send("first", "normal");
    await until(() => chat.status === "idle");
    await chat.send("second", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Fake reply: second"));
    const nativeId = live.nativeId as string;
    const { nativeId: forkId } = await adapter.forkSession({ cwd: project, nativeId, throughTurns: 1 });
    expect(forkId).not.toBe(nativeId);
    const forked = calls("thread/fork")[0]?.params as { threadId: string; lastTurnId?: string };
    expect(forked.threadId).toBe(nativeId);
    expect(forked.lastTurnId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await adapter.listSessions(project)).map((s) => s.nativeId)).toEqual(expect.arrayContaining([nativeId, forkId]));
  });

  it("resumes the same session in one child, and the file's transcript is the same conversation", async () => {
    const { chat, live } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Fake reply: hello there"));
    const nativeId = live.nativeId as string;
    const transcript = await adapter.readTranscript({ cwd: project, nativeId });
    expect(transcript?.items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text)).toEqual(["hello there"]);
    expect(transcript?.items.some((i) => i.kind === "assistant" && i.text.includes("Fake reply: hello there"))).toBe(true);
    const usage = await adapter.readUsage({ cwd: project, nativeId });
    expect(usage).toHaveLength(1);
    expect(usage?.[0]).toMatchObject({ model: "fake-1", input: 400, cachedInput: 600, cacheWrite: 0, output: 200, cost: null });
    await chat.dispose("done");

    const { chat: resumed, live: again } = await openChat(nativeId);
    expect(again.nativeId).toBe(nativeId);
    // The chat's own child and the adapter's metadata child.
    expect(liveCodexChildren()).toBe(2);
    expect(calls("thread/resume")[0]?.params).toMatchObject({ threadId: nativeId });
    expect(resumed.snapshot().items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text)).toEqual(["hello there"]);
    expect((await again.history()).filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text)).toEqual(["hello there"]);
    await resumed.send("and again", "normal");
    await until(() => resumed.status === "idle" && answered(resumed, "Fake reply: and again"));
    expect((await again.history()).filter((i) => i.kind === "user")).toHaveLength(2);
  });

  it("switches a resumed session off a model this account cannot run", async () => {
    const { chat, live } = await openChat();
    await chat.send("first", "normal");
    await until(() => chat.status === "idle");
    const nativeId = live.nativeId as string;
    await chat.dispose("done");
    // A session written under a paid login (or another TUI's config), as Codex stores it.
    const file = path.join(codexHome, "threads", `${nativeId}.json`);
    const thread = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    thread.model = "ghost-model";
    writeFileSync(file, JSON.stringify(thread));

    const { chat: resumed } = await openChat(nativeId);
    expect(resumed.snapshot().config.model).toBe("fake-1");
    await until(() => calls("thread/settings/update").some((c) => c.params.model === "fake-1"));
    await resumed.send("after the switch", "normal");
    await until(() => resumed.status === "idle" && answered(resumed, "Fake reply: after the switch"));
  });

  it("lists a project's sessions, recent ones, and a resume command", async () => {
    const { chat, live } = await openChat();
    await chat.send("list me", "normal");
    await until(() => chat.status === "idle" && answered(chat, "Fake reply: list me"));
    const nativeId = live.nativeId as string;
    expect((await adapter.listSessions(project)).map((s) => s.nativeId)).toEqual([nativeId]);
    expect((await adapter.listRecentSessions(10)).map((s) => [s.nativeId, s.cwd])).toEqual([[nativeId, project]]);
    expect(await adapter.resumeCommand({ cwd: project, nativeId })).toEqual(["codex", "resume", nativeId]);
    expect(await adapter.resumeCommand({ cwd: project, nativeId: "../../etc/passwd" })).toBeNull();
    expect(await adapter.resumeCommand({ cwd: project, nativeId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
  });

  it("leaves out a session whose rollout belongs to another project", async () => {
    const other = path.join(home, "other");
    mkdirSync(other);
    const elsewhere = await adapter.openChat({ cwd: other });
    await elsewhere.dispose();
    expect(await adapter.listSessions(project)).toEqual([]);
  });

  it("reports the plan's windows from account/rateLimits/read", async () => {
    const [account] = await adapter.usageLimits();
    expect(account).toMatchObject({ id: "codex", source: "Codex", provider: "OpenAI", plan: "plus", limited: false, windows: [{ label: "5 hours", used: 0.12 }] });
    expect(account?.windows[0]?.resetsAt).toBeGreaterThan(Date.now());
  });

  it("sends an image as a data URL with the prompt's text", async () => {
    const { chat } = await openChat();
    await chat.send("look at this", "normal", [{ mimeType: "image/png", data: "aGk=" }]);
    await until(() => chat.status === "idle");
    const sent = calls("turn/start")[0]?.params as { input: Array<{ type: string; url?: string }> };
    expect(sent.input).toEqual([{ type: "image", url: "data:image/png;base64,aGk=" }, { type: "text", text: "look at this", text_elements: [] }]);
    expect(chat.snapshot().items[0]).toMatchObject({ kind: "user", text: "look at this", imageCount: 1 });
  });
});
