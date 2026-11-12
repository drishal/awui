// What a chat pane does with its chat, through the server: send (with the
// app's own /compact and /rename), stop, answer, change the model or the
// thinking level, re-read the models, and hand the chat off. The chat beside
// the main one uses these; the main pane's own versions in App.tsx do more
// (Edit and Retry by branching, forks, file undo), so it keeps them.
import type { ChatSnapshot, ConfigPatch, ImageAttachment, InteractionAnswer, SendMode } from "../shared/protocol.js";
import { api, ApiError } from "./api.js";
import type { ChatState } from "./chat-state.js";
import { appCommand } from "./commands.js";

export interface ChatActions {
  send: (text: string, mode: SendMode, images?: ImageAttachment[], options?: { compactFirst?: boolean; attachments?: string[]; idempotencyKey?: string }) => Promise<boolean>;
  stop: () => void;
  answer: (requestId: string, answer: InteractionAnswer) => Promise<void>;
  configure: (patch: ConfigPatch) => Promise<void>;
  refreshModels: () => Promise<void>;
  handoff: (harnessId: string, draft: string) => Promise<void>;
}

export function chatActions(
  chat: ChatState,
  setChat: (update: (prev: ChatState | null) => ChatState | null) => void,
  { fail, onReplaced }: { fail: (e: unknown) => void; onReplaced: (snapshot: ChatSnapshot) => void },
): ChatActions {
  const id = chat.chatId;
  return {
    send: async (text, mode, images = [], options = {}) => {
      const command = mode === "normal" && images.length === 0 && (options.attachments?.length ?? 0) === 0 ? appCommand(text) : null;
      try {
        if (command?.name === "compact") await api(`/api/chats/${id}/compact`, { body: command.arg ? { instructions: command.arg } : {} });
        else if (command?.name === "rename" && command.arg) await api(`/api/chats/${id}/rename`, { body: { name: command.arg } });
        else if (command) return false;
        else
          await api(`/api/chats/${id}/messages`, {
            body: {
              text,
              mode,
              ...(images.length > 0 ? { images } : {}),
              ...(options.attachments && options.attachments.length > 0 ? { attachments: options.attachments.map((a) => ({ id: a })) } : {}),
              ...(options.compactFirst ? { compactFirst: true } : {}),
            },
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          });
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    stop: () => {
      setChat((prev) => (prev && prev.chatId === id && prev.status !== "idle" ? { ...prev, status: "stopping" } : prev));
      api(`/api/chats/${id}/abort`, { body: {} }).catch(fail);
    },
    answer: async (requestId, a) => {
      try {
        await api(`/api/chats/${id}/requests/${encodeURIComponent(requestId)}`, { body: { answer: a } });
      } catch (e) {
        // Answered elsewhere already: drop the card.
        if (e instanceof ApiError && e.status === 409) setChat((prev) => (prev && prev.chatId === id ? { ...prev, pending: prev.pending.filter((p) => p.id !== requestId) } : prev));
        else fail(e);
      }
    },
    configure: async (patch) => {
      try {
        await api(`/api/chats/${id}/config`, { method: "PATCH", body: patch });
      } catch (e) {
        fail(e);
      }
    },
    refreshModels: async () => {
      try {
        await api(`/api/chats/${id}/models/refresh`, { body: {} });
      } catch (e) {
        fail(e);
      }
    },
    handoff: async (harnessId, draft) => {
      try {
        onReplaced(await api<ChatSnapshot>(`/api/chats/${id}/handoff`, { body: { harness: harnessId, ...(draft.trim() ? { prompt: draft } : {}) } }));
      } catch (e) {
        fail(e);
      }
    },
  };
}
