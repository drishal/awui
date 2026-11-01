// Board's HTTP surface, as the browser uses it: bot profiles, rooms and their
// members, the message/stop/answer/queue actions, and older history. Routes
// answer with the wire types from protocol.ts; a failure is an ApiError the
// caller shows as a banner rather than a thrown React error.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api.js";
import type { BotProfile, InteractionAnswer, RoomInfo, RoomRecord, RoomSnapshot, RoomSummary, RoomTurnView } from "../shared/protocol.js";
import { BOARD_HISTORY_PAGE } from "../shared/protocol.js";

export interface RoomMessageBody {
  text: string;
  /** Membership ids, in the order the composer resolved them; empty addresses the lead. */
  mentions: string[];
  /** Idempotency key: a retried POST must not post the message twice. */
  clientId: string;
}

export interface RoomMessageResult {
  turn: RoomTurnView;
  queued: RoomTurnView[];
}

const enc = encodeURIComponent;

export function newClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function fetchBots(): Promise<BotProfile[]> {
  return api<BotProfile[]>("/api/bots");
}

export function createBot(body: {
  name: string;
  harnessId: string;
  model?: string | null;
  thinkingLevel?: string | null;
  instructions?: string;
  role?: string;
  accent?: string | null;
  permissionMode?: string | null;
}): Promise<BotProfile> {
  return api<BotProfile>("/api/bots", { method: "POST", body });
}

export function patchBot(id: string, patch: Partial<Pick<BotProfile, "name" | "model" | "thinkingLevel" | "instructions" | "role" | "accent" | "permissionMode">>): Promise<BotProfile> {
  return api<BotProfile>(`/api/bots/${enc(id)}`, { method: "PATCH", body: patch });
}

export function deleteBot(id: string): Promise<unknown> {
  return api<unknown>(`/api/bots/${enc(id)}`, { method: "DELETE" });
}

export function fetchRooms(): Promise<RoomSummary[]> {
  return api<RoomSummary[]>("/api/rooms");
}

export interface RoomCreateBody {
  name: string;
  topic?: string | null;
  workspaceId: string;
  members: Array<{ botId: string; handle?: string; rank?: number; canLead?: boolean; consultable?: boolean; consultants?: string[] }>;
  leadBotId?: string;
}

export function createRoom(body: RoomCreateBody): Promise<RoomSnapshot> {
  return api<RoomSnapshot>("/api/rooms", { method: "POST", body });
}

export interface RoomPatch {
  name?: string;
  topic?: string | null;
  archived?: boolean;
  leadMemberId?: string;
  budgets?: Record<string, number>;
}

export function patchRoom(id: string, patch: RoomPatch): Promise<RoomInfo> {
  return api<RoomInfo>(`/api/rooms/${enc(id)}`, { method: "PATCH", body: patch });
}

export function addMember(
  roomId: string,
  body: { botId: string; handle: string; rank?: number; canLead?: boolean; consultable?: boolean; consultants?: string[] },
): Promise<RoomInfo> {
  return api<RoomInfo>(`/api/rooms/${enc(roomId)}/members`, { method: "POST", body });
}

export function patchMember(
  roomId: string,
  memberId: string,
  patch: { handle?: string; rank?: number; canLead?: boolean; consultable?: boolean; consultants?: string[]; enabled?: boolean },
): Promise<RoomInfo> {
  return api<RoomInfo>(`/api/rooms/${enc(roomId)}/members/${enc(memberId)}`, { method: "PATCH", body: patch });
}

export function removeMember(roomId: string, memberId: string): Promise<RoomInfo> {
  return api<RoomInfo>(`/api/rooms/${enc(roomId)}/members/${enc(memberId)}`, { method: "DELETE" });
}

export function resetMember(roomId: string, memberId: string): Promise<RoomInfo> {
  return api<RoomInfo>(`/api/rooms/${enc(roomId)}/members/${enc(memberId)}/reset`, { method: "POST", body: {} });
}

export function sendRoomMessage(roomId: string, body: RoomMessageBody): Promise<RoomMessageResult> {
  return api<RoomMessageResult>(`/api/rooms/${enc(roomId)}/messages`, { method: "POST", body });
}

export function stopRoom(roomId: string): Promise<unknown> {
  return api<unknown>(`/api/rooms/${enc(roomId)}/stop`, { method: "POST", body: {} });
}

export function cancelQueuedTurn(roomId: string, turnId: string): Promise<{ queued: RoomTurnView[] }> {
  return api<{ queued: RoomTurnView[] }>(`/api/rooms/${enc(roomId)}/queue/${enc(turnId)}`, { method: "DELETE" });
}

export function answerRoomRequest(roomId: string, requestId: string, answer: InteractionAnswer): Promise<unknown> {
  return api<unknown>(`/api/rooms/${enc(roomId)}/requests/${enc(requestId)}/answer`, { method: "POST", body: { answer } });
}

export function fetchHistory(roomId: string, before: number | null, limit = BOARD_HISTORY_PAGE): Promise<{ records: RoomRecord[] }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before !== null) query.set("before", String(before));
  return api<{ records: RoomRecord[] }>(`/api/rooms/${enc(roomId)}/history?${query.toString()}`);
}

/**
 * The export route answers text/markdown with a filename, and the browser
 * sends the sign-in cookie on a plain navigation, so an anchor is enough — no
 * blob, no second parse, and the CSP's object-src is untouched.
 */
export function downloadRoomExport(roomId: string): void {
  const a = document.createElement("a");
  a.href = `/api/rooms/${enc(roomId)}/export`;
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Rooms change on the server (a run starts, a bot asks something); the list polls only while the page is visible. */
const ROOMS_REFRESH_MS = 15_000;

export function useRooms(onSignedOut: () => void) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  const refresh = useCallback(async () => {
    const seq = ++request.current;
    setLoading(true);
    try {
      const list = await fetchRooms();
      if (seq !== request.current) return;
      setRooms(list);
      setError(null);
    } catch (e) {
      if (seq !== request.current) return;
      // A signed-out page is handled by the boot hook; anything else is a list-level error.
      if (e instanceof ApiError && e.status === 401) signedOut.current();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, ROOMS_REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { rooms, error, loading, refresh };
}

/** Bot profiles change only when someone edits one, so they are read once and after each edit. */
export function useBots(onSignedOut: () => void) {
  const [bots, setBots] = useState<BotProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  const refresh = useCallback(async () => {
    const seq = ++request.current;
    try {
      const list = await fetchBots();
      if (seq !== request.current) return;
      setBots(list);
      setError(null);
    } catch (e) {
      if (seq !== request.current) return;
      if (e instanceof ApiError && e.status === 401) signedOut.current();
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { bots, error, refresh };
}
