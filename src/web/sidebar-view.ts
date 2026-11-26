// How the sidebar lists sessions, kept in this browser: "recent" is one flat list across projects (newest and
// most urgent first, each row carrying its project as a tag: T3 Code's and Codex's shape), "projects" is the list
// grouped by folder with the focus-after-current behaviour. Several places read it (the list, the filter menu that
// switches it, the row that shows or hides its project tag), so it is a small shared store: one value, one
// subscription, written through storage.ts. Pure of React except the hook at the bottom.
import { useSyncExternalStore } from "react";
import { load, save } from "./storage.js";

export type SidebarView = "recent" | "projects";

const KEY = "sidebarView";
const listeners = new Set<() => void>();

/** The saved view, "recent" until a person picks otherwise (anything else saved is ignored). */
export function readSidebarView(): SidebarView {
  return load<string>(KEY, "recent") === "projects" ? "projects" : "recent";
}

/** Remember the view and tell every reader in this tab. Switching back to the default clears the key. */
export function writeSidebarView(view: SidebarView): void {
  save(KEY, view === "recent" ? "" : view);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed it: the storage event carries the key, with the prefix.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === `awui.${KEY}`) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** [the view, a setter], re-rendering when either this tab or another one changes it. */
export function useSidebarView(): [SidebarView, (view: SidebarView) => void] {
  const view = useSyncExternalStore(subscribe, readSidebarView, () => "recent" as SidebarView);
  return [view, writeSidebarView];
}
