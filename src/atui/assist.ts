// The small helpers behind atui's composer and pickers: `@file` mentions,
// the ghost text that finishes a slash command, which letters of a picker
// row matched the search, the toasts a session list change is worth (and
// the terminal notification for one), the empty screen's tips, a selection
// as a quote, and an answer's code blocks to run. Pure, so they can be tested.
import type { ProjectSession, SlashCommand } from "../shared/protocol.js";
import { isBusy } from "../web/session-groups.js";
import { actionKeys, type KeybindStyle } from "./keys.js";

/** The `@query` being typed at the end of the text: what to search files for, and where it starts. */
export function mentionAt(text: string): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text);
  if (!m) return null;
  return { query: m[2] as string, start: (m.index ?? 0) + (m[1] as string).length };
}

/** The text with the mention at its end replaced by the chosen file: `@src/app.ts `. */
export function applyMention(text: string, file: string): string {
  const at = mentionAt(text);
  if (!at) return text;
  return `${text.slice(0, at.start)}@${file} `;
}

/** What Tab would add to a slash command typed so far: the rest of the best match's name, shown dim after the cursor. */
export function ghostCompletion(text: string, best: SlashCommand | undefined): string {
  const m = /^\/(\S*)$/.exec(text);
  if (!m || !best) return "";
  const typed = m[1] as string;
  if (!best.name.toLowerCase().startsWith(typed.toLowerCase()) || best.name.length === typed.length) return "";
  return best.name.slice(typed.length);
}

/** The parts of `label` the search matched, so a picker can draw them brighter: each query word, case-insensitively. */
export function matchSpans(label: string, query: string): Array<{ text: string; hit: boolean }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = new Array<boolean>(label.length).fill(false);
  const lower = label.toLowerCase();
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at >= 0) for (let i = at; i < at + word.length; i++) hit[i] = true;
  }
  const out: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < label.length; i++) {
    const last = out[out.length - 1];
    if (last && last.hit === hit[i]) last.text += label[i];
    else out.push({ text: label[i] as string, hit: Boolean(hit[i]) });
  }
  return out;
}

export interface News {
  sessionId: string;
  kind: "done" | "failed" | "asking";
  title: string;
}

/**
 * What changed between two polls of the session list that is worth a toast:
 * a live session that finished or failed, or one that started asking. The
 * shown chat is left out (its own screen says so), and so is a first poll.
 */
export function newsBetween(before: ProjectSession[] | null, after: ProjectSession[], shownSessionId: string | null): News[] {
  if (!before) return [];
  const was = new Map(before.map((s) => [s.id, s]));
  const out: News[] = [];
  for (const s of after) {
    const prev = was.get(s.id);
    if (!prev || s.id === shownSessionId) continue;
    const title = s.title || "New chat";
    if (s.asking && !prev.asking) out.push({ sessionId: s.id, kind: "asking", title });
    else if (isBusy(prev.status) && !isBusy(s.status) && s.status !== undefined) out.push({ sessionId: s.id, kind: s.status === "error" ? "failed" : "done", title });
  }
  return out;
}

/** The empty screen's tips in `style`, with that style's keys named as they are bound. */
export function tipsFor(style: KeybindStyle = "emacs"): string[] {
  const k = actionKeys(style);
  return [
    `${k.model} switches the model, ${k.thinking} the thinking level, ${k.harness} the harness`,
    `${k.history} searches every session, by project`,
    `${k.commands} opens the command palette`,
    "Type @ to mention a file, / for a command",
    "C-v pastes an image from the clipboard; dropping image files attaches them",
    "Esc Esc stops the agent; the chat keeps running when you quit",
    style === "vim" ? `${k.keybinds} turns on emacs keybinds: the C-x chords` : `${k.keybinds} turns on vim navigation: j/k, gg/G, {/} between turns`,
    "Click a tool call to see its output, or the gutter to jump to a turn",
    `${k.glass} turns glass mode on: your terminal's background shows through`,
  ];
}

/** The Emacs-style tips: the default empty screen, and tests that pin the rotation. */
export const TIPS = tipsFor("emacs");

/** The tip for this moment: a new one every `everyMs`, in the active keybind style. */
export function tipAt(now: number, everyMs = 8000, style: KeybindStyle = "emacs"): string {
  const tips = tipsFor(style);
  return tips[Math.floor(now / everyMs) % tips.length] as string;
}

/**
 * The escape sequence that asks the terminal for a desktop notification:
 * OSC 777 where the terminal speaks it (foot, WezTerm, Ghostty, urxvt), OSC 9
 * elsewhere (kitty, iTerm2, Windows Terminal). Control characters are
 * stripped, since a session title is the agent's text and must not end the
 * sequence early and inject another.
 */
export function notifySequence(env: Record<string, string | undefined>, title: string, body: string): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f;]/g, " ").slice(0, 200);
  const term = `${env.TERM_PROGRAM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
  if (/foot|wezterm|ghostty|rxvt/.test(term)) return `\x1b]777;notify;${clean(title)};${clean(body)}\x1b\\`;
  return `\x1b]9;${clean(title)}: ${clean(body)}\x1b\\`;
}

/** A passage as a Markdown quote, one "> " per line (the web UI's asQuote, for M-q on a selection). */
export function quoteText(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");
}

/** The fenced code blocks in Markdown, in order, with their language (for C-x x: run one). */
export function codeBlocks(markdown: string): Array<{ lang: string | null; code: string }> {
  const out: Array<{ lang: string | null; code: string }> = [];
  let open: { fence: string; lang: string | null; lines: string[] } | null = null;
  for (const line of markdown.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (!open && fence) {
      open = { fence: fence[1] as string, lang: fence[2] || null, lines: [] };
    } else if (open && fence && (fence[1] as string).startsWith(open.fence[0] as string) && (fence[1] as string).length >= open.fence.length && !fence[2]) {
      out.push({ lang: open.lang, code: open.lines.join("\n") });
      open = null;
    } else if (open) open.lines.push(line);
  }
  return out;
}

/** What a run's outcome says: "exit 0", "exit 2", "timed out", "stopped". */
export function runStatus(result: { exitCode: number | null; timedOut: boolean }): string {
  return result.timedOut ? "timed out" : result.exitCode === null ? "stopped" : `exit ${result.exitCode}`;
}

/** A run as the message gets it: the command and its output in a block, then how it ended (the web UI's wording). */
export function runForMessage(command: string, output: string, status: string): string {
  return `\`\`\`\n$ ${command}\n${output.replace(/\n$/, "")}\n\`\`\`\n(${status})`;
}
