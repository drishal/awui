// A chat as a Markdown file: each turn's prompt, the tools it ran (with edit
// diffs), and its answer. Thinking is left out; so are images, which are noted.
import type { ChatItem, ChatSnapshot, DiffLine, ToolItem } from "../shared/protocol.js";
import { buildTurns, countSummary, relativePath, workCounts } from "./turns.js";

/** A fence longer than any backtick run inside, so code in the text cannot close it. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", ctx: " ", hunk: "@@", gap: "…" };

function toolLines(tool: ToolItem, workspace: string): string[] {
  const target = tool.summary ? ` ${relativePath(tool.summary, workspace)}` : "";
  const failed = tool.status === "error" ? " (failed)" : "";
  const out = [`- \`${tool.name}\`${target}${failed}`];
  if (tool.diff && (tool.category === "edit" || tool.category === "write")) {
    const body = tool.diff.lines.map((l) => (l.kind === "hunk" || l.kind === "gap" ? `${SIGN[l.kind]} ${l.text}`.trimEnd() : `${SIGN[l.kind]}${l.text}`)).join("\n");
    out.push("", fence(body, "diff").replace(/^/gm, "  "), "");
  }
  return out;
}

export function chatMarkdown(chat: ChatSnapshot, harnessName: string, now = new Date()): string {
  const out: string[] = [`# ${chat.title || "Chat"}`, ""];
  out.push(`- Harness: ${harnessName}${chat.config.model ? ` · ${chat.config.model}` : ""}`);
  out.push(`- Project: \`${chat.workspace.path}\``);
  if (chat.sessionId) out.push(`- Session: \`${chat.sessionId}\``);
  out.push(`- Exported: ${now.toLocaleString()}`, "");
  for (const turn of buildTurns(chat.items, chat.status, chat.runStartedAt)) {
    if (!turn.prompt) continue;
    out.push("---", "", "## You", "");
    out.push(turn.prompt.text);
    const images = turn.prompt.imageCount ?? turn.prompt.images?.length ?? 0;
    if (images > 0) out.push("", `_${images} ${images === 1 ? "image" : "images"} attached_`);
    out.push("");
    const write = (items: ChatItem[]) => {
      const tools = items.filter((i): i is ToolItem => i.kind === "tool");
      if (tools.length === 0) return;
      out.push(`### Work · ${countSummary(workCounts(items))}`, "");
      for (const tool of tools) out.push(...toolLines(tool, chat.workspace.path));
      out.push("");
    };
    write(turn.process);
    for (const e of turn.errors) out.push(`> **Error:** ${e.text}`, "");
    if (turn.answer?.text) out.push(`## ${harnessName}`, "", turn.answer.text, "");
    write(turn.workAfter);
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** A file name from the title: letters, digits, and dashes. */
export function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "chat"}.md`;
}

export function downloadText(name: string, text: string, type = "text/markdown"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
