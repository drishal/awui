// Shared unified-diff normalization. The browser and server agree on one
// bounded ToolDiff shape; GitHub patches and harness patches use the same rules.
import type { DiffLine, ToolDiff } from "./protocol.js";

const MAX_DIFF_LINES = 800;
const MAX_DIFF_CHARS = 40_000;
const MAX_LINE_CHARS = 400;

function finish(lines: DiffLine[]): ToolDiff | null {
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
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

/** Reduce full git binary patches to an opaque marker, without copying their encoded payload. */
function patchBody(chunk: string): string {
  return chunk.replace(/^(?:GIT binary patch\n|literal \d+\n|delta \d+\n)(?:[A-Za-z0-9+/=]+\n?)*/gm, "");
}

/** A unified diff (`@@ -a,b +c,d @@` hunks); file headers dropped. */
export function parseUnified(text: string): ToolDiff | null {
  const out: DiffLine[] = [];
  let oldNo: number | null = null;
  let newNo: number | null = null;
  for (const line of patchBody(text).split("\n")) {
    if (/^(---|\+\+\+) /.test(line) || /^(diff --git|index |new file mode|deleted file mode)/.test(line)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (hunk) {
      if (out.length > 0) out.push({ kind: "gap", text: "" });
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      if (hunk[3]) out.push({ kind: "hunk", text: hunk[3] as string });
      continue;
    }
    if (line.startsWith("@@")) {
      out.push({ kind: "hunk", text: line.replace(/^@@\s*/, "") });
      continue;
    }
    const sign = line[0];
    const body = line.slice(1);
    if (sign === "+") out.push({ kind: "add", text: body, ...(newNo !== null ? { line: newNo++ } : {}) });
    else if (sign === "-") out.push({ kind: "del", text: body, ...(oldNo !== null ? { line: oldNo++ } : {}) });
    else if (sign === " ") {
      out.push({ kind: "ctx", text: body, ...(newNo !== null ? { line: newNo } : {}) });
      if (oldNo !== null) oldNo += 1;
      if (newNo !== null) newNo += 1;
    } else if (line === "\\ No newline at end of file" || line === "") continue;
    else if (/^\*\*\* /.test(line)) {
      const file = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
      if (file) out.push({ kind: "hunk", text: file[1] as string });
    }
  }
  return finish(out);
}
