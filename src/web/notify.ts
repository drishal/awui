// Notifications on this device. With a service worker and Web Push (HTTPS or
// this machine) the server wakes the device and sw.js shows the note, even
// with the page closed. Without push (plain-HTTP LAN), the page itself asks
// for new notes while it is hidden, so it has to stay open.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PushNote } from "../shared/protocol.js";
import { api } from "./api.js";
import { load, save } from "./storage.js";

export type NotifyMode = "off" | "push" | "page" | "blocked" | "unsupported";

export interface NotifyState {
  mode: NotifyMode;
  /** In-page only: plain HTTP (no service worker), or a browser without a push service. */
  why?: "insecure" | "no-push";
  /** This device's push subscription, for a test. */
  endpoint?: string;
}

const PAGE_POLL_MS = 10_000;

const supported = () => typeof window !== "undefined" && "Notification" in window;

/** Inside the awui desktop app, whose main process shows the server's notes natively (apps/desktop/src/main.ts). */
const inDesktopApp = () => typeof navigator !== "undefined" && / Electron\//.test(navigator.userAgent);

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((x, i) => x === b[i]);
};

/** The service worker (notifications, sharing to awui, the offline page), registered where the browser allows one. */
export async function worker(): Promise<ServiceWorkerRegistration | null> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return null;
  try {
    // Never let the HTTP cache answer "is there a new worker?": a deploy must reach
    // an installed app on the next check, not an hour later.
    return await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
  } catch {
    return null;
  }
}

/** Subscribe (again, if the server's key changed) and tell the server; null when push is not available here. */
async function subscribe(reg: ServiceWorkerRegistration): Promise<string | null> {
  if (!("PushManager" in window)) return null;
  try {
    const { key } = await api<{ key: string }>("/api/push/key");
    const bytes = keyBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, bytes)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await api("/api/push/subscribe", { body: { endpoint: sub.endpoint } });
    return sub.endpoint;
  } catch {
    return null;
  }
}

/** Where this device stands, without asking for permission. */
async function current(): Promise<NotifyState> {
  if (!supported()) return { mode: "unsupported" };
  if (Notification.permission === "denied") return { mode: "blocked" };
  if (!load<boolean>("notify", false) || Notification.permission !== "granted") return { mode: "off" };
  const reg = await worker();
  const endpoint = reg ? await subscribe(reg) : null;
  return endpoint ? { mode: "push", endpoint } : { mode: "page", why: reg ? "no-push" : "insecure" };
}

export async function turnOn(): Promise<NotifyState> {
  if (!supported()) return { mode: "unsupported" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { mode: permission === "denied" ? "blocked" : "off" };
  save("notify", true);
  return current();
}

export async function turnOff(state: NotifyState): Promise<NotifyState> {
  save("notify", false);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api("/api/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => undefined);
      await sub.unsubscribe();
    } else if (state.endpoint) await api("/api/push/unsubscribe", { body: { endpoint: state.endpoint } }).catch(() => undefined);
  } catch {
    // nothing left to undo
  }
  return current();
}

/** Show a note from the page (the in-page fallback), through the worker when there is one: Android has no `new Notification`. */
async function show(note: PushNote, onOpen: (note: PushNote) => void): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  const options = { body: note.body, tag: note.id, data: { chatId: note.chatId, sessionId: note.sessionId, roomId: note.roomId ?? null }, requireInteraction: note.kind === "ask" };
  if (reg) {
    await reg.showNotification(note.title, options);
    return;
  }
  const n = new Notification(note.title, options);
  n.onclick = () => {
    window.focus();
    n.close();
    onOpen(note);
  };
}

/**
 * This device's notification state, kept in step on load, plus the in-page
 * fallback's polling and the worker's "open this chat" messages.
 */
export function useNotifications(enabled: boolean, onOpen: (note: PushNote) => void) {
  const [state, setState] = useState<NotifyState>({ mode: "off" });
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    if (enabled) void current().then(setState);
  }, [enabled]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; chatId?: string; sessionId?: string | null; roomId?: string } | null;
      if (data?.type === "open-chat" && data.chatId) openRef.current({ id: "", kind: "done", chatId: data.chatId, sessionId: data.sessionId ?? null, title: "", body: "", at: 0 });
      if (data?.type === "open-room" && data.roomId) openRef.current({ id: "", kind: "done", chatId: "", roomId: data.roomId, sessionId: null, title: "", body: "", at: 0 });
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    // The desktop app shows these itself, even with its window hidden to the tray.
    if (state.mode !== "page" || inDesktopApp()) return;
    let cursor: number | null = null;
    let stopped = false;
    const poll = async () => {
      try {
        const data = await api<{ notes: PushNote[]; now: number }>(`/api/notifications${cursor === null ? `?since=${Date.now()}` : `?since=${cursor}`}`);
        const first = cursor === null;
        cursor = data.now;
        if (first || stopped || document.visibilityState === "visible") return;
        for (const note of data.notes) await show(note, openRef.current);
      } catch {
        // try again next time
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), PAGE_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [state.mode]);

  const toggle = useCallback(async () => {
    setState(await (state.mode === "push" || state.mode === "page" ? turnOff(state) : turnOn()));
  }, [state]);

  /** A test note: pushed to this device, or shown by the page itself in the fallback (which otherwise waits until it is hidden). */
  const test = useCallback(async () => {
    const note = await api<PushNote>("/api/push/test", { body: state.endpoint ? { endpoint: state.endpoint } : {} });
    if (state.mode === "page") await show(note, openRef.current);
  }, [state]);

  return { notify: state, toggleNotify: toggle, testNotify: test };
}
