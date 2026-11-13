// The notice stack: background notices ("finished", an undo for a mark change)
// stacked as cards, newest in front. Pure: ordering, the cap on what is drawn,
// merging a chat that finishes twice into one card, and per-toast deadlines that
// freeze while the pointer or focus is on the stack. ToastStack.tsx draws it and
// owns the one timer that calls `sweepToasts`.

/** How many cards are drawn; the rest are only counted ("+2"). */
export const MAX_VISIBLE = 3;
/** How long a dismissed card sinks before it is gone (matches styles/toasts.css). */
export const LEAVE_MS = 180;

export interface Toast {
  id: string;
  /** Notices with the same key are one card: a chat finishing twice, a second mark change replacing the first's undo. */
  key: string;
  text: string;
  /** How many notices this card stands for. */
  count: number;
  /** The chat's session, for a card that opens it. */
  sessionId?: string;
  /** An action shown as a button (Undo). */
  action?: { label: string; run: () => void };
  /** The card's meaning, for its 3 px rule and icon: finished, needs you, failed, or undo. */
  kind?: "ok" | "warn" | "danger" | "undo" | null;
  /** When it goes (ms clock); `null` while it is held. */
  deadline: number | null;
  /** The time left, kept while it is held. */
  left: number;
  /** Set when dismissed: it sinks for LEAVE_MS while the rest move up into its place. */
  leaving?: { slot: number };
}

export type ToastInput = Pick<Toast, "key" | "text" | "sessionId" | "action"> & { ms: number; kind?: "ok" | "warn" | "danger" | "undo" | null };

let counter = 0;

/** Add a notice in front. One with the same key merges into the card already there: it moves to the front, counts up, and its timer starts over. */
export function pushToast(stack: readonly Toast[], input: ToastInput, now: number, held = false): Toast[] {
  const same = stack.find((t) => t.key === input.key && !t.leaving);
  const toast: Toast = {
    id: same?.id ?? `toast-${++counter}`,
    key: input.key,
    text: input.text,
    count: (same?.count ?? 0) + 1,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    deadline: held ? null : now + input.ms,
    left: input.ms,
  };
  return [toast, ...stack.filter((t) => t !== same)];
}

/** Dismiss one: it starts to sink, remembering the slot it was drawn in. */
export function dismissToast(stack: readonly Toast[], id: string, now: number): Toast[] {
  const live = stack.filter((t) => !t.leaving);
  const slot = live.findIndex((t) => t.id === id);
  if (slot < 0) return stack.slice();
  return stack.map((t) => (t.id === id ? { ...t, deadline: now + LEAVE_MS, left: LEAVE_MS, leaving: { slot } } : t));
}

/** Freeze every timer (the pointer is on the stack, or focus is in it). A sinking card is not held. */
export function holdToasts(stack: readonly Toast[], now: number): Toast[] {
  return stack.map((t) => (t.leaving || t.deadline === null ? t : { ...t, left: Math.max(0, t.deadline - now), deadline: null }));
}

/** Let every timer run again from the time it had left. */
export function releaseToasts(stack: readonly Toast[], now: number): Toast[] {
  return stack.map((t) => (t.deadline === null ? { ...t, deadline: now + t.left } : t));
}

/** Drop what has run out (a sinking card included, once it has sunk). */
export function sweepToasts(stack: readonly Toast[], now: number): Toast[] {
  const kept = stack.filter((t) => t.deadline === null || t.deadline > now);
  return kept.length === stack.length ? (stack as Toast[]) : kept;
}

/** When the next timer ends, or null when none is running. */
export function nextDeadline(stack: readonly Toast[]): number | null {
  let next: number | null = null;
  for (const t of stack) if (t.deadline !== null && (next === null || t.deadline < next)) next = t.deadline;
  return next;
}

export interface Card {
  toast: Toast;
  /** 0 is the front. */
  slot: number;
}

export interface Layout {
  cards: Card[];
  /** Notices past the cap, for the "+N". */
  hidden: number;
}

/** What to draw: up to MAX_VISIBLE cards, newest first, plus any that are sinking in their old slot. */
export function layoutToasts(stack: readonly Toast[]): Layout {
  const live = stack.filter((t) => !t.leaving);
  const cards: Card[] = live.slice(0, MAX_VISIBLE).map((toast, slot) => ({ toast, slot }));
  for (const t of stack) if (t.leaving && t.leaving.slot < MAX_VISIBLE) cards.push({ toast: t, slot: t.leaving.slot });
  return { cards, hidden: Math.max(0, live.length - MAX_VISIBLE) };
}
