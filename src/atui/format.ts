// What atui prints, worked out apart from the drawing so it can be tested:
// tool lines, the fold line, a running command's last lines, diffs in unified
// form for OpenTUI's <diff>, token counts, how much the latest turn has
// streamed, limit labels, and the status words.
import type { ChatItem, ChatStatus, LimitAccount, ToolDiff, ToolItem } from "../shared/protocol.js";
import { countSummary, formatDuration, relativePath, type Turn } from "../web/turns.js";

export const STATUS_LABEL: Record<ChatStatus, string> = {
  starting: "Starting",
  idle: "Idle",
  running: "Working",
  stopping: "Stopping",
  compacting: "Compacting",
  error: "Error",
  disposed: "Closed",
};

/** A tool call's one line: its target as the web UI shows it (paths relative to the project). */
export function toolTarget(item: ToolItem, workspace: string): string {
  if (item.subagents) {
    const n = item.subagents.runs.length;
    return `${n} ${n === 1 ? "agent" : "agents"}`;
  }
  return item.paths.length > 0 && item.summary === item.paths[0] ? relativePath(item.summary, workspace) : item.summary;
}

/**
 * "Working · 12s · 2 reads" while live, "Worked for 1m 4s · 3 reads, 1 edit"
 * after. A turn whose replies came between tool calls has a fold per stretch
 * of work (`part`): the first carries the time, the live one the spinner's
 * words, and the ones between say only what they did ("2 reads, 1 edit").
 */
export function foldLabel(turn: Turn, now = Date.now(), part?: { counts: Turn["counts"]; place: "first" | "middle" | "last" }): string {
  const counts = countSummary(part?.counts ?? turn.counts);
  const live = turn.live && (!part || part.place === "last");
  if (part && !live && part.place !== "first") return counts ? counts.charAt(0).toUpperCase() + counts.slice(1) : "Worked";
  const duration = turn.startedAt !== undefined ? formatDuration((turn.live ? now : (turn.endedAt ?? turn.startedAt)) - turn.startedAt) : null;
  const head = live ? (duration ? `Working · ${duration}` : "Working") : duration ? `Worked for ${duration}` : "Worked";
  return counts ? `${head} · ${counts}` : head;
}

/**
 * The last `n` lines a running command printed, for watching it live: colour
 * and cursor codes taken out, blank lines skipped, and a line redrawn in place
 * (a progress bar's `\r`) shown as it reads now.
 */
export function outputTail(output: string, n: number): string[] {
  const plain = output
    .replace(/\r\n/g, "\n")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const lines = plain
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""))
    .filter((line) => line.trim() !== "");
  return lines.slice(-n);
}

/**
 * A tool's diff as a unified diff for OpenTUI's <diff>. Each run between
 * folds becomes a hunk; its starts come from the first numbered line (the new
 * side for added and context lines, the old side for removed ones).
 */
export function unifiedDiff(file: string, diff: ToolDiff): string {
  const hunks: Array<typeof diff.lines> = [[]];
  for (const line of diff.lines) {
    if (line.kind === "gap" || line.kind === "hunk") {
      if ((hunks[hunks.length - 1] as typeof diff.lines).length > 0) hunks.push([]);
      continue;
    }
    (hunks[hunks.length - 1] as typeof diff.lines).push(line);
  }
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const hunk of hunks) {
    if (hunk.length === 0) continue;
    const firstNew = hunk.find((l) => l.kind !== "del" && l.line !== undefined)?.line;
    const firstOld = hunk.find((l) => l.kind === "del" && l.line !== undefined)?.line;
    const oldCount = hunk.filter((l) => l.kind !== "add").length;
    const newCount = hunk.filter((l) => l.kind !== "del").length;
    const newStart = firstNew ?? firstOld ?? 1;
    const oldStart = firstOld ?? newStart;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const l of hunk) out.push(`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);
  }
  return `${out.join("\n")}\n`;
}

/** How many characters the agent has written (replies and thinking) since the last prompt: what its rate is measured on. */
export function streamedChars(items: ChatItem[]): number {
  let n = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as ChatItem;
    if (item.kind === "user") break;
    if (item.kind === "assistant") n += item.text.length + item.thinking.length;
  }
  return n;
}

/** 950, 12k, 1.2M. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const PROVIDERS: Record<string, string> = { anthropic: "Anthropic", "openai-codex": "ChatGPT", openai: "OpenAI", "google-gemini-cli": "Gemini", "github-copilot": "Copilot" };

/** An account's short name: "Claude", "ChatGPT", or its provider id. */
export function accountName(a: LimitAccount): string {
  return a.source === "Claude Code" ? "Claude" : (PROVIDERS[a.provider] ?? a.provider);
}

/** A limit window's short label: "5h", "7d". */
export const windowLabel = (label: string): string => label.replace(" hours", "h").replace(" days", "d");

/**
 * A file's `file://` URL, for a terminal hyperlink (OSC 8): a path relative to
 * the project resolves against it, and each segment is percent-encoded so a
 * `#` or `?` in a name stays part of the path.
 */
export function fileUrl(file: string, workspace: string): string {
  const abs = file.startsWith("/") ? file : `${workspace.replace(/\/+$/, "")}/${file}`;
  return `file://${abs.split("/").map(encodeURIComponent).join("/")}`;
}

/** A path too long for `width`, cut at a folder: "…/workspaces/alpha" keeps the end, where the project is. */
export function clipPath(path: string, width: number): string {
  if (path.length <= width) return path;
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  // The most folders that fit, from the whole path down: the first tail short enough is the longest one.
  for (let i = 0; i < parts.length; i++) {
    const tail = `…/${parts.slice(i).join("/")}`;
    if (tail.length <= width) return tail;
  }
  return `…${path.slice(-Math.max(0, width - 1))}`;
}

/** A short line of text, cut with an ellipsis. */
export function clip(text: string, width: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
}

/** "now", "12m", "3h", "5d", or the date: how long ago a session was active. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d` : new Date(iso).toLocaleDateString();
}
