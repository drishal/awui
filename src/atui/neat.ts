// What a turn says, the way neat-render (the pi extension in
// ~/.pi/agent/extensions) words it. A lone call is its verb and target, the
// outcome on a `└` line under it; calls fired together hang off one tree,
// each outcome at the end of its own line; reasoning is one `◇ Thinking` line;
// a finished turn closes with a Σ line of what it did.
//
//   ● Read src/app.ts:1-20            ┌─ ● Read    README.md        2 lines
//     └ 20 lines                      ├─ ● Search  listen in src    2 results
//                                     └─ ● Edit    src/app.ts       Added 3 lines
//   ● Edit src/app.ts
//     └ Added 3 lines, removed 1 line   ◇ Thinking 2.1s ~140 tokens
//       - const a = 1;
//       + const a = 2;                  Σ 3 calls · 7.5s · ~640 thought
//
// Worked out apart from the drawing so it can be tested.
import type { AssistantItem, ChatItem, ToolItem } from "../shared/protocol.js";
import { relativePath, type Turn } from "../web/turns.js";
import { toolFacts } from "../web/tool-facts.js";

export interface NeatRow {
  label: string;
  detail?: string;
  /** Between label and detail: "" gives `Update(path)`. */
  glue: string;
  facts: string[];
  /** The output itself says a test/build/typecheck failed despite a successful call. */
  failed?: boolean;
  /** The model's own remark on a command (its leading `# comment` lines), shown dim above the call. */
  note?: string;
  /** An edit's first changed lines, under the outcome. */
  diff?: Array<{ marker: "+" | "-" | " "; text: string }>;
  /** Diff lines past the preview. */
  more?: number;
}

/** Diff lines shown under an edit before the rest is elided. */
export const DIFF_PREVIEW_LINES = 8;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function args(item: ToolItem): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(item.args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lineCount(text: string): number {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

/** A path relative to the project, `~` for home, and only its last three parts when it is deep. */
export function shortPath(p: string, workspace: string, home = process.env.HOME ?? ""): string {
  let out = relativePath(p, workspace);
  if (home && out.startsWith(`${home}/`)) out = `~${out.slice(home.length)}`;
  const parts = out.split("/");
  return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : out;
}

/**
 * A command's leading `# comment` lines, split off: models narrate inside the
 * command ("# check the config ⏎ rg -n …"), which would push the real command
 * off the row. A shebang is not a comment; a command of only comments stays.
 */
export function splitComments(cmd: string, marker = "#"): { note?: string; command: string } {
  const lines = cmd.split("\n");
  const notes: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = (lines[i] as string).trim();
    if (t === "" && notes.length > 0) continue;
    if (!t.startsWith(marker) || t.startsWith("#!")) break;
    const text = t.slice(marker.length).replace(/^[#/\s]*/, "");
    if (text) notes.push(text);
  }
  const command = lines.slice(i).join("\n").trim();
  if (!command || notes.length === 0) return { command: cmd };
  return { note: notes.join(" "), command };
}

/** "Added 35 lines, removed 2 lines": Claude Code's phrasing. */
function diffStat(added: number, removed: number): string | undefined {
  const parts: string[] = [];
  if (added) parts.push(`Added ${plural(added, "line")}`);
  if (removed) parts.push(`removed ${plural(removed, "line")}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

const shortUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/+$/, "");

export function neatRow(item: ToolItem, workspace: string): NeatRow {
  const a = args(item);
  const failed = item.status === "error";
  const running = item.status === "running";
  const lines = running ? 0 : lineCount(item.output);
  const path = item.paths[0] ?? str(a.path) ?? str(a.file_path);
  // A failure says so, unless an exit code already does.
  const outcome = (facts: string[]) => (failed && !facts.some((f) => /^(failed|exit \d)/.test(f)) ? ["failed", ...facts] : facts);

  if (item.subagents) {
    const runs = item.subagents.runs;
    const done = runs.filter((r) => r.status === "done").length;
    return { label: item.name, glue: " ", detail: plural(runs.length, "agent"), facts: outcome(running ? [] : [`${done}/${runs.length} done`]) };
  }

  // A render_html call published an HTML page; a terminal cannot show the page itself, so the row names it.
  if (item.htmlRender) {
    const page = item.htmlRender;
    return { label: "Render", glue: " ", detail: page.title, facts: outcome([`${page.height}px, page in web UI`]) };
  }

  switch (item.category) {
    case "read": {
      let where = path ? shortPath(path, workspace) : item.summary;
      const from = num(a.offset) ?? num(a.start_line) ?? num(a.startLine);
      const limit = num(a.limit);
      const to = num(a.end_line) ?? num(a.endLine) ?? (from !== undefined && limit !== undefined ? from + limit - 1 : undefined);
      if (from !== undefined) where += to !== undefined ? `:${from}-${to}` : `:${from}`;
      return { label: "Read", glue: " ", detail: where, facts: outcome(lines ? [plural(lines, "line")] : []) };
    }
    case "command": {
      const cmd = str(a.command) ?? str(a.cmd) ?? str(a.script) ?? str(a.code) ?? item.summary;
      const lang = str(a.language);
      const { note, command } = splitComments(cmd, lang === "js" ? "//" : "#");
      const label = /bash|shell|terminal|exec/i.test(item.name) ? "Bash" : lang === "js" ? "JavaScript" : lang === "py" ? "Python" : item.name;
      // Success is the expected case and the bullet already says it: only a failure's code is worth a word.
      // A reported code beats guessing one from the output's last lines.
      const reported = typeof item.exitCode === "number" ? String(item.exitCode) : null;
      const guessed = failed && reported === null ? /exit(?:ed)?(?: with)?(?: code|status)?:? (\d+)/i.exec(item.output.slice(-300)) : null;
      const code = reported ?? (guessed ? guessed[1] : null);
      const facts = code && code !== "0" ? [`exit ${code}`] : [];
      const parsed = toolFacts(item);
      if (parsed.facts.length > 0) facts.push(...parsed.facts);
      else if (lines) facts.push(plural(lines, "line"));
      return { label, glue: " ", detail: label === "Bash" ? `$ ${command}` : (command.split("\n").find((l) => l.trim()) ?? command), facts: outcome(facts), ...(parsed.failed ? { failed: true } : {}), ...(note ? { note } : {}) };
    }
    case "search": {
      const q = str(a.pattern) ?? str(a.query) ?? str(a.regex) ?? str(a.name) ?? str(a.glob) ?? item.summary;
      const scope = path && path !== "." ? ` in ${shortPath(path, workspace)}` : "";
      return { label: "Search", glue: " ", detail: `${q}${scope}`, facts: outcome(lines ? [plural(lines, "result")] : []) };
    }
    case "web": {
      // A page read is a Fetch, a query a Search; a fan-out names its first and how many more.
      const url = str(a.url) ?? (Array.isArray(a.urls) ? str(a.urls[0]) : undefined);
      const query = str(a.query) ?? str(a.q) ?? (Array.isArray(a.queries) ? str(a.queries[0]) : undefined);
      const many = Array.isArray(a.urls) ? a.urls.length : Array.isArray(a.queries) ? a.queries.length : 1;
      const subject = url ? shortUrl(url) : (query ?? item.summary);
      return { label: url ? "Fetch" : "Search", glue: " ", detail: many > 1 ? `${subject} +${many - 1} more` : subject, facts: outcome(lines ? [plural(lines, "line")] : []) };
    }
    case "edit":
    case "write": {
      const facts: string[] = [];
      let diff: NeatRow["diff"];
      let more = 0;
      if (!failed && !running) {
        const stat = item.diffStat ? diffStat(item.diffStat.added, item.diffStat.removed) : undefined;
        facts.push(stat ?? (item.diff || item.diffStat ? "no change" : "done"));
        // The changed lines and a line of context either side: what the edit is about.
        // A folded gap is a boundary, so a line past it is not "next to" the change.
        const all = item.diff?.lines ?? [];
        const changed = (l: (typeof all)[number] | undefined) => l !== undefined && (l.kind === "add" || l.kind === "del");
        const near = all.filter((l, i) => changed(l) || (l.kind === "ctx" && (changed(all[i - 1]) || changed(all[i + 1]))));
        diff = near.slice(0, DIFF_PREVIEW_LINES).map((l) => ({ marker: l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ", text: l.text }));
        more = Math.max(0, near.length - DIFF_PREVIEW_LINES);
      }
      return {
        label: item.category === "write" && !item.diff?.removed ? "Write" : "Edit",
        glue: " ",
        ...(path ? { detail: shortPath(path, workspace) } : {}),
        facts: outcome(facts),
        ...(diff && diff.length > 0 ? { diff } : {}),
        ...(more > 0 ? { more } : {}),
      };
    }
    default: {
      // A script that calls other tools: its first line of code, as a command's.
      if (item.name === "codemode") {
        const code = (str(a.code) ?? item.summary).split("\n").filter((l) => l.trim());
        return { label: "Codemode", glue: " ", detail: code.length > 1 ? `${code[0]} …` : (code[0] ?? ""), facts: outcome(lines ? [plural(lines, "line")] : []) };
      }
      // `mcp__context7__resolve-library-id` reads as its server, then the tool and what it was given.
      const mcp = mcpLabel(item.name);
      if (mcp) return { label: humanise(mcp.server), glue: " ", detail: item.summary ? `${mcp.tool} ${item.summary}` : mcp.tool, facts: outcome(lines ? [plural(lines, "line")] : []) };
      return { label: humanise(item.name), glue: " ", detail: item.summary, facts: outcome(lines ? [plural(lines, "line")] : []) };
    }
  }
}

/** Short words a tool's name spells in capitals (`lsp_diagnostics` → `LSP diagnostics`). */
const UPPER = new Set(["lsp", "api", "mcp", "cli", "ui", "url", "http", "json", "pdf", "sql", "id", "bg", "pr", "ast", "llm", "tui", "fs", "css", "html"]);

/** `lsp_diagnostics` → `LSP diagnostics`: an unknown tool's name as a verb, neat-render's way. */
export function humanise(name: string): string {
  const words = name.split(/[_\-.]+/).filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w, i) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? (w[0] as string).toUpperCase() + w.slice(1) : w)).join(" ");
}

/** An MCP tool's name, `mcp__<server>__<tool>`, split in two. */
export function mcpLabel(name: string): { server: string; tool: string } | undefined {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return undefined;
  return { server: parts[1] as string, tool: parts.slice(2).join("__") };
}

/** Under this a duration says nothing ("0.2s" on every row is noise): neat-render's threshold. */
export const DURATION_AFTER_MS = 1000;

/** "2.1s", "1m4s": a span as neat-render writes it. */
export function durationLabel(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** A turn's work as it is drawn: a run of two or more calls one after another is a tree, anything else stands alone. */
export type WorkRun<T> = { kind: "tree"; calls: ToolItem[] } | { kind: "one"; row: T };

/**
 * Adjacent calls grouped the way neat-render hangs them off one tree. A call
 * with subagents keeps its own row: its agents hang under it.
 */
export function workRuns<T>(rows: T[], callOf: (row: T) => ToolItem | null): WorkRun<T>[] {
  const out: WorkRun<T>[] = [];
  let run: Array<{ row: T; call: ToolItem }> = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "tree", calls: run.map((r) => r.call) });
    else for (const r of run) out.push({ kind: "one", row: r.row });
    run = [];
  };
  for (const row of rows) {
    const call = callOf(row);
    if (call && !call.subagents) run.push({ row, call });
    else {
      flush();
      out.push({ kind: "one", row });
    }
  }
  flush();
  return out;
}

/** "2.1s ~140 tokens": how long a thought took (once it was long enough to say) and how big it is. */
export function thinkingMeta(item: AssistantItem, now = Date.now()): string {
  const ms = item.at !== undefined ? (item.endedAt ?? (item.streaming ? now : undefined) ?? item.at) - item.at : 0;
  return [ms >= 250 ? durationLabel(ms) : "", `~${thoughtTokens(item.thinking)} tokens`].filter(Boolean).join(" ");
}

/**
 * The Σ line under a finished turn: its calls, how long the work took (from
 * the calls' own times, else the turn's), the reasoning's size, and failures.
 * Empty when there is nothing measurable to say.
 */
export function sigmaFacts(turn: Pick<Turn, "process" | "workAfter" | "answer" | "startedAt" | "endedAt">): { facts: string[]; failed: string | null } {
  const items: ChatItem[] = [...turn.process, ...turn.workAfter];
  const calls = items.filter((i): i is ToolItem => i.kind === "tool");
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const c of calls) {
    if (c.at !== undefined && c.at < first) first = c.at;
    if (c.endedAt !== undefined && c.endedAt > last) last = c.endedAt;
  }
  const span = first !== Number.POSITIVE_INFINITY && last - first >= DURATION_AFTER_MS ? last - first : undefined;
  const whole = turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt - turn.startedAt >= DURATION_AFTER_MS ? turn.endedAt - turn.startedAt : undefined;
  const took = span ?? whole;
  const thinking = [...items, ...(turn.answer ? [turn.answer] : [])].reduce((n, i) => n + (i.kind === "assistant" ? i.thinking.length : 0), 0);
  const failures = calls.filter((c) => c.status === "error").length;
  const facts = [calls.length > 0 ? plural(calls.length, "call") : "", took !== undefined ? durationLabel(took) : "", thinking > 0 ? `~${tokenCount(thinking)} thought` : ""].filter(Boolean);
  return { facts, failed: failures > 0 ? `${failures} failed` : null };
}

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** A thought's title: its bold opening line when it has one (OpenAI-style summaries), else its first sentence. */
export function thoughtTitle(text: string): string {
  const bold = /^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/.exec(text.trim());
  if (bold) return (bold[1] as string).trim();
  let inFence = false;
  let line = "";
  for (const l of text.split("\n")) {
    if (FENCE.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && l.trim()) {
      line = l;
      break;
    }
  }
  const plain = line.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  const sentence = /^(.{12,}?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 72 ? `${sentence.slice(0, 71).trimEnd()}…` : sentence;
}

/** A live thought's newest line, its Markdown marks taken off: what the thinking line rolls with. */
export function latestThoughtLine(text: string): string {
  const rows = text.split("\n").map((l) => l.replace(/^[\s>*\-|#`]+/, "").trim()).filter(Boolean);
  return rows[rows.length - 1] ?? "";
}

/** "~340", "~1.2k": a thought's size in tokens, roughly. */
export function thoughtTokens(text: string): string {
  return tokenCount(text.length);
}

/** "~340" from a character count: four characters a token, as pi's own label counts. */
export function tokenCount(chars: number): string {
  const n = Math.max(1, Math.round(chars / 4));
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A harness's mark on the prompt card: π for Pi, as neat-render draws it. */
export function harnessGlyph(harnessId: string): string {
  return ({ pi: "π", omp: "ω", claude: "✻", hermes: "☤", opencode: "▣", codex: "⌬", dsh: "✦" } as Record<string, string>)[harnessId] ?? (harnessId[0]?.toUpperCase() ?? "›");
}
