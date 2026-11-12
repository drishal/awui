import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { AcpAdapter } from "../../src/server/harness/acp.js";
import { liveAcpChildren } from "../../src/server/harness/acp-client.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import { acpAgents } from "../../src/server/config.js";
import { loadConfig } from "../../src/server/config.js";
import { readUserConfig } from "../../src/server/user-config.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-acp.mjs");
chmodSync(script, 0o755);

let home: string;
let project: string;
let state: string;
let adapter: AcpAdapter;
const open: LiveChat[] = [];

/** The agent config one test runs against: the fixture, its state file, and (optionally) an auth method. */
const agent = (extra: Record<string, unknown> = {}) => ({ id: "acp-test", name: "Fake ACP", command: script, args: [], env: { FAKE_ACP_STATE: state }, authMethod: null, ...extra });

beforeEach(() => {
  home = tempDir("awui-acp-home-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new AcpAdapter(agent() as never, { home, stateDir: path.join(home, "state") });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveAcpChildren()).toBe(0);
});

const ws = (): WorkspaceInfo => ({ id: "w", path: project, name: "proj" });

async function openChat(resumeNativeId?: string, toolEnv?: NodeJS.ProcessEnv) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}), ...(toolEnv ? { toolEnv } : {}) });
  open.push(live);
  return { live, chat: await Chat.open(`c${open.length}`, adapter, ws(), live) };
}

const tokens = { AWUI_RENDER_URL: "http://127.0.0.1:4783/api/render", AWUI_RENDER_TOKEN: "r0ken", AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration", AWUI_ORCH_TOKEN: "t0ken" };

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

const toolItems = (chat: Chat) => chat.snapshot().items.filter((item) => item.kind === "tool");
const answered = (chat: Chat, text: string) => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes(text));

describe("the ACP adapter (scripted agent)", () => {
  it("discovers the agent through one handshake, naming what it advertises and no path", async () => {
    const discovery = await adapter.discover();
    expect(discovery).toMatchObject({ available: true, version: "0.9.1", versionDetail: "Fake ACP 0.9.1", warnings: [] });
    const { probe } = await adapter.probeAgent(project);
    expect(probe).toMatchObject({ agentName: "Fake ACP", loadSession: true, image: true, mcpHttp: true, authMethods: ["agent-login", "api-key"] });

    const missing = new AcpAdapter(agent({ command: path.join(home, "no-such-agent") }) as never, { home, stateDir: path.join(home, "state") });
    const refused = await missing.discover();
    expect(refused.available).toBe(false);
    expect(refused.reason).toContain("harnesses.acp");
    // A reason never carries the command line (it can hold a path) or the child's stderr.
    expect(refused.reason).not.toContain(home);
  });

  it("opens at the agent's own model and reasoning level, and turns the pills on from what it listed", async () => {
    expect(adapter.capabilities.supportsModelSelection).toBe(false);
    expect(adapter.capabilities.supportsThinkingLevel).toBe(false);
    const { chat, live } = await openChat();
    expect(live.nativeId).toMatch(/^sess-/);
    expect(chat.snapshot().config).toMatchObject({ model: "acp-pro", thinkingLevel: "medium", thinkingLevels: ["low", "medium", "high"] });
    expect(chat.snapshot().config.models.map((model) => [model.key, model.name])).toEqual([
      ["acp-pro", "ACP Pro"],
      ["acp-lite", "ACP Lite"],
    ]);
    // Declared only after an agent said it lists them: ACP's initialize does not.
    expect(adapter.capabilities.supportsModelSelection).toBe(true);
    expect(adapter.capabilities.supportsThinkingLevel).toBe(true);
    expect((await adapter.listModels()).map((model) => model.key)).toEqual(["acp-pro", "acp-lite"]);
    // ACP has neither steering nor follow-ups, and awui invents none.
    expect(chat.snapshot().capabilities).toMatchObject({ supportsSteer: false, supportsFollowUp: false, supportsRename: false, supportsRewind: false });
  });

  it("mounts awui's MCP servers only when the chat was given their tokens, over HTTP when the agent takes it", async () => {
    await openChat();
    expect(recorded("mcpServers")[0]).toMatchObject({ method: "session/new", servers: [] });

    await openChat(undefined, tokens);
    const sent = recorded("mcpServers").at(-1) as { servers: Array<{ name: string; type?: string; url?: string; headers?: Array<{ name: string; value: string }>; env?: Array<{ name: string; value: string }> }> };
    expect(sent.servers.map((server) => server.name)).toEqual(["awui", "awui-orchestrate"]);
    expect(sent.servers[1]).toMatchObject({ type: "http", url: "http://127.0.0.1:4783/api/orchestration/mcp", headers: [{ name: "Authorization", value: "Bearer t0ken" }] });
    // The token rides in the session's params, never in the child's own environment.
    expect(adapter.childEnv()).not.toHaveProperty("AWUI_ORCH_TOKEN");
  });

  it("streams a turn and settles it on the prompt's own result", async () => {
    const { chat } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "acp says ok"));
    expect(chat.snapshot().items.map((item) => item.kind)).toEqual(["user", "assistant"]);
  });

  it("shows a tool call with its category, its locations, and its output", async () => {
    const { chat } = await openChat();
    await chat.send("use the tool", "normal");
    await until(() => chat.status === "idle" && toolItems(chat)[0]?.status === "done");
    expect(toolItems(chat)[0]).toMatchObject({ name: "read_file", category: "read", status: "done", output: "hello from the file", paths: ["/tmp/notes.txt"] });
  });

  it("turns a call's diff content into the unified diff the chat folds", async () => {
    const { chat } = await openChat();
    await chat.send("diff the file", "normal");
    await until(() => chat.status === "idle" && toolItems(chat)[0]?.status === "done");
    const tool = toolItems(chat)[0];
    expect(tool).toMatchObject({ category: "edit", diffStat: { added: 1, removed: 1 } });
    expect(tool?.kind === "tool" ? tool.diff?.lines.some((line) => line.kind === "add" && line.text === "after") : false).toBe(true);
  });

  it("turns a permission request into a card in the agent's own words, and answers with its option id", async () => {
    const { chat } = await openChat();
    await chat.send("ask to run it", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const card = chat.snapshot().pending[0];
    expect(card).toMatchObject({ kind: "select", title: "run_command", options: ["Allow once", "Reject"] });
    expect(card?.message).toContain("rm -rf build");
    chat.answer(card?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle" && toolItems(chat)[0]?.status === "done");
    expect(recorded("permissionAnswers")[0]).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(toolItems(chat)[0]).toMatchObject({ status: "done", output: "build removed" });
  });

  it("sends a refusal back as the agent's reject option, and the call shows as failed", async () => {
    const { chat } = await openChat();
    await chat.send("ask to run it", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Reject" });
    await until(() => chat.status === "idle" && toolItems(chat)[0]?.status === "error");
    expect(recorded("permissionAnswers")[0]).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });

  it("stops a run the agent is still streaming", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.status === "running");
    await chat.abort();
    await until(() => chat.status === "idle", 5000);
    expect(recorded("cancels").length).toBe(1);
  });

  it("changes model and reasoning through the agent's own config options", async () => {
    const { chat } = await openChat();
    await chat.setConfig({ model: "acp-lite", thinkingLevel: "high" });
    expect(recorded("configValues")).toEqual([
      { configId: "model", value: "acp-lite" },
      { configId: "reasoning_effort", value: "high" },
    ]);
    expect(chat.snapshot().config).toMatchObject({ model: "acp-lite", thinkingLevel: "high" });
    // A value the agent does not list is refused before anything goes out.
    await expect(chat.setConfig({ model: "nope" })).rejects.toThrow(/not a model/);
  });

  it("notes an update kind it does not draw, once, and keeps reading the session's figures", async () => {
    const { chat, live } = await openChat();
    await chat.send("unknown usage title commands please", "normal");
    await until(() => chat.status === "idle" && answered(chat, "acp says ok"));
    const notices = chat.snapshot().items.filter((item) => item.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind === "notice" ? notices[0].text : "").toContain("auto_approved");
    expect(chat.snapshot().title).toBe("A named session");
    expect(await live.getContextUsage()).toEqual({ tokens: 12000, window: 200000, percent: 6 });
    expect(await live.listCommands()).toEqual([{ name: "review", source: "agent", description: "Review the diff", hint: "[path]" }]);
    // ACP states occupancy, not a per-turn token split: no usage figure is invented.
    expect(await live.getUsage()).toBeNull();
  });

  it("settles a run as failed with the child's stderr when the agent dies mid-turn", async () => {
    const { chat } = await openChat();
    const fatal: string[] = [];
    const live = open.at(-1);
    live?.subscribe((event) => {
      if (event.type === "fatal") fatal.push(event.message);
    });
    await chat.send("crash now", "normal");
    await until(() => fatal.length === 1, 5000);
    expect(fatal[0]).toContain("the provider connection closed");
  });

  it("replays a loaded session's conversation, and keeps the id it resumed", async () => {
    const { chat, live } = await openChat("sess-existing");
    expect(live.nativeId).toBe("sess-existing");
    const items = chat.snapshot().items;
    expect(items.filter((item) => item.kind === "user").map((item) => item.kind === "user" && item.text)).toEqual(["first question"]);
    expect(items.filter((item) => item.kind === "assistant").map((item) => item.kind === "assistant" && item.text)).toEqual(["first answer"]);
    expect(recorded("mcpServers")[0]).toMatchObject({ method: "session/load" });
  });

  it("refuses to resume on an agent that advertises neither loadSession nor resume", async () => {
    const plain = new AcpAdapter(agent({ id: "acp-plain", env: { FAKE_ACP_STATE: state, FAKE_ACP_NO_LOAD: "1" } }) as never, { home, stateDir: path.join(home, "state") });
    try {
      await expect(plain.openChat({ cwd: project, resumeNativeId: "sess-existing" })).rejects.toThrow(/cannot resume/);
    } finally {
      await plain.shutdown();
    }
  });

  it("signs in with the auth method config.yml names, and refuses one the agent does not offer", async () => {
    const signedIn = new AcpAdapter(agent({ id: "acp-login", authMethod: "api-key" }) as never, { home, stateDir: path.join(home, "state") });
    try {
      await signedIn.openChat({ cwd: project });
      expect(recorded("authenticate")).toEqual([{ methodId: "api-key" }]);
    } finally {
      await signedIn.shutdown();
    }
    const wrong = new AcpAdapter(agent({ id: "acp-wrong", authMethod: "magic" }) as never, { home, stateDir: path.join(home, "state") });
    try {
      await expect(wrong.openChat({ cwd: project })).rejects.toThrow(/does not offer the auth method "magic"/);
    } finally {
      await wrong.shutdown();
    }
  });
});

describe("config.yml's ACP agents", () => {
  it("registers one harness per entry, under its own id, and AWUI_HARNESSES selects them by name", () => {
    const config = loadConfig({ HOME: home }, { harnesses: { acp: [{ id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"] }] } } as never);
    expect(config.acp).toEqual([{ id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], env: {}, authMethod: null }]);
    // With nothing named, the built-ins and the ACP agent are all registered.
    expect(config.harnesses).toContain("gemini");
    expect(config.harnesses[0]).toBe("pi");
    const registry = HarnessRegistry.fromConfig(config);
    expect(registry.get("gemini")?.displayName).toBe("Gemini CLI");

    // Named in AWUI_HARNESSES, that one alone comes up.
    const only = loadConfig({ HOME: home, AWUI_HARNESSES: "fake,gemini" }, { harnesses: { acp: [{ id: "gemini", command: "gemini" }] } } as never);
    expect(HarnessRegistry.fromConfig(only).list().map((entry) => entry.id)).toEqual(["fake", "gemini"]);
    // An unknown name is still refused.
    expect(() => HarnessRegistry.fromConfig(loadConfig({ HOME: home, AWUI_HARNESSES: "nope" }))).toThrow(/Unknown harness/);
  });

  it("expands a ~ command and keeps env values out of the effective list's key order", () => {
    const dir = path.join(home, "cfg", "awui");
    mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(path.join(dir, "config.yml"), ["harnesses:", "  acp:", "    - id: goose", "      name: Goose", "      command: ~/bin/goose", "      args: [acp]", "      env:", "        GOOSE_API_KEY: s3cret", "      auth_method: api-key", ""].join("\n"));
    const read = readUserConfig(dir);
    const agents = acpAgents(read?.config, home);
    expect(agents).toEqual([{ id: "goose", name: "Goose", command: path.join(home, "bin/goose"), args: ["acp"], env: { GOOSE_API_KEY: "s3cret" }, authMethod: "api-key" }]);
  });

  it("refuses an entry that takes a built-in id, repeats an id, or is not a slug", () => {
    const dir = path.join(home, "cfg2", "awui");
    mkdirSync(dir, { recursive: true });
    const write = (yaml: string) => require("node:fs").writeFileSync(path.join(dir, "config.yml"), yaml);
    const read = () => readUserConfig(dir);
    write("harnesses:\n  acp:\n    - id: pi\n      command: pi\n");
    expect(read).toThrow(/harnesses\.acp\.0\.id/);
    write("harnesses:\n  acp:\n    - id: twice\n      command: a\n    - id: twice\n      command: b\n");
    expect(read).toThrow(/already defined/);
    write("harnesses:\n  acp:\n    - id: Has Spaces\n      command: a\n");
    expect(read).toThrow(/slug/);
    write("harnesses:\n  acp:\n    - id: gemini\n      command: gemini\n      commandLine: no\n");
    expect(read).toThrow(/harnesses\.acp\.0/);
  });
});
