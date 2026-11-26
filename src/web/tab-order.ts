// The order of the tab strip: moving a tab, pinning it, and where a drag drops it.
// Pinned tabs always sit left of the rest, so every move stays inside its own group
// (a drag cannot carry a tab across the line; pinning is what crosses it). Pure; the
// strip draws a drag from these and App keeps the result in the tab state.
import type { Tab, TabState } from "./tabs.js";

/** Where a tab sat on screen when a drag began (px, in the strip's own coordinates). */
export interface TabRect {
  left: number;
  width: number;
}

/** How many tabs are pinned; since pinned tabs come first, also the index of the first unpinned one. */
export function pinnedCount(tabs: readonly Tab[]): number {
  return tabs.reduce((n, t) => n + (t.pinned ? 1 : 0), 0);
}

/** Pinned tabs first, each group in its own order: what a stored list becomes, so a stale or hand-edited one cannot break the rule. */
export function keepGroups(tabs: Tab[]): Tab[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

/** The first and last index of the group (pinned or not) the tab at `index` belongs to. */
export function groupRange(tabs: readonly Tab[], index: number): [number, number] {
  const p = pinnedCount(tabs);
  return tabs[index]?.pinned ? [0, p - 1] : [p, tabs.length - 1];
}

/** `tabs` with the one at `from` taken out and put in at `to`, with the shown tab still the same tab. */
function reorder(state: TabState, tabs: Tab[], from: number, to: number): TabState {
  const shown = state.tabs[state.active];
  const next = tabs.slice();
  const [tab] = next.splice(from, 1);
  if (!tab) return state;
  next.splice(to, 0, tab);
  // By key, not identity: pinning puts a new object in the shown tab's place.
  return { tabs: next, active: shown ? next.findIndex((t) => t.key === shown.key) : state.active };
}

/** Move the tab at `from` to `to`, kept inside its own group. The same state back when nothing would change. */
export function moveTab(state: TabState, from: number, to: number): TabState {
  if (from < 0 || from >= state.tabs.length) return state;
  const [lo, hi] = groupRange(state.tabs, from);
  const target = Math.max(lo, Math.min(hi, to));
  return target === from ? state : reorder(state, state.tabs, from, target);
}

/** Pin the tab (to the end of the pinned tabs) or unpin it (to the start of the others). */
export function setPinned(state: TabState, index: number, pinned: boolean): TabState {
  const tab = state.tabs[index];
  if (!tab || Boolean(tab.pinned) === pinned) return state;
  const p = pinnedCount(state.tabs);
  const tabs = state.tabs.slice();
  tabs[index] = pinned ? { ...tab, pinned: true } : { ...tab, pinned: undefined };
  return reorder(state, tabs, index, pinned ? p : p - 1);
}

/**
 * Where a dragged tab would land, as an index in the list: the number of the other tabs
 * of its group whose middle lies left of the dragged tab's middle, which sits `dx` px
 * from where it began. Clamped to the group, so a drag past the line stops at its edge.
 */
export function dropSlot(tabs: readonly Tab[], rects: readonly TabRect[], from: number, dx: number): number {
  const mine = rects[from];
  if (!mine) return from;
  const [lo, hi] = groupRange(tabs, from);
  const middle = mine.left + mine.width / 2 + dx;
  let slot = lo;
  for (let i = lo; i <= hi; i++) {
    const r = rects[i];
    if (i !== from && r && r.left + r.width / 2 < middle) slot++;
  }
  return Math.min(slot, hi);
}

/** The drag's offset kept far enough inside its group that its midpoint can pass a neighbour's, without crossing the group's far edge. */
export function clampDrag(tabs: readonly Tab[], rects: readonly TabRect[], from: number, dx: number): number {
  const mine = rects[from];
  const [lo, hi] = groupRange(tabs, from);
  const first = rects[lo];
  const last = rects[hi];
  if (!mine || !first || !last) return 0;
  const left = first.left + Math.min(first.width, mine.width) / 2 - mine.left - mine.width / 2;
  const right = last.left + last.width / 2 - mine.left - Math.min(last.width, mine.width) / 2;
  return Math.max(left, Math.min(right, dx));
}

/** Which way tab `i` slides while tab `from` is dragged to `to`: -1 left, 1 right, 0 stays (the dragged tab follows the pointer instead). */
export function slideOf(i: number, from: number, to: number): -1 | 0 | 1 {
  if (from < to && i > from && i <= to) return -1;
  if (to < from && i >= to && i < from) return 1;
  return 0;
}
