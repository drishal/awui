// The live room stream: a room opens in a tab like a chat, and the URL hash opens
// one (#room=<id>); this hook streams the hash's room with the same
// snapshot/reconnect rules as a chat. Events arrive in bursts and fold once per
// animation frame; a switched room's late frame can never land in the new room's
// state.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomEvent, RoomRecord } from "../shared/protocol.js";
import { applyEvents, prependRecords, type RoomState } from "./room-state.js";
import { RoomStream, type ConnectionState } from "./stream.js";

/** The room id a `#room=<id>` hash names, or null when the hash opens no room. */
export function roomIdFromHash(): string | null {
  const m = /^#room=([\w-]{1,64})$/.exec(window.location.hash);
  return m?.[1] ?? null;
}

/**
 * Navigate to a room (or away from one with null). `push` (the default) adds a
 * history entry, so Back returns to whatever was shown before; switching tabs
 * passes false to rewrite the current entry instead. Leaving a room always
 * replaces, so the room's entry never comes back empty.
 */
export function openRoomHash(roomId: string | null, { push = true }: { push?: boolean } = {}): void {
  const next = roomId ? `#room=${roomId}` : "";
  if (window.location.hash === next) return;
  if (roomId && push) history.pushState(null, "", `${window.location.pathname}${next}`);
  else history.replaceState(null, "", `${window.location.pathname}${next}`);
  // pushState/replaceState do not fire hashchange, and the hash is this target's only source of truth.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** A turn's state as the room view prints it. */
export const TURN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Working",
  waiting_for_user: "Waiting for you",
  stopping: "Stopping",
  stopped: "Stopped",
  done: "Done",
  failed: "Failed",
  interrupted: "Interrupted by a restart",
};

export const ROOM_CONN_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Offline — waiting for the connection",
};

export interface RoomStreamApi {
  roomId: string | null;
  /** The shown room's state, or null while its first snapshot is on the way. */
  state: RoomState | null;
  /** Why the room cannot be shown at all (404 before any snapshot), or null. */
  gone: string | null;
  conn: ConnectionState;
  /** Fold events the caller produced locally (a POST's queue state) into the room. */
  apply: (events: RoomEvent[]) => void;
  /** Put loaded older history in front of the snapshot's page. */
  prepend: (older: RoomRecord[]) => void;
  /** Reconnect now and replay from the last event seen (after a mutation the stream may not emit). */
  reload: () => void;
  /**
   * Stop showing the room without touching the URL, for when another target
   * (a chat) has already claimed the hash and the room state must follow.
   */
  detach: () => void;
}

export function useRoomStream({ onSignedOut }: { onSignedOut: () => void }): RoomStreamApi {
  const [hashRoomId, setHashRoomId] = useState<string | null>(roomIdFromHash);
  const [state, setState] = useState<RoomState | null>(null);
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [gone, setGone] = useState<string | null>(null);
  const [signal, setSignal] = useState(0);
  // The caller's closure may be rebuilt per render; the latest one wins.
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** The room this hook is streaming right now: a flush from a switched-away effect drops against it. */
  const roomNow = useRef<string | null>(null);

  useEffect(() => {
    const onHash = () => setHashRoomId(roomIdFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    setGone(null);
    roomNow.current = hashRoomId;
    setState((prev) => (prev && prev.roomId !== hashRoomId ? null : prev));
    if (!hashRoomId) {
      setConn("disconnected");
      return;
    }
    setConn("connecting");
    // A room switched into starts from nothing; the same room resumes after what it already folded.
    const from = stateRef.current && stateRef.current.roomId === hashRoomId ? stateRef.current.lastEventId : null;
    let queue: RoomEvent[] = [];
    let frame: number | null = null;
    let dead = false;
    const flush = () => {
      frame = null;
      const events = queue;
      queue = [];
      // A frame that raced a room switch is dropped, not folded into another room; a null state is the first snapshot's to seed (a room has no REST snapshot to fetch first, unlike a chat).
      if (roomNow.current !== hashRoomId) return;
      setState((prev) => (prev === null || prev.roomId === hashRoomId ? applyEvents(prev, events) : prev));
    };
    const handlers = {
      onEvent: (event: RoomEvent) => {
        if (dead) return;
        // The first snapshot seeds the state; every later one replaces it.
        if (event.type === "snapshot" && event.snapshot.room.id !== hashRoomId) return;
        queue.push(event);
        if (frame === null) frame = window.requestAnimationFrame(flush);
      },
      onState: (next: ConnectionState) => {
        if (!dead) setConn(next);
      },
      onGone: (status: number) => {
        if (dead) return;
        if (status === 401) signedOut.current();
        else {
          setGone("This room no longer exists.");
          setState((prev) => (prev && prev.roomId === hashRoomId ? { ...prev, gone: "This room no longer exists." } : prev));
        }
      },
    };
    const stream = new RoomStream(hashRoomId, handlers, from);
    stream.start();
    return () => {
      dead = true;
      stream.stop();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [hashRoomId, signal]);

  const apply = useCallback(
    (events: RoomEvent[]) => {
      setState((prev) => (prev && prev.roomId === hashRoomId ? applyEvents(prev, events) : prev));
    },
    [hashRoomId],
  );

  const prepend = useCallback(
    (older: RoomRecord[]) => {
      setState((prev) => (prev && prev.roomId === hashRoomId ? prependRecords(prev, older) : prev));
    },
    [hashRoomId],
  );

  const reload = useCallback(() => setSignal((n) => n + 1), []);
  const detach = useCallback(() => setHashRoomId(roomIdFromHash()), []);

  return {
    roomId: hashRoomId,
    state: state && state.roomId === hashRoomId ? state : null,
    gone,
    conn,
    apply,
    prepend,
    reload,
    detach,
  };
}
