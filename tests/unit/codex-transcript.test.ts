import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRolloutFile, itemsToChatItems, parseRollout, readRolloutText, rolloutItems, rolloutMeta, rolloutUsage } from "../../src/server/harness/codex-transcript.js";
import { tempDir } from "../helpers/app.js";

const line = (type: string, payload: unknown, timestamp = "2026-11-09T10:00:00.000Z"): string => JSON.stringify({ timestamp, type, payload });

const ROLLOUT = [
  line("session_meta", { id: "019e7c79-aef0-7b32-8ba8-33d2106cae5c", timestamp: "2026-11-09T09:59:00.000Z", cwd: "/work/proj", model_provider: "openai", cli_version: "0.167.0" }),
  line("turn_context", { turn_id: "t1", cwd: "/work/proj", model: "gpt-6-luna" }),
  // Injected context, which is not a prompt.
  line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  cwd: /work/proj\n</environment_context>" }] }),
  line("event_msg", { type: "user_message", message: "list the folder" }),
  line("response_item", { type: "reasoning", summary: ["I should look."], content: [] }),
  line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Listing it." }], phase: "commentary" }),
  line("event_msg", { type: "agent_message", message: "Listing it.", phase: "commentary" }),
  line("response_item", { type: "function_call", name: "exec_command", call_id: "call_1", arguments: JSON.stringify({ cmd: "ls" }) }),
  line("response_item", { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" }),
  line("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch" }),
  line("response_item", { type: "custom_tool_call_output", call_id: "call_2", output: "Success" }),
  line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 200 }, total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 200 } } }),
  line("event_msg", { type: "context_compacted" }),
  line("event_msg", { type: "turn_aborted", reason: "interrupted" }),
].join("\n");

describe("codex rollout files", () => {
  it("reads the id and folder from session_meta, and survives a torn last line", () => {
    const lines = parseRollout(`${ROLLOUT}\n{"timestamp":"2026-11-09T10:00:01.000Z","type":"resp`);
    expect(lines).toHaveLength(14);
    expect(rolloutMeta(lines)).toMatchObject({ id: "019e7c79-aef0-7b32-8ba8-33d2106cae5c", cwd: "/work/proj", cliVersion: "0.167.0" });
  });

  it("folds the conversation once: the prompt from its event, the answer from its response item", () => {
    const items = itemsToChatItems(rolloutItems(parseRollout(ROLLOUT)));
    expect(items.map((i) => [i.kind, i.kind === "user" || i.kind === "assistant" ? i.text : ""])).toEqual([
      ["user", "list the folder"],
      ["assistant", ""],
      ["assistant", "Listing it."],
      ["tool", ""],
      ["tool", ""],
      ["notice", ""],
      ["notice", ""],
    ]);
    const thinking = items[1];
    expect(thinking?.kind === "assistant" && thinking.thinking).toBe("I should look.");
  });

  it("joins a call's result by call_id and words the shell row", () => {
    const tool = itemsToChatItems(rolloutItems(parseRollout(ROLLOUT)))[3];
    expect(tool).toMatchObject({ kind: "tool", name: "exec_command", category: "command", status: "done", output: "a.txt\nb.txt", summary: "ls" });
  });

  it("turns an apply_patch input into the lines it changed", () => {
    const tool = itemsToChatItems(rolloutItems(parseRollout(ROLLOUT)))[4];
    expect(tool).toMatchObject({ kind: "tool", category: "edit", status: "done", diffStat: { added: 1, removed: 1 } });
    const lines = tool?.kind === "tool" ? (tool.diff?.lines ?? []) : [];
    expect(lines.some((l) => l.kind === "del" && l.text === "old")).toBe(true);
    expect(lines.some((l) => l.kind === "add" && l.text === "new")).toBe(true);
  });

  it("draws the app-server's fileChange items with one hunk per file", () => {
    const items = itemsToChatItems([
      {
        type: "fileChange",
        id: "exec-1",
        status: "completed",
        changes: [
          { path: "/w/a.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
          { path: "/w/b.txt", kind: { type: "delete" }, diff: "gone\n" },
        ],
      },
    ]);
    expect(items[0]).toMatchObject({ kind: "tool", name: "apply_patch", category: "edit", paths: ["/w/a.txt", "/w/b.txt"], diffStat: { added: 1, removed: 2 } });
  });

  it("sums each recorded request once, with cache reads kept apart from fresh input", () => {
    expect(rolloutUsage(parseRollout(ROLLOUT))).toEqual([{ at: Date.parse("2026-11-09T10:00:00.000Z"), model: "gpt-6-luna", input: 400, cachedInput: 600, cacheWrite: 0, output: 200, cost: null }]);
  });

  it("prefers per-request token_usage_record lines when the file has them", () => {
    const text = [
      line("session_meta", { id: "019e7c79-aef0-7b32-8ba8-33d2106cae5c", timestamp: "2026-11-09T09:59:00.000Z", cwd: "/work/proj" }),
      line("turn_context", { turn_id: "t1", model: "gpt-6-luna" }),
      line("token_usage_record", { usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20 } }),
      line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 200 } } }),
    ].join("\n");
    expect(rolloutUsage(parseRollout(text))).toEqual([{ at: Date.parse("2026-11-09T10:00:00.000Z"), model: "gpt-6-luna", input: 50, cachedInput: 40, cacheWrite: 10, output: 20, cost: null }]);
  });

  it("finds a thread's rollout by its id, and reads it whole below the bound", async () => {
    const sessions = tempDir("awui-codex-sessions-");
    const dir = path.join(sessions, "2026", "11", "09");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout-2026-11-09T10-00-00-019e7c79-aef0-7b32-8ba8-33d2106cae5c.jsonl");
    writeFileSync(file, `${ROLLOUT}\n`);
    expect(await findRolloutFile(sessions, "019e7c79-aef0-7b32-8ba8-33d2106cae5c")).toBe(file);
    expect(await findRolloutFile(sessions, "00000000-0000-4000-8000-000000000000")).toBeNull();
    // A path, not an id, never resolves.
    expect(await findRolloutFile(sessions, "../../etc/passwd")).toBeNull();
    expect(await readRolloutText(file)).toBe(`${ROLLOUT}\n`);
  });
});
