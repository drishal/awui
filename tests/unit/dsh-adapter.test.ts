import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { bridgeRow, DshAdapter, flowOverlay, liveDshChildren, parseProfileTree } from "../../src/server/harness/dsh.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-dsh.mjs");
chmodSync(script, 0o755);

let home: string;
/** The DSH home: what DSH_HOME points at, never the developer's ~/.dsh. */
let dshHome: string;
let project: string;
let state: string;
let adapter: DshAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-dsh-home-");
  dshHome = path.join(home, ".dsh");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new DshAdapter({ command: script, home, env: { ...process.env, DSH_HOME: dshHome, FAKE_DSH_HOME: dshHome, FAKE_DSH_STATE: state } });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveDshChildren()).toBe(0);
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

const recorded = (key: string): unknown[] => {
  try {
    return (JSON.parse(readFileSync(state, "utf8")) as Record<string, unknown[]>)[key] ?? [];
  } catch {
    return [];
  }
};

const answered = (chat: Chat, text: string) => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes(text));
const toolItem = (chat: Chat) => {
  const item = chat.snapshot().items.find((i) => i.kind === "tool");
  if (!item || item.kind !== "tool") throw new Error("no tool item");
  return item;
};

describe("the DeepSeek Harness adapter (scripted ACP app)", () => {
  it("discovers the installed CLI and its ACP profile, and names the setup command when the bundle is missing", async () => {
    const discovery = await adapter.discover();
    expect(discovery).toMatchObject({ available: true, version: "0.2.2-alpha.3", warnings: [], overrides: { DSH_HOME: "set" } });
    // A profile bundle older than the CLI is a warning, not a failure: a flake update can leave one behind.
    const profile = path.join(dshHome, "profiles", "acp", "node_modules", "@deepseek-ai", "dsh-acp-app");
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-acp-app", version: "0.1.0" }));
    const stale = new DshAdapter({ command: script, home, env: { ...process.env, DSH_HOME: dshHome, FAKE_DSH_HOME: dshHome, FAKE_DSH_STATE: state } });
    try {
      const result = await stale.discover();
      expect(result.available).toBe(true);
      expect(result.warnings.join(" ")).toContain("bundle is 0.1.0");
      expect(result.warnings.join(" ")).toContain("plugin --profile acp add");
    } finally {
      await stale.shutdown();
    }
    const missing = new DshAdapter({ command: path.join(home, "no-such-dsh"), home, env: { ...process.env, DSH_HOME: dshHome } });
    try {
      const result = await missing.discover();
      expect(result).toMatchObject({ available: false, warnings: [], overrides: { DSH_HOME: "set" } });
      expect(result.reason).toContain("not installed");
    } finally {
      await missing.shutdown();
    }
    // A separate home keeps this probe out of the first one's cache.
    const otherHome = tempDir("awui-dsh-noacp-");
    const noAcp = new DshAdapter({ command: script, home: otherHome, env: { ...process.env, DSH_HOME: path.join(otherHome, ".dsh"), FAKE_DSH_HOME: path.join(otherHome, ".dsh"), FAKE_DSH_NO_ACP: "1" } });
    try {
      const result = await noAcp.discover();
      expect(result.available).toBe(false);
      expect(result.reason).toContain("dsh-acp-app");
      expect(result.reason).toContain("plugin --profile acp add");
    } finally {
      await noAcp.shutdown();
    }
  });

  it("follows DSH_HOME, including a tilde, and reads its session root", async () => {
    expect(await adapter.resolveAgentDir()).toBe(dshHome);
    expect(await adapter.resolveSessionDir(project)).toBe(path.join(dshHome, "sessions", "--" + project.slice(1).replaceAll("/", "-") + "--"));
    const tilde = new DshAdapter({ command: script, home, env: { ...process.env, DSH_HOME: "~/deepseek" } });
    try {
      expect(await tilde.resolveAgentDir()).toBe(path.join(home, "deepseek"));
    } finally {
      await tilde.shutdown();
    }
  });

  it("opens at DSH's own model and effort, with the levels the route lists", async () => {
    expect(await adapter.listModels()).toEqual([]);
    const { chat, live } = await openChat();
    expect(live.nativeId).toMatch(/^[0-9a-f-]{36}$/);
    const config = chat.snapshot().config;
    expect(config).toMatchObject({ model: "deepseek-official/deepseek-v4-flash", thinkingLevel: "high" });
    expect(config.models.map((m) => [m.key, m.provider, m.id, m.levels])).toEqual([
      ["deepseek-official/deepseek-v4-flash", "deepseek-official", "deepseek-v4-flash", ["off", "low", "high", "max"]],
      ["deepseek-official/deepseek-v4-pro", "deepseek-official", "deepseek-v4-pro", undefined],
      ["opencode-go/deepseek-v4.1-flash", "opencode-go", "deepseek-v4.1-flash", undefined],
    ]);
    expect(config.thinkingLevels).toEqual(["off", "low", "high", "max"]);
    // The option's group name is DSH's display name for the provider, when it has one.
    expect(config.models[0]?.providerName).toBe("DeepSeek");
    expect((await adapter.listModels()).map((m) => m.key)).toEqual(config.models.map((m) => m.key));
  });

  it("streams a turn, counts its tokens, and reports the window it filled", async () => {
    const { chat, live } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says hello there"));
    const snap = chat.snapshot();
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(snap.items[1]).toMatchObject({ text: "dsh says hello there", streaming: false });
    expect(await live.getUsage()).toMatchObject({ turns: 1, steps: 1, input: 10, cachedInput: 100, cacheWrite: 0, output: 12, cost: null });
    expect(await live.getContextUsage()).toEqual({ tokens: 122, window: 1_000_000, percent: 0 });
  });

  it("shows a tool call with its category, summary, and output", async () => {
    const { chat } = await openChat();
    await chat.send("use the tool", "normal");
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    expect(toolItem(chat)).toMatchObject({ name: "read", category: "read", summary: "README.md", output: "file.txt", status: "done" });
  });

  it("turns DSH's permission request into a card in its own words, and allows once", async () => {
    const { chat } = await openChat();
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const card = chat.snapshot().pending[0];
    // The ACP request carries only the call id; the card's title and args come from the tool_call update.
    expect(card).toMatchObject({ kind: "select", title: "bash", options: ["Allow once", "Reject"] });
    expect(card?.message).toContain("touch made.txt");
    chat.answer(card?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    expect(recorded("permissions")[0]).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(toolItem(chat)).toMatchObject({ status: "done", output: "made" });
  });

  it("sends a rejection back as the option DSH named, and the tool shows as failed", async () => {
    const { chat } = await openChat();
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Reject" });
    await until(() => chat.status === "idle" && toolItem(chat).status === "error");
    expect(recorded("permissions")[0]).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("reads an edit's diff from the session log, which the live ACP surface does not carry", async () => {
    const { chat, live } = await openChat();
    await chat.send("diff the file", "normal");
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    // The live card's diff comes from the edit's old/new arguments; the log's meta.diffs backs the resumed one.
    expect(toolItem(chat)).toMatchObject({ category: "edit", diffStat: { added: 1, removed: 1 } });
    const nativeId = live.nativeId as string;
    await chat.dispose("done");
    const read = await adapter.readTranscript({ cwd: project, nativeId });
    const tool = read?.items.find((i) => i.kind === "tool");
    if (!tool || tool.kind !== "tool") throw new Error("no tool in the transcript");
    expect(tool).toMatchObject({ category: "edit", status: "done", diffStat: { added: 1, removed: 1 } });
    expect(tool.diff?.lines.some((line) => line.kind === "del" && line.text === "a")).toBe(true);
    expect(tool.diff?.lines.some((line) => line.kind === "add" && line.text === "b")).toBe(true);
  });

  it("streams a thought before the answer", async () => {
    const { chat } = await openChat();
    await chat.send("think about it", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says think about it"));
    expect(chat.snapshot().items.find((i) => i.kind === "assistant")).toMatchObject({ thinking: "hmm" });
  });

  it("switches model and effort with DSH's opaque route values, and refuses a level the route does not list", async () => {
    const { chat } = await openChat();
    await chat.setConfig({ thinkingLevel: "low" });
    expect(chat.snapshot().config).toMatchObject({ thinkingLevel: "low" });
    await chat.setConfig({ model: "opencode-go/deepseek-v4.1-flash" });
    expect(chat.snapshot().config).toMatchObject({ model: "opencode-go/deepseek-v4.1-flash" });
    const sent = recorded("setConfig") as Array<{ configId: string; value: unknown }>;
    expect(sent[1]).toEqual({ configId: "model", value: JSON.stringify(["opencode-go", "deepseek-v4.1-flash"]) });
    await expect(chat.setConfig({ thinkingLevel: "xhigh" })).rejects.toMatchObject({ status: 422, code: "config_rejected" });
    expect(recorded("setConfig")).toHaveLength(2);
  });

  it("refuses an image on a build that advertises none, without sending a prompt", async () => {
    const { chat } = await openChat();
    await expect(chat.send("hello there", "normal", [{ mimeType: "image/png", data: "aGk=" }])).rejects.toMatchObject({ code: "prompt_rejected" });
    expect(recorded("prompts")).toEqual([]);
  });

  it("stops a slow run on DSH's own cancel", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.abort();
    expect(chat.status).toBe("idle");
    expect(recorded("cancels")).toHaveLength(1);
  });

  it("reports a turn that failed after DSH took it, and still settles", async () => {
    const { chat } = await openChat();
    await chat.send("fail now", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "notice"));
    expect(chat.snapshot().items.find((i) => i.kind === "notice")).toMatchObject({ level: "error", text: "boom" });
    expect(recorded("prompts")).toEqual(["fail now"]);
  });

  it("resumes from the session log without replaying the load or double-counting its turn", async () => {
    const { chat, live } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says hello there"));
    const nativeId = live.nativeId as string;
    await chat.dispose("done");

    const { chat: resumed, live: again } = await openChat(nativeId);
    expect(again.nativeId).toBe(nativeId);
    expect(resumed.snapshot().items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(await again.getUsage()).toMatchObject({ turns: 1, cost: null });

    await resumed.send("and again", "normal");
    await until(() => resumed.status === "idle" && recorded("prompts").length === 2);
    expect(await again.getUsage()).toMatchObject({ turns: 2 });
  });

  it("lists a project's sessions from DSH's own log, and reads titles and usage from it", async () => {
    const { chat, live } = await openChat();
    await chat.send("list me", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says list me"));
    const nativeId = live.nativeId as string;
    const sessions = await adapter.listSessions(project);
    expect(sessions.map((s) => [s.nativeId, s.title])).toEqual([[nativeId, "list me"]]);
    expect((await adapter.listRecentSessions(10)).map((s) => [s.nativeId, s.cwd])).toEqual([[nativeId, project]]);
    const usage = await adapter.readUsage({ cwd: project, nativeId });
    expect(usage).toHaveLength(1);
    expect(usage?.[0]).toMatchObject({ input: 10, cachedInput: 100, output: 12, cost: null });
    expect(await adapter.readTranscript({ cwd: project, nativeId: "../../etc/passwd" })).toBeNull();
    expect(await adapter.readTranscript({ cwd: path.join(home, "elsewhere"), nativeId })).toBeNull();
  });

  it("mounts awui's render MCP server on the ACP session when a chat has a render token", async () => {
    const { live } = await openChat(undefined, { AWUI_RENDER_URL: "http://127.0.0.1:4783/api/render", AWUI_RENDER_TOKEN: "t0ken" });
    expect(live.nativeId).toBeTruthy();
    const mcps = recorded("mcps") as Array<Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>>;
    expect(mcps).toHaveLength(1);
    const server = mcps[0]?.[0];
    expect(server).toMatchObject({ name: "awui", args: [path.join(import.meta.dirname, "..", "..", "extensions", "render-html-mcp.mjs")] });
    expect(path.isAbsolute(server?.command ?? "")).toBe(true);
    expect(server?.env).toEqual([
      { name: "AWUI_RENDER_URL", value: "http://127.0.0.1:4783/api/render" },
      { name: "AWUI_RENDER_TOKEN", value: "t0ken" },
    ]);
  });

  it("leaves out a session whose own cwd is elsewhere", async () => {
    const { chat, live } = await openChat();
    await chat.send("mine", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says mine"));
    const nativeId = live.nativeId as string;
    const other = path.join(home, "other");
    mkdirSync(other);
    expect(await adapter.listSessions(other)).toEqual([]);
    expect(await adapter.listRecentSessions(10)).toHaveLength(1);
    expect(nativeId).toBeTruthy();
  });
});

describe("live text through acp-flow (scripted plugin)", () => {
  const plugin = path.join(import.meta.dirname, "..", "..", "extensions", "acp-flow.mjs");
  let stateDir: string;

  /** The adapter as the registry builds it: with a state folder, so chats load the plugin. */
  function useFlow(env: NodeJS.ProcessEnv = {}) {
    stateDir = tempDir("awui-dsh-state-");
    adapter = new DshAdapter({ command: script, home, stateDir, env: { ...process.env, DSH_HOME: dshHome, FAKE_DSH_HOME: dshHome, FAKE_DSH_STATE: state, ...env } });
  }

  const assistants = (chat: Chat) => chat.snapshot().items.filter((i) => i.kind === "assistant");

  it("swaps the stock bridge row for the plugin, keeping the row's inject and config", async () => {
    useFlow();
    await openChat();
    expect(recorded("patches")).toEqual([
      [
        { id: "acp", disabled: true },
        { insert: [{ id: "acp-flow", name: plugin, inject: ["acpAppStartup"], config: { provider: "deepseek-official", model: "deepseek-v4-flash" } }] },
      ],
    ]);
    // The overlay lives in awui's state folder, private like the rest of it.
    expect(statSync(path.join(stateDir, "dsh", "acp-flow.patch.yml")).mode & 0o777).toBe(0o600);
  });

  it("shows the text while the turn runs, once, without another session's stream", async () => {
    useFlow();
    const { chat } = await openChat();
    await chat.send("paced hello", "normal");
    // The commit lags the live text by 300ms: the bubble has words while the run is still going.
    await until(() => assistants(chat).some((i) => i.kind === "assistant" && i.text.includes("dsh says")), 2000);
    expect(chat.status).not.toBe("idle");
    await until(() => chat.status === "idle");
    expect(assistants(chat)).toHaveLength(1);
    expect(assistants(chat)[0]).toMatchObject({ text: "dsh says paced hello", streaming: false });
    expect(JSON.stringify(chat.snapshot().items)).not.toContain("stray");
  });

  it("streams thinking before the answer, in one bubble", async () => {
    useFlow();
    const { chat } = await openChat();
    await chat.send("think about it", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says think about it"));
    expect(assistants(chat)).toHaveLength(1);
    expect(assistants(chat)[0]).toMatchObject({ thinking: "hmm", text: "dsh says think about it" });
  });

  it("replaces the bubble with the message DSH kept when it is not what streamed", async () => {
    useFlow();
    const { chat } = await openChat();
    await chat.send("cut it", "normal");
    await until(() => chat.status === "idle");
    expect(assistants(chat)).toHaveLength(1);
    expect(assistants(chat)[0]).toMatchObject({ text: "dsh says cut it" });
  });

  it("keeps a failed attempt's text marked, and streams the retry into a bubble of its own", async () => {
    useFlow();
    const { chat } = await openChat();
    await chat.send("retry once", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says retry once"));
    const [failed, kept] = assistants(chat);
    expect(failed).toMatchObject({ text: "dsh says ret" });
    expect(failed?.kind === "assistant" && failed.error).toContain("attempt failed");
    expect(kept).toMatchObject({ text: "dsh says retry once" });
    expect(kept?.kind === "assistant" && kept.error).toBeFalsy();
  });

  it("keeps a step's text before its tool call and the next step's after it", async () => {
    useFlow();
    const { chat } = await openChat();
    await chat.send("use the tool", "normal");
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    const items = chat.snapshot().items;
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(items[1]).toMatchObject({ text: "dsh says " });
    expect(items[3]).toMatchObject({ text: "use the tool" });
  });

  it("shows a message that never streamed whole, from its committed chunks", async () => {
    useFlow();
    const { chat } = await openChat();
    // The ask script has no live frames: an approval, then the committed answer only.
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle" && answered(chat, "dsh says ask to make a file"));
    expect(assistants(chat).filter((i) => i.kind === "assistant" && i.text.includes("dsh says ask"))).toHaveLength(1);
  });

  it("stops a live run on DSH's own cancel and keeps what streamed", async () => {
    useFlow();
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => assistants(chat).some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.abort();
    expect(chat.status).toBe("idle");
    expect(recorded("cancels")).toHaveLength(1);
    expect(assistants(chat)).toHaveLength(1);
  });

  it("falls back to the stock bridge when the plugin does not load, and stops trying it", async () => {
    useFlow({ FAKE_DSH_FLOW_BROKEN: "1" });
    const started = Date.now();
    const { chat } = await openChat();
    // The failed row is caught from DSH's boot report, not by waiting out the handshake.
    expect(Date.now() - started).toBeLessThan(10_000);
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says hello there"));
    expect(chat.snapshot().items.some((i) => i.kind === "notice")).toBe(false);
    await openChat();
    expect(recorded("patches")).toHaveLength(1);
  });

  it("leaves the profile alone when its bridge row is not the stock one, the tree cannot be read, or AWUI_DSH_FLOW=0", async () => {
    for (const env of [{ FAKE_DSH_DUMP: "custom" }, { FAKE_DSH_DUMP: "fail" }, { AWUI_DSH_FLOW: "0" }]) {
      useFlow(env);
      const { chat } = await openChat();
      await chat.send("hello there", "normal");
      await until(() => chat.status === "idle" && answered(chat, "dsh says hello there"));
    }
    expect(recorded("patches")).toEqual([]);
  });
});

describe("the acp-flow overlay (no process)", () => {
  it("copies the stock bridge row, found inside a group too, and refuses one it would change", () => {
    const tree = parseProfileTree(`- id: tools\n  name: cordis:group\n  config:\n    - id: acp\n      name: '@deepseek-ai/dsh-acp'\n      inject: [acpAppStartup]\n      config: { provider: p, model: m }\n`);
    const row = bridgeRow(tree);
    expect(row).toMatchObject({ id: "acp", inject: ["acpAppStartup"], config: { provider: "p", model: "m" } });
    expect(flowOverlay(row as Record<string, unknown>, "/x/acp-flow.mjs")).toEqual([
      { id: "acp", disabled: true },
      { insert: [{ id: "acp-flow", name: "/x/acp-flow.mjs", inject: ["acpAppStartup"], config: { provider: "p", model: "m" } }] },
    ]);
    // A Cordis expression is evaluated at boot; copied, it would become its own source text.
    expect(bridgeRow(parseProfileTree("- id: acp\n  name: '@deepseek-ai/dsh-acp'\n  config:\n    model: !!js env.MODEL\n"))).toBeNull();
    expect(bridgeRow(parseProfileTree("- id: acp\n  name: '@deepseek-ai/dsh-acp'\n  disabled: true\n"))).toBeNull();
    expect(bridgeRow(parseProfileTree("- id: acp\n  name: '@me/my-bridge'\n"))).toBeNull();
  });
});

describe("the DeepSeek Harness decoder (no process)", () => {
  it("reads a transcript written by the real zstd frame layout", async () => {
    const { chat, live } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "dsh says hello there"));
    const nativeId = live.nativeId as string;
    const dir = path.join(dshHome, "sessions", "--" + project.slice(1).replaceAll("/", "-") + "--", nativeId);
    const file = path.join(dir, "session.v4.jsonl.zstd");
    expect(existsSync(file)).toBe(true);
    const read = await adapter.readTranscript({ cwd: project, nativeId });
    expect(read?.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(read?.title).toBe("hello there");
    // The adapter never writes into the harness's store.
    expect(readFileSync(file).length).toBeGreaterThan(0);
  });
});
