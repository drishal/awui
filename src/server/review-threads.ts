// Review threads: comments pinned to a chat's diff lines, kept in
// $XDG_STATE_HOME/awui/review-threads.json for every device. A thread is the
// record that a review happened, so it outlives the chat being open and is
// removed only when someone deletes it; the bound prunes a chat's oldest
// resolved thread, never an open one. Anchors carry the line's text and hash, so
// nothing here needs the diffs themselves.
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  MAX_REVIEW_LINE_CHARS,
  MAX_REVIEW_NOTES_PER_THREAD,
  MAX_REVIEW_THREADS_PER_CHAT,
  type ReviewAnchor,
  type ReviewNote,
  type ReviewThread,
} from "../shared/protocol.js";
import { isObj, readJson, writeJson } from "./state-file.js";

/** A refusal the routes turn into a ChatError: a full chat, a full thread, a taken pin. */
export class ReviewProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SIDES: readonly ReviewAnchor["side"][] = ["add", "del", "ctx"];

/** A stored anchor, kept only when it still validates (a hand-edited file loses nothing else). */
function cleanAnchor(raw: unknown): ReviewAnchor | null {
  if (!isObj(raw)) return null;
  const { path: file, side, line, hash, text } = raw;
  if (typeof file !== "string" || file.length === 0 || file.length > 1024) return null;
  if (file.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(file)) return null;
  if (!SIDES.includes(side as ReviewAnchor["side"])) return null;
  if (line !== null && !(typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= 1_000_000)) return null;
  if (typeof hash !== "string" || !/^[0-9a-f]{8}$/.test(hash)) return null;
  if (typeof text !== "string" || text.length > MAX_REVIEW_LINE_CHARS) return null;
  return { path: file, side: side as ReviewAnchor["side"], line: line as number | null, hash, text };
}

function cleanNotes(raw: unknown): ReviewNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: ReviewNote[] = [];
  for (const value of raw.slice(0, MAX_REVIEW_NOTES_PER_THREAD)) {
    if (!isObj(value)) continue;
    const { id, text, at } = value;
    if (typeof id !== "string" || typeof text !== "string" || typeof at !== "number" || !Number.isFinite(at)) continue;
    notes.push({ id, text, at });
  }
  return notes;
}

/** A thread from the state file, or null when it is not one (no notes: a thread with nothing to say). */
function cleanThread(chatId: string, raw: unknown): ReviewThread | null {
  if (!isObj(raw)) return null;
  const anchor = cleanAnchor(raw.anchor);
  const notes = cleanNotes(raw.notes);
  if (!anchor || notes.length === 0) return null;
  const { id, status, resolvedAt, lastSentAt, createdAt } = raw;
  if (typeof id !== "string" || !id || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (status !== "open" && status !== "resolved") return null;
  return {
    id,
    chatId,
    anchor,
    notes,
    status,
    createdAt,
    ...(typeof resolvedAt === "number" && Number.isFinite(resolvedAt) ? { resolvedAt } : {}),
    ...(typeof lastSentAt === "number" && Number.isFinite(lastSentAt) ? { lastSentAt } : {}),
  };
}

const samePin = (a: ReviewAnchor, b: ReviewAnchor): boolean => a.path === b.path && a.side === b.side && a.line === b.line && a.hash === b.hash;

export class ReviewThreads {
  private readonly byChat = new Map<string, ReviewThread[]>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): ReviewThreads {
    return new ReviewThreads(null);
  }

  static async open(stateDir: string): Promise<ReviewThreads> {
    const store = new ReviewThreads(path.join(stateDir, "review-threads.json"));
    const raw = await readJson(store.file);
    if (!isObj(raw)) return store;
    for (const [chatId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const threads: ReviewThread[] = [];
      for (const value of list) {
        const thread = cleanThread(chatId, value);
        if (thread) threads.push(thread);
      }
      if (threads.length > 0) store.byChat.set(chatId, threads.slice(-MAX_REVIEW_THREADS_PER_CHAT));
    }
    return store;
  }

  /** A chat's threads, newest first. */
  list(chatId: string): ReviewThread[] {
    return [...(this.byChat.get(chatId) ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  }

  thread(chatId: string, threadId: string): ReviewThread | undefined {
    return this.byChat.get(chatId)?.find((t) => t.id === threadId);
  }

  /** A new thread on a line, refused when that line's pin is already open or the chat is full of open ones. */
  async create(chatId: string, anchor: ReviewAnchor, text: string): Promise<ReviewThread> {
    const threads = this.byChat.get(chatId) ?? [];
    if (threads.some((t) => t.status === "open" && samePin(t.anchor, anchor))) throw new ReviewProblem(409, "duplicate", "That line already has an open comment");
    if (threads.length >= MAX_REVIEW_THREADS_PER_CHAT) {
      const oldestResolved = threads.filter((t) => t.status === "resolved").sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldestResolved) throw new ReviewProblem(409, "thread_limit", `This chat has ${MAX_REVIEW_THREADS_PER_CHAT} comment threads; delete one first`);
      threads.splice(threads.indexOf(oldestResolved), 1);
    }
    const now = Date.now();
    const thread: ReviewThread = { id: randomUUID(), chatId, anchor, notes: [{ id: randomUUID(), text, at: now }], status: "open", createdAt: now };
    threads.push(thread);
    this.byChat.set(chatId, threads);
    await this.write();
    return thread;
  }

  async addNote(chatId: string, threadId: string, text: string): Promise<ReviewThread> {
    const thread = this.required(chatId, threadId);
    if (thread.notes.length >= MAX_REVIEW_NOTES_PER_THREAD) throw new ReviewProblem(409, "note_limit", `A thread holds ${MAX_REVIEW_NOTES_PER_THREAD} notes; start another on the line`);
    thread.notes.push({ id: randomUUID(), text, at: Date.now() });
    await this.write();
    return thread;
  }

  /** Resolve or reopen; the timestamp follows the status, and a repeat of the same status writes nothing. */
  async setStatus(chatId: string, threadId: string, status: ReviewThread["status"]): Promise<ReviewThread> {
    const thread = this.required(chatId, threadId);
    if (thread.status !== status) {
      thread.status = status;
      if (status === "resolved") thread.resolvedAt = Date.now();
      else delete thread.resolvedAt;
      await this.write();
    }
    return thread;
  }

  /** Follow pins to the lines a client found them on. A removed line's pin keeps the old numbering. */
  async move(chatId: string, moves: Array<{ id: string; line: number }>): Promise<number> {
    const threads = this.byChat.get(chatId);
    if (!threads) return 0;
    let moved = 0;
    for (const { id, line } of moves) {
      const thread = threads.find((t) => t.id === id);
      if (!thread || thread.anchor.side === "del" || thread.anchor.line === line) continue;
      thread.anchor.line = line;
      moved++;
    }
    if (moved > 0) await this.write();
    return moved;
  }

  async remove(chatId: string, threadId: string): Promise<boolean> {
    const threads = this.byChat.get(chatId);
    const at = threads?.findIndex((t) => t.id === threadId) ?? -1;
    if (!threads || at < 0) return false;
    threads.splice(at, 1);
    if (threads.length === 0) this.byChat.delete(chatId);
    await this.write();
    return true;
  }

  /** The batch just went to an agent: what it carried is marked in the same write as the rest. */
  async markSent(chatId: string, ids: string[], at: number): Promise<void> {
    const threads = this.byChat.get(chatId);
    if (!threads) return;
    for (const thread of threads) if (ids.includes(thread.id)) thread.lastSentAt = at;
    await this.write();
  }

  private required(chatId: string, threadId: string): ReviewThread {
    const thread = this.thread(chatId, threadId);
    if (!thread) throw new ReviewProblem(404, "no_thread", "No such comment thread");
    return thread;
  }

  private write(): Promise<void> {
    return writeJson(this.file, Object.fromEntries(this.byChat));
  }
}
