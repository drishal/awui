// What the app is opened to do, from its URL: the home-screen shortcuts
// (?new=1 a new chat, ?sessions=1 the session list), a share from another app
// (?share=1: the service worker kept the shared text and images in its cache;
// they go into the start screen's box when no chat is shown, else a new
// chat's composer), a prompt link (?prompt=…: its text goes to the same
// place to be read; a link never sends), and a link into Settings
// (?settings=<section>: its sections are named in SettingsDialog.tsx). The
// query is dropped once read, so a reload does not do it again.
import { useEffect, useRef } from "react";
import { addImagesToDraft, addLinkedPrompt, addToDraft } from "./draft-bus.js";
import { prepareImage, type PendingImage } from "./images.js";
import { linkedPrompt } from "./prompt-link.js";
import { worker } from "./notify.js";

const SHARE_CACHE = "awui-share";

/** The shared text and images the service worker kept, read once and cleared. */
async function takeShare(): Promise<{ text: string; images: File[] }> {
  if (!("caches" in window)) return { text: "", images: [] };
  const cache = await caches.open(SHARE_CACHE);
  const text = (await (await cache.match("/share/text"))?.text()) ?? "";
  const count = Number((await (await cache.match("/share/count"))?.text()) ?? "0") || 0;
  const images: File[] = [];
  for (let i = 0; i < count; i++) {
    const res = await cache.match(`/share/image/${i}`);
    if (!res) continue;
    const name = decodeURIComponent(res.headers.get("x-name") ?? `shared-${i + 1}`);
    images.push(new File([await res.blob()], name, { type: res.headers.get("content-type") ?? "image/png" }));
  }
  await caches.delete(SHARE_CACHE);
  return { text, images };
}

/**
 * What a share or prompt link brought, for the start screen's box while no
 * chat is shown. `hasChat`: a chat is on screen right now.
 */
export interface LaunchSeed {
  text?: string;
  images?: PendingImage[];
  /** Hidden characters taken out of a prompt link's text. */
  hidden?: number;
}

/**
 * `booted`: the app is up (enough to show the sessions). `ready`: a chat can
 * be started too (a project is open), which a new chat or a share waits for.
 * While no chat is shown, a share or prompt link seeds the start screen
 * instead of creating a chat.
 */
export function useLaunchActions(opts: {
  booted: boolean;
  ready: boolean;
  hasChat: boolean;
  newChat: () => Promise<unknown> | void;
  openSessions: () => void;
  /** `?settings=<section>`: open Settings on that section ("" for the one last used). */
  openSettings: (section: string) => void;
  seed: (seed: LaunchSeed) => void;
}): void {
  const done = useRef(false);
  const latest = useRef(opts);
  latest.current = opts;
  // Every secure load registers the worker, not only one that turned notifications on: it also takes shares and answers offline.
  useEffect(() => {
    void worker();
  }, []);
  useEffect(() => {
    if (!opts.booted || done.current) return;
    const params = new URLSearchParams(window.location.search);
    const action = params.has("share") ? "share" : params.get("prompt") ? "prompt" : params.has("new") ? "new" : params.has("sessions") ? "sessions" : params.has("settings") ? "settings" : null;
    if (!action) {
      done.current = true;
      return;
    }
    // A share only needs the app up while no chat is shown (the start screen takes it); Settings needs no chat at all.
    if (action !== "sessions" && action !== "settings" && opts.hasChat && !opts.ready) return;
    done.current = true;
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.hash);
    if (action === "sessions") return latest.current.openSessions();
    if (action === "settings") return latest.current.openSettings(params.get("settings") ?? "");
    void (async () => {
      const shared = action === "share" ? await takeShare() : null;
      const linked = action === "prompt" ? linkedPrompt(params.get("prompt") ?? "") : null;
      if (!latest.current.hasChat) {
        // The start screen: its box waits for the user's send; nothing spawns.
        const images = shared?.images.length ? await Promise.all(shared.images.map((f) => prepareImage(f))) : undefined;
        latest.current.seed({
          ...(linked?.text.trim() ? { text: linked.text, hidden: linked.hidden } : {}),
          ...(shared?.text ? { text: shared.text } : {}),
          ...(images?.length ? { images } : {}),
        });
        return;
      }
      await latest.current.newChat();
      // The new chat's composer, not the one it replaces, takes it: wait for it to mount.
      if (linked?.text.trim()) window.requestAnimationFrame(() => window.requestAnimationFrame(() => addLinkedPrompt(linked)));
      if (shared?.text) addToDraft(shared.text);
      if (shared?.images.length) addImagesToDraft(shared.images);
    })();
  }, [opts.booted, opts.ready, opts.hasChat]);
}
