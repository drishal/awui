// Chat deep links: the key a link names (a live chat's id, or — the stable half — the
// namespaced session id, which survives the reopen that mints a new chat id), the URL to
// copy, and what the server says opens a key. A key nothing answers to renders inert: the
// caller clears the hash and shows the start screen, without an error.

import type { ChatSnapshot } from "../shared/protocol.js";
import { api } from "./api.js";

export interface LinkSession {
  id: string;
  harnessId: string;
  workspaceId: string;
  title: string;
  /** The live chat this session already runs in, when there is one. */
  liveChatId: string | null;
}

/** The stable key to link with: the session id once the harness assigned one, else the chat id. */
export function chatLinkKey(chat: { chatId: string; sessionId: string | null }): string {
  return chat.sessionId ?? chat.chatId;
}

/** The URL a copied link opens: the hash grammar the web app reads. */
export function chatLink(origin: string, key: string): string {
  return `${origin}/#chat=${encodeURIComponent(key)}`;
}

export type ChatLinkTarget = { chatId: string } | { session: LinkSession };

/** What the server says opens the key; null when nothing does. */
export async function resolveChatKey(key: string): Promise<ChatLinkTarget | null> {
  const answered = await api<{ chatId?: string; session?: LinkSession }>(`/api/chats/link/${encodeURIComponent(key)}`).catch(() => null);
  if (answered?.chatId) return { chatId: answered.chatId };
  if (answered?.session) return { session: answered.session };
  return null;
}

/** The chat a live resolution names. */
export function linkedChat(chatId: string): Promise<ChatSnapshot> {
  return api<ChatSnapshot>(`/api/chats/${chatId}`);
}

/** A session resolution opens through the same resume the sidebar's list uses. */
export function linkedSession(session: LinkSession, opts: { ignoreHerdr?: boolean } = {}): Promise<ChatSnapshot> {
  return api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: session.harnessId, workspaceId: session.workspaceId, sessionId: session.id, ...(opts.ignoreHerdr ? { ignoreHerdr: true } : {}) } });
}

/** The chat behind either resolution, or null (an error in a link is inert, not a failure). */
export async function linkedSnapshot(target: ChatLinkTarget): Promise<ChatSnapshot | null> {
  try {
    return "chatId" in target ? await linkedChat(target.chatId) : await linkedSession(target.session);
  } catch {
    return null;
  }
}
