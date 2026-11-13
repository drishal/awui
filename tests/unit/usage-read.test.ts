// Reading a session's calls straight from its file, streamed: Claude's by message id with the project check,
// and Pi and omp's from the lines that carry a usage block, to the same calls as parsing every line.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ClaudeAdapter } from "../../src/server/harness/claude.js";
import { projectDirName, usageOfEntries } from "../../src/server/harness/claude-sessions.js";
import { usageEntries } from "../../src/server/harness/agent-events.js";
import { readFileMessages } from "../../src/server/harness/session-files.js";
import { readJsonlEntries } from "../../src/server/harness/jsonl.js";
import { tempDir } from "../helpers/app.js";

let home: string;
let project: string;
let adapter: ClaudeAdapter;
const ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  home = tempDir("awui-usage-");
  project = path.join(home, "proj");
  mkdirSync(project);
  adapter = new ClaudeAdapter({ command: "claude", home, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude") } });
});
afterEach(async () => {
  await adapter.shutdown();
});

const call = (id: string, output: number, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  cwd: project,
  timestamp: "2026-11-01T10:00:00.000Z",
  message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "x" }], usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: output }, ...extra },
});

function writeClaude(lines: unknown[], cwd = project): string {
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ID}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("Claude's usage read", () => {
  const prompt = { type: "user", cwd: project, timestamp: "2026-11-01T09:59:00.000Z", message: { role: "user", content: "hello there" } };
  const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "z".repeat(5000) }] } };

  it("matches parsing every entry: one call per message id, the largest output, no synthetic ones", async () => {
    const lines = [prompt, call("m1", 5), toolResult, call("m1", 40), call("m2", 7), call("m3", 9, { model: "<synthetic>" }), toolResult];
    const file = writeClaude(lines);
    const expected = usageOfEntries(await readJsonlEntries(file));
    expect(expected).toHaveLength(2);
    expect(await adapter.readUsage({ cwd: project, nativeId: ID })).toEqual(expected);
  });

  it("reads a last line that has no newline yet", async () => {
    const file = writeClaude([prompt, call("m1", 5)]);
    writeFileSync(file, JSON.stringify(prompt) + "\n" + JSON.stringify(call("m1", 5)) + "\n" + JSON.stringify(call("m2", 8)));
    expect((await adapter.readUsage({ cwd: project, nativeId: ID }))?.map((c) => c.output).sort()).toEqual([5, 8]);
  });

  it("answers null for another project's session, and for one with no prompt", async () => {
    writeClaude([{ ...prompt, cwd: path.join(home, "elsewhere") }, call("m1", 5)]);
    expect(await adapter.readUsage({ cwd: project, nativeId: ID })).toBeNull();
    writeClaude([call("m1", 5)]);
    expect(await adapter.readUsage({ cwd: project, nativeId: ID })).toBeNull();
  });
});

describe("Pi and omp's usage read", () => {
  it("keeps only usage-bearing assistant messages and the same calls", async () => {
    const dir = tempDir("awui-pi-usage-");
    const file = path.join(dir, "s.jsonl");
    const message = (role: string, extra: Record<string, unknown> = {}) => ({ type: "message", timestamp: "2026-11-01T10:00:00.000Z", message: { role, content: [{ type: "text", text: "q".repeat(2000) }], ...extra } });
    const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 4, cost: { total: 0.5 } };
    const lines = [
      { type: "session", id: "s", cwd: project, timestamp: "2026-11-01T09:00:00.000Z" },
      message("user"),
      message("assistant", { usage, model: "m1", timestamp: 1_790_000_000_000 }),
      message("toolResult"),
      message("assistant", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: "m2" }),
      message("assistant", { usage: { ...usage, cost: { total: 0 } }, model: "m3" }),
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const all = await readFileMessages(file);
    const lean = await readFileMessages(file, true);
    expect(usageEntries(lean.messages)).toEqual(usageEntries(all.messages));
    expect(usageEntries(lean.messages)).toHaveLength(2);
    expect(lean.head).toMatchObject({ type: "session", cwd: project });
    expect(lean.messages.length).toBeLessThan(all.messages.length);
  });
});
