// The start screen's decisions, with no React: when a send can go, what it
// does instead when the setup is not there (a folder to ask for, a harness to
// wait on), and the words on it. Keep them here (with a unit test) and the
// component that draws the screen stays thin.
import { projectScoped } from "./harness-policy.js";

export interface HarnessOf {
  id: string;
  displayName: string;
  available: boolean;
  reason?: string | null;
  /** The capability bits the start screen's decisions read; missing bits read as an ordinary coding harness. */
  capabilities?: { supportsProjectFolders: boolean; webOnly: boolean };
}

export interface StartSetup {
  /** Every harness the server knows, available or not (their blocked reasons come from `reason`). */
  harnesses: HarnessOf[];
  /** The chosen harness, or null when none exists at all. */
  harnessId: string | null;
  /** The chosen folder's name, or null when none is chosen. */
  workspaceName: string | null;
  /** The draft in the box, not trimmed. */
  draft: string;
  /** A share or prompt link attached images; those go through the old "chat at once" path. */
  images: number;
  /** A send is already in flight. */
  busy: boolean;
}

export type StartAction =
  | { kind: "send" }
  | { kind: "pick-folder" }
  | { kind: "blocked"; reason: string };

/** The question above the box: no folder asks what to work on, the Awui harness asks anything.
 * `before`/`after` bracket the folder's name so the screen can colour it without searching for it. */
export function startHeading(s: StartSetup): { title: string; before: string; project: string | null; after: string } {
  const name = s.harnesses.find((h) => h.id === s.harnessId)?.displayName ?? "the agent";
  if (s.harnessId === "awui") return { title: "Ask anything", before: "Ask anything", project: null, after: "" };
  if (s.workspaceName) return { title: `What should ${name} do in ${s.workspaceName}?`, before: `What should ${name} do in `, project: s.workspaceName, after: "?" };
  return { title: `What should ${name} work on?`, before: `What should ${name} work on?`, project: null, after: "" };
}

/** Three things to try, by harness: the start screen's only suggestions. */
export function startExamples(harnessId: string | null): string[] {
  if (harnessId === "awui") return ["Summarise what this project does", "Find where a setting is read", "Explain one tricky function"];
  return ["Explain this project's structure", "Review the last change and list risks", "Find a bug and write a failing test"];
}

/** What the Send button says is wrong, or null when it can send (used for its accessible name and disabled look). */
export function startSendBlocked(s: StartSetup): string | null {
  if (s.busy) return "Starting the chat…";
  const current = s.harnesses.find((h) => h.id === s.harnessId);
  if (!current) return "No harness is available.";
  if (!current.available) return current.reason ?? `${current.displayName} is not installed.`;
  if (s.images === 0 && !s.draft.trim()) return "Type a message first";
  return null;
}

/**
 * What a send does: with no folder, ask for one (the draft stays); else
 * create the chat and send the message (any attached images go with it).
 */
export function startAction(s: StartSetup): StartAction {
  const blocked = startSendBlocked(s);
  if (blocked) return { kind: "blocked", reason: blocked };
  // A projectless surface (the awui harness) sends without asking for a folder.
  if (projectScoped(s.harnesses, s.harnessId ?? "") && !s.workspaceName) return { kind: "pick-folder" };
  return { kind: "send" };
}

/** Recent folders for the chip's menu, newest first, without the one already chosen. */
export function recentForChip(recent: ReadonlyArray<string>, currentPath: string | null, limit = 6): string[] {
  return recent.filter((p) => p !== currentPath).slice(0, limit);
}

/** The setup for the decisions above, as the screen holds it. */
export function startSetup(harnesses: HarnessOf[], harnessId: string | null, workspaceName: string | null, draft: string, images: number, busy: boolean): StartSetup {
  return { harnesses, harnessId, workspaceName, draft, images, busy };
}

