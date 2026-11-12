// What "run a routine" means, kept out of index.ts so it can be tested: check the
// routine's precheck first (a non-zero exit, a timeout, or no shell skips this slot
// — with the reason for the list), then open a chat for the routine's project and
// harness and send its prompt. The timer claims the routine before calling this
// (routines-timer.ts), so a failure here is reported once, and the routine's next
// slot is its retry, whether it launched or skipped.
//
// A run is quiet: its chat is a session of the routine's, not one of the user's (the
// session list leaves it out), and it posts one note only when the agent ended with
// something to say (routine-runs.ts keeps the verdict, and the list shows it).
import type { Routine, RoutineOutcome, RoutineRun, ChatItem, WorkspaceInfo } from "../shared/protocol.js";
import type { Chat } from "./chats/chat.js";
import type { ChatManager } from "./chats/manager.js";
import type { HarnessAdapter } from "./harness/types.js";
import { runPrecheck } from "./routine-precheck.js";
import { runDetail } from "./routines.js";
import { RoutineRuns } from "./routine-runs.js";
import type { Notifier } from "./notify.js";

/** A routine's slot: the chat it opened, or why it skipped (null only when it launched). */
export interface RoutineRunResult {
  chat: Chat | null;
  detail: string | null;
  /** The history record written when the run settled; null when nothing was kept. */
  run: RoutineRun | null;
}

/** Where a run's record and its verdict go: the two stores the list reads, and the note it may post. */
export interface RoutineRunHooks {
  runs?: RoutineRuns;
  /** The routine's own "how the last slot ended" line (routines.ts). */
  markOutcome?: (id: string, outcome: RoutineOutcome, detail: string | null) => Promise<unknown>;
  /** One note for a run that ended with something to say: the chat's title is the routine's. */
  post?: (routine: Routine, chat: Chat, detail: string) => void;
}

/** What the agent ended with: the words the list shows as "posted", and what a run's silence is. */
const QUIET = /^quiet\b/i;
/** Only the first line of an answer is posted, and only this much of it. */
const MAX_POST_CHARS = 200;

/** The answer this run produced: the assistant text after the last prompt, or "" when it said nothing. */
export function answerText(chat: Chat): string {
  const items = chat.snapshot().items;
  const parts: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as ChatItem;
    if (item.kind === "user") break;
    if (item.kind === "assistant") parts.unshift(item.text);
  }
  return parts.join("\n\n").trim();
}

/** The first line of an answer, without Markdown marks, bounded for the list and the note. */
function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const plain = line.replace(/^[\s>#*+-]+|[*_`]/g, "").trim();
    if (!plain) continue;
    return plain.length > MAX_POST_CHARS ? `${plain.slice(0, MAX_POST_CHARS)}…` : plain;
  }
  return null;
}

/**
 * Why this run failed, or null: the last error after its prompt, on the answer itself
 * or in a notice. A harness that ends a run on an error still reports "settled" after
 * it, so the chat is idle by the time a run is read: the error is on the items.
 */
function failureLine(chat: Chat): string | null {
  const items = chat.snapshot().items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as ChatItem;
    if (item.kind === "user") break;
    if (item.kind === "assistant" && item.error) return firstLine(item.error);
    if (item.kind === "notice" && item.level === "error") return firstLine(item.text);
  }
  return null;
}

/** How a finished run reads: what it posted, that it was quiet, or why it failed. */
export function runVerdict(chat: Chat): { outcome: "posted" | "quiet" | "failed"; detail: string | null } {
  const failure = failureLine(chat);
  if (chat.status === "error" || failure) return { outcome: "failed", detail: failure };
  const answer = answerText(chat);
  // A run with nothing to report says so by ending empty, or with QUIET on its first line.
  if (!answer || QUIET.test(answer)) return { outcome: "quiet", detail: null };
  return { outcome: "posted", detail: firstLine(answer) };
}

/** The one note a posted run sends: the routine's name and the answer's first line. */
export function routineNote(notifier: Notifier, routine: Routine, chat: Chat, text: string): void {
  notifier.notify({ kind: "done", chatId: chat.chatId, sessionId: chat.sessionId, title: routine.name, body: text });
}

/** Record what the run came to, and post one note when it had something to say. */
async function finish(run: RoutineRun, chat: Chat, routine: Routine, hooks: RoutineRunHooks): Promise<void> {
  const verdict = runVerdict(chat);
  await hooks.runs?.finish(run.id, { outcome: verdict.outcome, detail: verdict.detail, chatId: chat.chatId, sessionId: chat.sessionId });
  await hooks.markOutcome?.(routine.id, verdict.outcome, verdict.detail);
  if (verdict.outcome === "posted" && verdict.detail) hooks.post?.(routine, chat, verdict.detail);
}

/** Wait for a launched run's chat to settle, then record and (maybe) post what it came to. */
export async function followRoutineRun(chat: Chat, routine: Routine, run: RoutineRun, hooks: RoutineRunHooks): Promise<void> {
  await chat.waitSettled();
  await finish(run, chat, routine, hooks);
}

export async function runRoutine(routine: Routine, workspace: WorkspaceInfo, adapter: HarnessAdapter, manager: ChatManager, hooks: RoutineRunHooks = {}): Promise<RoutineRunResult> {
  const runs = hooks.runs ?? RoutineRuns.inMemory();
  // An empty precheck (the usual case, and every routine saved before the field
  // existed) runs the routine as it always did.
  if (routine.precheck) {
    const check = await runPrecheck(routine.precheck, workspace.path);
    if (!check.ok) {
      const run = await runs.start(routine);
      await runs.finish(run.id, { outcome: "skipped", detail: check.detail });
      await hooks.markOutcome?.(routine.id, "skipped", check.detail);
      return { chat: null, detail: check.detail, run: { ...run, outcome: "skipped", detail: runDetail(check.detail), endedAt: Date.now() } };
    }
  }
  const run = await runs.start(routine);
  const chat = await manager.create(adapter, workspace);
  await runs.attach(run.id, chat.chatId);
  await chat.send(routine.prompt, "normal", [], { origin: "agent" });
  // The run outlives this call: the timer must not wait for the agent, and its
  // verdict is recorded whenever the chat settles.
  void followRoutineRun(chat, routine, run, hooks).catch(() => undefined);
  return { chat, detail: null, run };
}
