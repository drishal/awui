// Edit and write calls as line diffs, one shape for every harness. The
// harness's own diff wins when its result carries one (Pi and omp put a
// numbered diff in `details.diff`, Claude Code a `structuredPatch`, Hermes a
// unified `diff` in its JSON output); until then, and for harnesses that give
// none, the diff comes from the call's arguments (old/new text, a patch, a
// file's new content).
import type { DiffLine, ToolDiff } from "../../shared/protocol.js";
import { parseUnified as normalizeUnified } from "../../shared/unified-diff.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lines, and characters, kept per diff on the wire; the stat still counts them all. */
export const MAX_DIFF_LINES = 800;
const MAX_DIFF_CHARS = 40_000;
const MAX_LINE_CHARS = 400;
/** Above this many old×new lines, the middle is shown as removed-then-added instead of aligned. */
const MAX_LCS_CELLS = 4_000_000;

const splitLines = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

function finish(lines: DiffLine[]): ToolDiff | null {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added += 1;
    else if (l.kind === "del") removed += 1;
  }
  if (added + removed === 0) return null;
  const kept: DiffLine[] = [];
  let chars = 0;
  for (const l of lines) {
    if (kept.length >= MAX_DIFF_LINES || chars > MAX_DIFF_CHARS) break;
    const text = l.text.length > MAX_LINE_CHARS ? `${l.text.slice(0, MAX_LINE_CHARS)}…` : l.text;
    chars += text.length;
    kept.push(text === l.text ? l : { ...l, text });
  }
  const more = lines.length - kept.length;
  if (more > 0) kept.push({ kind: "gap", text: `${more} more line${more === 1 ? "" : "s"}` });
  return { lines: kept, added, removed };
}

/** Lines of `a` and `b` aligned: unchanged ones as context, the rest removed or added. */
export function lineDiff(a: string[], b: string[], firstLine?: number): DiffLine[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = [];
  let oldNo = firstLine ?? 0;
  let newNo = firstLine ?? 0;
  const num = (n: number) => (firstLine === undefined ? {} : { line: n });
  const ctx = (text: string) => {
    out.push({ kind: "ctx", text, ...num(newNo) });
    oldNo += 1;
    newNo += 1;
  };
  const del = (text: string) => {
    out.push({ kind: "del", text, ...num(oldNo) });
    oldNo += 1;
  };
  const add = (text: string) => {
    out.push({ kind: "add", text, ...num(newNo) });
    newNo += 1;
  };
  for (let i = 0; i < head; i += 1) ctx(a[i] as string);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_LCS_CELLS) {
    midA.forEach(del);
    midB.forEach(add);
  } else if (n > 0 || m > 0) {
    // Longest common subsequence, walked forward; removals before additions in each run.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = midA[i] === midB[j] ? (lcs[(i + 1) * w + j + 1] as number) + 1 : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ctx(midA[i] as string);
        i += 1;
        j += 1;
      } else if (j >= m || (i < n && (lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number))) {
        del(midA[i] as string);
        i += 1;
      } else {
        add(midB[j] as string);
        j += 1;
      }
    }
  }
  for (let i = a.length - tail; i < a.length; i += 1) ctx(a[i] as string);
  return out;
}

/** Context beyond this many lines either side of a change folds into a gap. */
const CONTEXT = 3;

function foldContext(lines: DiffLine[]): DiffLine[] {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "ctx") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k += 1) near[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (l.kind !== "ctx" || near[i]) {
      if (skipped > 0) out.push({ kind: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      skipped = 0;
      out.push(l);
    } else skipped += 1;
  });
  if (skipped > 0 && out.length > 0) out.push({ kind: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}

/** Shared bounded diff parsing used by harness adapters and the browser reader. */
function parseUnified(text: string): ToolDiff | null { return normalizeUnified(text); }

/**
 * Pi's and omp's numbered diff: `+12 text` / `-12 text` / ` 12 text` (Pi pads
 * the number; omp writes `+12|text`), with `...` or a blank line where
 * unchanged lines were skipped.
 */
export function parseNumbered(text: string): ToolDiff | null {
  const out: DiffLine[] = [];
  for (const line of text.split("\n")) {
    const m = /^([ +-])\s*(\d+)(?:\||\s|$)(.*)$/.exec(line);
    if (m) {
      const kind = m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx";
      out.push({ kind, text: m[3] as string, line: Number(m[2]) });
    } else if (/^\s*(\.\.\.)?\s*$/.test(line)) {
      if (out.length > 0 && out[out.length - 1]?.kind !== "gap") out.push({ kind: "gap", text: "" });
    }
  }
  while (out[out.length - 1]?.kind === "gap") out.pop();
  return finish(out);
}

/** Claude Code's structuredPatch: hunks of ` `/`-`/`+` lines with their start lines. */
function parseStructuredPatch(hunks: unknown[]): ToolDiff | null {
  const out: DiffLine[] = [];
  for (const h of hunks) {
    if (!isObj(h) || !Array.isArray(h.lines)) continue;
    if (out.length > 0) out.push({ kind: "gap", text: "" });
    let oldNo = typeof h.oldStart === "number" ? h.oldStart : 1;
    let newNo = typeof h.newStart === "number" ? h.newStart : 1;
    for (const raw of h.lines) {
      if (typeof raw !== "string") continue;
      const body = raw.slice(1);
      if (raw.startsWith("+")) out.push({ kind: "add", text: body, line: newNo++ });
      else if (raw.startsWith("-")) out.push({ kind: "del", text: body, line: oldNo++ });
      else if (raw.startsWith("\\")) continue;
      else {
        out.push({ kind: "ctx", text: body, line: newNo });
        oldNo += 1;
        newNo += 1;
      }
    }
  }
  return finish(out);
}

const allAdded = (content: string): ToolDiff | null => finish(splitLines(content).map((text, i) => ({ kind: "add" as const, text, line: i + 1 })));

const allDeleted = (content: string): ToolDiff | null => finish(splitLines(content).map((text, i) => ({ kind: "del" as const, text, line: i + 1 })));

/** Codex's fileChange changes: a hunk for an update, the whole content for an add or a delete. */
function parseFileChanges(changes: unknown[]): ToolDiff | null {
  const lines: DiffLine[] = [];
  for (const change of changes) {
    if (!isObj(change) || typeof change.path !== "string") continue;
    const kind = isObj(change.kind) ? change.kind.type : undefined;
    const body = typeof change.diff === "string" ? change.diff : "";
    const part = kind === "add" ? allAdded(body) : kind === "delete" ? allDeleted(body) : parseUnified(body);
    if (!part) continue;
    if (lines.length > 0) lines.push({ kind: "gap", text: "" });
    lines.push({ kind: "hunk", text: change.path }, ...part.lines);
  }
  return finish(lines);
}

/** omp's hashline patch: `[path#hash]` or `@@ path` headers, range lines, `+` additions, `-` removals, `~` kept lines. */
function parseOmpPatch(input: string): ToolDiff | null {
  const out: DiffLine[] = [];
  for (const line of input.split("\n")) {
    if (/^\*\*\* (Begin|End) Patch/.test(line) || line === "") continue;
    if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith("~")) out.push({ kind: "ctx", text: line.slice(1) });
    else out.push({ kind: "hunk", text: line.replace(/^\[(.+?)#\w+\]$/, "$1").replace(/^@@\s*/, "") });
  }
  return finish(out);
}

// oldString/newString: OpenCode's edit.
const OLD_KEYS = ["oldText", "old_string", "oldString", "oldStr", "original"];
const NEW_KEYS = ["newText", "new_string", "newString", "newStr", "updated"];
const DIFF_KEYS = ["diff", "patch", "unifiedDiff"];
const firstString = (args: Obj, keys: string[]): string | null => {
  for (const key of keys) if (typeof args[key] === "string") return args[key] as string;
  return null;
};

/** The diff a call's arguments describe, before the harness has answered. */
export function argsDiff(args: unknown): ToolDiff | null {
  if (!isObj(args)) return null;
  for (const key of DIFF_KEYS) {
    const body = args[key];
    if (typeof body === "string" && body.includes("\n")) {
      const diff = parseUnified(body);
      if (diff) return diff;
    }
  }
  if (typeof args.input === "string" && (/^\[.+#\w+\]/m.test(args.input) || /\*\*\* Begin Patch/.test(args.input))) {
    const diff = parseOmpPatch(args.input);
    if (diff) return diff;
  }
  const oldText = firstString(args, OLD_KEYS);
  const newText = firstString(args, NEW_KEYS);
  if (oldText !== null || newText !== null) {
    return finish(foldContext(lineDiff(splitLines(oldText ?? ""), splitLines(newText ?? ""))));
  }
  if (Array.isArray(args.edits)) {
    const lines: DiffLine[] = [];
    for (const entry of args.edits) {
      const sub = argsDiff(entry);
      if (!sub) continue;
      if (lines.length > 0) lines.push({ kind: "gap", text: "" });
      lines.push(...sub.lines);
    }
    return finish(lines);
  }
  // A write: the whole new file.
  if (typeof args.content === "string") return allAdded(args.content);
  return null;
}

/**
 * A unified diff for a result that carries the file's old and new text rather
 * than a patch (ACP's `diff` tool-call content). Bounded like every other
 * diff, and shaped so `parseUnified` reads it back.
 */
export function unifiedDiff(filePath: string, oldText: string, newText: string): string {
  let oldLines = splitLines(oldText);
  let newLines = splitLines(newText);
  if (oldLines.length > MAX_DIFF_LINES) oldLines = oldLines.slice(0, MAX_DIFF_LINES);
  if (newLines.length > MAX_DIFF_LINES) newLines = newLines.slice(0, MAX_DIFF_LINES);
  const diff = lineDiff(oldLines, newLines);
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (const line of diff) {
    if (line.kind === "add") {
      body.push(`+${line.text}`);
      newCount += 1;
    } else if (line.kind === "del") {
      body.push(`-${line.text}`);
      oldCount += 1;
    } else if (line.kind === "ctx") {
      body.push(` ${line.text}`);
      oldCount += 1;
      newCount += 1;
    }
    if (body.length >= MAX_DIFF_LINES) break;
  }
  const safe = filePath.replace(/[\r\n]/g, "");
  let text = `--- a/${safe}\n+++ b/${safe}\n@@ -1,${oldCount} +1,${newCount} @@\n${body.join("\n")}`;
  if (text.length > MAX_DIFF_CHARS) text = text.slice(0, MAX_DIFF_CHARS);
  return text;
}

/** The diff a harness reported with its result, if it reported one. */
export function resultDiff(details: unknown, output: string): ToolDiff | null {
  if (isObj(details)) {
    if (typeof details.diff === "string" && details.diff.trim()) {
      const diff = parseNumbered(details.diff) ?? parseUnified(details.diff);
      if (diff) return diff;
    }
    if (Array.isArray(details.changes) && details.changes.length > 0) {
      const diff = parseFileChanges(details.changes);
      if (diff) return diff;
    }
    if (Array.isArray(details.structuredPatch) && details.structuredPatch.length > 0) {
      const diff = parseStructuredPatch(details.structuredPatch);
      if (diff) return diff;
    }
    // Claude Code's Write of a new file: no patch, only the content.
    if (details.type === "create" && typeof details.content === "string") return allAdded(details.content);
  }
  // Hermes answers with JSON carrying a unified diff.
  const trimmed = output.trimStart();
  if (trimmed.startsWith("{") && trimmed.includes('"diff"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isObj(parsed) && typeof parsed.diff === "string") return parseUnified(parsed.diff);
    } catch {
      // Not JSON after all.
    }
  }
  return null;
}
