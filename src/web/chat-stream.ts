// The live chat stream: deep links via the URL hash, and the rAF-batched fold
// of stream events into chat state (one state update per animation frame).
import { useEffect, useRef, useState } from "react";
import type { ChatEvent } from "../shared/protocol.js";
import { applyEvents, type ChatState } from "./chat-state.js";
import { ChatStream, type ConnectionState } from "./stream.js";

/** What a chat link's `#chat=` names: a live chat's id, or the stable namespaced session id
 * (`pi:<native>`), which survives the reopen that mints a new chat id (see chat-link.ts). */
export function chatIdFromHash(): string | null {
  if (!window.location.hash.startsWith("#chat=")) return null;
  const key = decodeURIComponent(window.location.hash.slice("#chat=".length));
  return /^[\w.:+-]{1,160}$/.test(key) ? key : null;
}

export function setHash(chatId: string | null): void {
  const next = chatId ? `#chat=${encodeURIComponent(chatId)}` : "";
  if (window.location.hash !== next) history.replaceState(null, "", `${window.location.pathname}${next}`);
}

export const STATUS_LABEL: Record<string, string> = {
  starting: "Starting",
  idle: "Idle",
  running: "Working",
  stopping: "Stopping",
  compacting: "Compacting",
  error: "Error",
  disposed: "Closed",
};

export const CONN_BANNER: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Offline — waiting for the connection",
};

/**
 * Chat state plus its stream: events arrive in bursts and are applied once per
 * animation frame. `onSignedOut` fires when the server reports 401 (the flag
 * itself lives in useBootstrap).
 */
/** `hash`: the chat names the page's URL (the main chat does; the one beside it does not). */
export function useChatStream({ onSignedOut, hash = true }: { onSignedOut: () => void; hash?: boolean }) {
  const [chat, setChat] = useState<ChatState | null>(null);
  const [conn, setConn] = useState<ConnectionState>("disconnected");
  // The caller's closure may be rebuilt per render; the latest one wins.
  const signedOutRef = useRef(onSignedOut);
  signedOutRef.current = onSignedOut;
  const chatId = chat?.chatId ?? null;
  // The snapshot in hand when the stream starts; the stream resumes after it.
  const fromRef = useRef<number | null>(null);
  fromRef.current = chat?.lastEventId ?? null;

  useEffect(() => {
    if (!chatId) {
      setConn("disconnected");
      return;
    }
    if (hash) setHash(chatId);
    let queue: ChatEvent[] = [];
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      const events = queue;
      queue = [];
      setChat((prev) => (prev && prev.chatId === chatId ? applyEvents(prev, events) : prev));
    };
    const handlers = {
      onEvent: (event: ChatEvent) => {
        queue.push(event);
        if (frame === null) frame = window.requestAnimationFrame(flush);
      },
      onState: setConn,
      onGone: (status: number) => {
        if (status === 401) signedOutRef.current();
        else {
          setChat((prev) => (prev && prev.chatId === chatId ? { ...prev, status: "disposed", gone: "This chat was closed" } : prev));
        }
      },
    };
    const stream = new ChatStream(chatId, handlers, fromRef.current);
    stream.start();
    return () => {
      stream.stop();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [chatId]);

  return { chat, setChat, conn };
}
