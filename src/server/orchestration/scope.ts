// The write-scope guard for a delegated task (A5): what a worker may write, where its private
// scratch dir is, and the verdict for a tool call or a harness permission request against that
// scope. Pure on purpose: the chat boundary (chats/chat.ts) judges with it before it answers a
// permission request and after a tool settles, and the orchestrator counts what it saw onto the
// task record — so the refusal, the counts, and the parent's report all read this one wording,
// and a write that was blocked is never reported as merely seen, nor the reverse. Harnesses that
// cannot pre-empt writes (writeScopePrevent false) get detect-and-report only; nothing here
// claims a universal guarantee across them, and a command that is not a repo move is never
// parsed at all.
import { isApproval, approvalAnswers } from "../../shared/approval.js";
import { matchesGlob } from "../../shared/breakdown.js";
import { ENVELOPE_BEGIN, ENVELOPE_END } from "../envelope.js";
import { toolCategory, toolPaths } from "../harness/agent-events.js";
import type { InteractionRequest } from "../../shared/protocol.js";
import type { TaskScope } from "./types.js";
import { isAbsolute, resolve, sep } from "node:path";

/** Globs one delegation may carry, and the most one pattern may weigh. */
export const MAX_WRITE_SCOPE_GLOBS = 8;
export const MAX_GLOB_CHARS = 128;
/** Out-of-scope paths the record keeps, newest first. */
export const MAX_SCOPE_RECENT = 8;
const MAX_PATH_CHARS = 4096;
/** Path-like tokens pulled from one permission request, so a chatty message cannot flood the matcher. */
const MAX_REQUEST_PATHS = 8;
const SCOPE_REPO_WHY = "repo moves (git commit/push/branch) are not part of this task's scope";

export type ScopeVerdict = { ok: true } | { ok: false; path: string; why: string };

/** What the chat boundary saw: a write it refused, one that landed, or one the harness errored. */
export type ScopeViolation = { path: string; why: string; kind: "blocked" | "landed" | "failed" };

export interface ScopeGuard {
  scope: TaskScope;
  workspacePath: string;
  /** The harness raises its own permission request before writes, which awui may answer. */
  prevent: boolean;
  /** awui sees the tool events, so a write that landed can be seen and reported. */
  detect: boolean;
}

/** The guard for a task's scope, or null when the task carries none (the common case). */
export function makeGuard(scope: TaskScope | null | undefined, workspacePath: string, fields: { prevent: boolean; detect: boolean }): ScopeGuard | null {
  if (!scope) return null;
  return { scope, workspacePath, prevent: fields.prevent, detect: fields.detect };
}

function clip(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The globs a delegation carries, deduped and trimmed; empty means "everything in the project".
 * A pattern holding `..` is refused before any work starts: a resolved path never contains one,
 * so such a pattern could only ever be dead weight the model trusts in vain.
 */
export function normalizeScope(globs: string[] | undefined): { ok: true; globs: string[] } | { ok: false; why: string } {
  if (!globs || globs.length === 0) return { ok: true, globs: [] };
  const out: string[] = [];
  for (const glob of globs) {
    const trimmed = glob.trim();
    if (trimmed === "") continue;
    if (trimmed.includes("..")) return { ok: false, why: `writeScope pattern "${clip(trimmed, 64)}" holds ".."; name paths inside the project` };
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return { ok: true, globs: out };
}

/** The private scratch dir a delegated child is given: `<project>/.awui/scratch/<taskId>`, inside the control folder the agent's file listings skip. */
export function scratchDirFor(workspacePath: string, taskId: string): string {
  return resolve(workspacePath, ".awui", "scratch", taskId);
}

/** The workspace-relative form of a path, or null when it resolves outside the project. */
export function relativeToWorkspace(path: string, workspacePath: string): string | null {
  if (path.length > MAX_PATH_CHARS) return null;
  const abs = isAbsolute(path) ? resolve(path) : resolve(workspacePath, path);
  const base = resolve(workspacePath);
  if (abs === base) return "";
  const prefix = base.endsWith(sep) ? base : base + sep;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
}

/** Whether a path resolves inside `dir` (itself inside the project). */
function insideDir(path: string, dir: string, workspacePath: string): boolean {
  if (path.length > MAX_PATH_CHARS) return false;
  const abs = isAbsolute(path) ? resolve(path) : resolve(workspacePath, path);
  const base = resolve(dir);
  if (abs === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return abs.startsWith(prefix);
}

/** The scope's own words for a refusal or a report: the globs, cut to what a row shows. */
export function scopeWords(scope: TaskScope): string {
  return clip(scope.globs.length > 0 ? scope.globs.join(", ") : "the whole project", 160);
}

/** Whether one file path may be written: a scope glob, the task's scratch dir, or (with no globs) anywhere in the project. */
export function judgePath(path: string, guard: ScopeGuard): ScopeVerdict {
  const relative = relativeToWorkspace(path, guard.workspacePath);
  if (relative === null) return { ok: false, path: clip(path), why: "it resolves outside this task's project" };
  if (guard.scope.scratchDir && insideDir(path, guard.scope.scratchDir, guard.workspacePath)) return { ok: true };
  if (guard.scope.globs.length === 0) return { ok: true };
  if (guard.scope.globs.some((glob) => matchesGlob(relative, glob))) return { ok: true };
  return { ok: false, path: relative, why: `it is outside this task's write scope (${scopeWords(guard.scope)})` };
}

const COMMAND_KEYS = ["command", "cmd", "script"];
/** Repo moves a worker must not make: people guard them through git-actions.ts; a worker's envelope refuses them outright. Matched anywhere in the command, so a `echo git commit` reads as one too — the guard is conservative on purpose. */
const REPO_MOVE = /\bgit\s+(?:-{1,2}[\w-]+\s+)*(commit|push|pull|merge|rebase|branch|checkout|switch|tag|cherry-pick|reset|clean)\b/;

/** The first line of a command, as the record names a repo move. */
function firstLine(text: string, max = 200): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? text;
  return clip(line, max);
}

function commandOf(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const obj = args as Record<string, unknown>;
  for (const key of COMMAND_KEYS) if (typeof obj[key] === "string" && (obj[key] as string).trim()) return obj[key] as string;
  return null;
}

/**
 * The verdict for a normalized tool call: edits and writes against the scope, commands against
 * repo moves, everything else free. A call that names no path cannot be held to anything and is
 * allowed — the report never claims a path was checked when the guard saw none.
 */
export function judgeCall(name: string, args: unknown, guard: ScopeGuard): ScopeVerdict {
  const category = toolCategory(name);
  if (category === "edit" || category === "write") {
    const paths = toolPaths(args);
    if (paths.length === 0) return { ok: true };
    for (const path of paths) {
      const verdict = judgePath(path, guard);
      if (!verdict.ok) return verdict;
    }
    return { ok: true };
  }
  if (category === "command") {
    const command = commandOf(args);
    // Other shell text is not parsed: a command that writes outside the project is the harness's own business, and the record says the guard saw no repo move rather than claiming the tree is safe.
    if (command && REPO_MOVE.test(command)) return { ok: false, path: firstLine(command), why: SCOPE_REPO_WHY };
    return { ok: true };
  }
  return { ok: true };
}

const TOOL_IN_TITLE = /(?:allow|approve|run|execute)\s+tool[:\s]+([A-Za-z_][\w.:-]*)/i;

/** Path-like tokens in a permission request's words: slash-carrying words and obvious file names, bounded. */
function requestPaths(title: string, message: string): string[] {
  const out: string[] = [];
  for (const token of `${title}\n${message}`.split(/[^\w./:-]+/)) {
    if (token.length < 3 || token.length > 512) continue;
    if (!token.includes("/") && !/\.[A-Za-z0-9]+$/.test(token)) continue;
    if (!out.includes(token)) out.push(token);
    if (out.length >= MAX_REQUEST_PATHS) break;
  }
  return out;
}

/**
 * The verdict for a harness permission request: only a named edit/write tool or a named repo
 * move is held against the scope; a named read/search/web tool is free whatever its words name,
 * and an unnamed tool is held only when the words name a repo move. Nothing else is guessed,
 * which is why a harness whose asks name nothing gets detection only, never a silent refusal.
 */
export function judgeRequest(request: InteractionRequest, guard: ScopeGuard): ScopeVerdict {
  if (!isApproval(request)) return { ok: true };
  const text = `${request.title}\n${request.message ?? ""}`;
  const named = TOOL_IN_TITLE.exec(request.title)?.[1] ?? null;
  const category = named !== null ? toolCategory(named) : null;
  if (category !== null && category !== "edit" && category !== "write" && category !== "command") return { ok: true };
  if (category === "command") {
    return REPO_MOVE.test(text) ? { ok: false, path: firstLine(request.message || request.title), why: SCOPE_REPO_WHY } : { ok: true };
  }
  if (category === null && !REPO_MOVE.test(text)) return { ok: true };
  for (const path of requestPaths(request.title, request.message ?? "")) {
    const verdict = judgePath(path, guard);
    if (!verdict.ok) return verdict;
  }
  if (category === null) return { ok: false, path: firstLine(request.message || request.title), why: SCOPE_REPO_WHY };
  return { ok: true };
}

/** Whether the guard would refuse this ask: the check Chat makes before the "needs you" note goes out, and the boundary makes again when it answers. */
export function wouldRefuse(request: InteractionRequest, guard: ScopeGuard | null): boolean {
  if (!guard || !guard.prevent) return false;
  return !judgeRequest(request, guard).ok && approvalAnswers(request) !== null;
}

/**
 * A settled tool row against the guard: the row's arguments are the bounded text the reducer
 * stringified, so JSON when it parses and the patch block's `[path#hash]` header when it does
 * not (omp's edit calls show the patch verbatim). A path that survives the bound is judged like
 * any other; one cut away is gone, and the guard says so rather than guessing at it.
 */
export function judgeSettled(name: string, argsText: string, guard: ScopeGuard): ScopeVerdict {
  const category = toolCategory(name);
  if (category !== "edit" && category !== "write") {
    let command: string | null = null;
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        for (const key of ["command", "cmd", "script"]) if (typeof obj[key] === "string") command = obj[key];
      }
    } catch {
      command = null;
    }
    if (category === "command" && command && REPO_MOVE.test(command)) return { ok: false, path: firstLine(command), why: SCOPE_REPO_WHY };
    return { ok: true };
  }
  const paths: string[] = [];
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (typeof parsed === "object" && parsed !== null) paths.push(...toolPaths(parsed));
  } catch {
    const header = /^\[(.+?)#\w+\]/m.exec(argsText);
    if (header?.[1]) paths.push(header[1]);
  }
  if (paths.length === 0) return { ok: true };
  for (const path of paths) {
    const verdict = judgePath(path, guard);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** The row a child chat draws when the guard refused its ask before the tool ran. */
export function blockedNotice(path: string, why: string): string {
  return `Write blocked outside this task's scope: ${path} — ${why}`;
}

/** The row a child chat draws when a write landed outside the scope and could only be seen. */
export function landedNotice(path: string, why: string): string {
  return `Write landed outside this task's scope (reported, not blocked): ${path} — ${why}`;
}

/**
 * The assignment contract as the brief carries it: one machine-readable payload between the
 * hidden-envelope markers, so an agent reads the scope as a contract rather than prose. The
 * caller breaks the brief's own markers first (escapeEnvelopeMarkers), so a brief that quoted a
 * contract is read as quoted and cannot forge this one.
 */
export function assignmentEnvelope(scope: TaskScope): string {
  const payload = { version: 1, action: "assignment", writeScope: scope.globs, scratchDir: scope.scratchDir, forbidRepoMoves: true };
  return `${ENVELOPE_BEGIN}\n${JSON.stringify(payload, null, 2)}\n${ENVELOPE_END}`;
}

/** The one-line note a status row, a wake report, and thread_read share about a task's scope; null when there is nothing to say. */
export function scopeNote(scope: TaskScope | null | undefined): string | null {
  if (!scope || (scope.globs.length === 0 && scope.attempted === 0)) return null;
  const note = `write scope: ${scopeWords(scope)}`;
  if (scope.attempted === 0) return note;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${note} · ${plural(scope.attempted, "out-of-scope write")} (${scope.blocked} blocked, ${scope.landed} landed)`;
}
