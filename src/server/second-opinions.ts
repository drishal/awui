// Second opinions: one turn of a chat sent to another harness for review, kept in
// $XDG_STATE_HOME/awui/second-opinions.json so the card in the transcript outlives
// the reply's chat being closed. This file only records that an opinion was asked
// for and where its chat lives; the opinion itself is that chat's own transcript,
// which is the harness's to keep (never a copy here).
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MAX_OPINION_ASK_CHARS, MAX_OPINION_REPORT_CHARS, MAX_SECOND_OPINIONS_PER_CHAT, type ChatItem, type SecondOpinion } from "../shared/protocol.js";
import { isObj, readJson, writeJson } from "./state-file.js";

/** A record from the state file, or null when it is not one (a hand-edited file loses nothing else). */
function cleanOpinion(raw: unknown): SecondOpinion | null {
  if (!isObj(raw)) return null;
  const { id, turn, from, to, chatId, ask, askedAt, report } = raw;
  if (typeof id !== "string" || !id) return null;
  if (!Number.isInteger(turn) || (turn as number) < 1) return null;
  for (const value of [from, to, chatId]) if (typeof value !== "string" || !value || value.length > 64) return null;
  if (typeof ask !== "string" || ask.length > MAX_OPINION_ASK_CHARS) return null;
  if (typeof askedAt !== "number" || !Number.isFinite(askedAt)) return null;
  if (report !== null && (typeof report !== "string" || report.length > 8_000)) return null;
  return { id, turn: turn as number, from: from as string, to: to as string, chatId: chatId as string, ask, askedAt, report: report as string | null };
}

export class SecondOpinions {
  private readonly byChat = new Map<string, SecondOpinion[]>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): SecondOpinions {
    return new SecondOpinions(null);
  }

  static async open(stateDir: string): Promise<SecondOpinions> {
    const store = new SecondOpinions(path.join(stateDir, "second-opinions.json"));
    const raw = await readJson(store.file);
    if (!isObj(raw)) return store;
    for (const [chatId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const opinions = list.map(cleanOpinion).filter((opinion): opinion is SecondOpinion => opinion !== null);
      if (opinions.length > 0) store.byChat.set(chatId, opinions.slice(-MAX_SECOND_OPINIONS_PER_CHAT));
    }
    return store;
  }

  /** A chat's opinions, newest first: the list is kept in the order they were asked, so a card keeps the order a chat read in. */
  list(chatId: string): SecondOpinion[] {
    return [...(this.byChat.get(chatId) ?? [])].reverse();
  }

  /** Record one for `chatId` (the chat whose turn it reviews); its oldest goes when the cap is reached, since the chat stays. */
  async add(chatId: string, opinion: Omit<SecondOpinion, "id" | "askedAt" | "report">): Promise<SecondOpinion> {
    const record: SecondOpinion = { ...opinion, id: randomUUID(), askedAt: Date.now(), report: null };
    const list = this.byChat.get(chatId) ?? [];
    list.push(record);
    while (list.length > MAX_SECOND_OPINIONS_PER_CHAT) list.shift();
    this.byChat.set(chatId, list);
    await this.write();
    return record;
  }

  /**
   * The answer's opening words for the card, read from the opinion's own chat when a
   * client lists it. Not persisted: the reply is the harness's, and a restart re-reads
   * it from the chat the record names.
   */
  setReport(chatId: string, opinionId: string, report: string | null): SecondOpinion | undefined {
    const record = this.byChat.get(chatId)?.find((entry) => entry.id === opinionId);
    if (record) record.report = report;
    return record;
  }

  private write(): Promise<void> {
    return writeJson(this.file, Object.fromEntries(this.byChat));
  }
}

/**
 * The opening words of a chat's last reply, as a card shows them: bounded, and null
 * until the other agent has said something.
 */
export function reportExcerpt(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind !== "assistant") continue;
    const text = item.text.trim();
    if (!text) continue;
    return text.length > MAX_OPINION_REPORT_CHARS ? `${text.slice(0, MAX_OPINION_REPORT_CHARS)}…` : text;
  }
  return null;
}
