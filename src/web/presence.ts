// Presence reporting: this tab tells the server which chat or room it shows
// and whether the user visibly sees it (focus, blur, visibility, tab
// switches), plus a heartbeat that keeps the server's entry alive. The server
// uses it to skip a notification for a chat the user is already looking at
// (src/server/presence.ts). The id is per tab, not per browser: visibility and
// focus are per tab, so two tabs of one chat must report separately. Failure
// is silent — a missed report only means a notification the user may also see.
import { useEffect, useRef } from "react";
import { api } from "./api.js";

/** The heartbeat: shorter than the server's 60 s entry expiry, so one missed beat stays alive. */
const HEARTBEAT_MS = 25_000;

const clientId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/**
 * Mounted once in App. `chatId` and `roomId` name the target this tab shows
 * (a room's tab shows the room, not a chat); both null reports "no target" so
 * the entry stays honest. Reports only while signed in: a stray report would
 * flag the session as over. The visible/focused flags are read at send time,
 * since focus and visibility change outside React.
 */
export function usePresenceReporting(enabled: boolean, chatId: string | null, roomId: string | null): void {
  const target = useRef({ chatId, roomId });
  target.current = { chatId, roomId };

  useEffect(() => {
    if (!enabled) return;
    const cid = clientId();
    const send = () => {
      void api("/api/presence", {
        body: {
          clientId: cid,
          chatId: target.current.roomId ? null : target.current.chatId,
          roomId: target.current.roomId ?? null,
          visible: document.visibilityState === "visible",
          focused: document.hasFocus(),
        },
      }).catch(() => undefined);
    };
    send();
    const timer = window.setInterval(send, HEARTBEAT_MS);
    window.addEventListener("focus", send);
    window.addEventListener("blur", send);
    document.addEventListener("visibilitychange", send);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", send);
      window.removeEventListener("blur", send);
      document.removeEventListener("visibilitychange", send);
    };
  }, [enabled, chatId, roomId]);
}
