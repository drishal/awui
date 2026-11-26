import { afterEach, describe, expect, it, vi } from "vitest";
import { clampDrag, dropSlot, groupRange, keepGroups, moveTab, pinnedCount, setPinned, slideOf, type TabRect } from "../../src/web/tab-order.js";
import { loadTabs, saveTabs, type Tab, type TabState } from "../../src/web/tabs.js";

const tab = (key: string, pinned = false): Tab => ({ key, chatId: key, sessionId: `fake:${key}`, harnessId: "fake", workspacePath: "/p", title: key, ...(pinned ? { pinned } : {}) });
const state = (keys: string, active = 0): TabState => ({ tabs: keys.split(" ").map((k) => tab(k.replace("*", ""), k.endsWith("*"))), active });
/** A state as "a* b c": the order, with * on pinned tabs. */
const show = (s: TabState) => s.tabs.map((t) => t.key + (t.pinned ? "*" : "")).join(" ");

describe("tab order", () => {
  it("moves a tab and keeps the shown tab the same tab", () => {
    const s = moveTab(state("a b c", 1), 2, 0);
    expect(show(s)).toBe("c a b");
    expect(s.active).toBe(2);
    // The moved tab itself being shown.
    expect(moveTab(state("a b c", 2), 2, 0).active).toBe(0);
    expect(show(moveTab(state("a b c"), 0, 1))).toBe("b a c");
  });

  it("does nothing for a move that changes nothing, or a tab that is not there", () => {
    const s = state("a b c");
    expect(moveTab(s, 1, 1)).toBe(s);
    expect(moveTab(s, 5, 0)).toBe(s);
    expect(moveTab(s, -1, 0)).toBe(s);
    expect(moveTab(s, 2, 9)).toBe(s);
  });

  it("keeps pinned and unpinned tabs apart: a move stops at the edge of its group", () => {
    const s = state("a* b* c d");
    expect(groupRange(s.tabs, 0)).toEqual([0, 1]);
    expect(groupRange(s.tabs, 3)).toEqual([2, 3]);
    expect(show(moveTab(s, 3, 0))).toBe("a* b* d c");
    expect(show(moveTab(s, 0, 3))).toBe("b* a* c d");
    expect(moveTab(s, 2, 1)).toBe(s);
    expect(moveTab(s, 1, 2)).toBe(s);
  });

  it("pins a tab to the end of the pinned ones, and unpins it to the start of the others", () => {
    let s = setPinned(state("a b c d", 3), 2, true);
    expect(show(s)).toBe("c* a b d");
    expect(s.active).toBe(3);
    s = setPinned(s, 2, true);
    expect(show(s)).toBe("c* b* a d");
    s = setPinned(s, 0, false);
    expect(show(s)).toBe("b* c a d");
    expect(s.tabs[1]?.pinned).toBeFalsy();
    expect(pinnedCount(s.tabs)).toBe(1);
    // Already as asked: the same state.
    expect(setPinned(s, 0, true)).toBe(s);
    expect(setPinned(s, 2, false)).toBe(s);
    expect(setPinned(s, 9, true)).toBe(s);
  });

  it("puts pinned tabs first in a stored list, each group in its order", () => {
    expect(keepGroups(state("a b* c d*").tabs).map((t) => t.key)).toEqual(["b", "d", "a", "c"]);
  });

  describe("a drag", () => {
    // Four tabs 100 px wide side by side, the first two pinned and 60 px wide: a* b* | c d.
    const s = state("a* b* c d");
    const rects: TabRect[] = [
      { left: 0, width: 60 },
      { left: 60, width: 60 },
      { left: 120, width: 100 },
      { left: 220, width: 100 },
    ];

    it("drops where the lifted tab's middle has passed the others' middles", () => {
      expect(dropSlot(s.tabs, rects, 3, 0)).toBe(3);
      expect(dropSlot(s.tabs, rects, 3, -40)).toBe(3);
      expect(dropSlot(s.tabs, rects, 3, -110)).toBe(2);
      expect(dropSlot(s.tabs, rects, 2, 110)).toBe(3);
      expect(dropSlot(s.tabs, rects, 0, 70)).toBe(1);
      expect(dropSlot(s.tabs, rects, 0, 10)).toBe(0);
    });

    it("stops at the group's edge, with enough midpoint overlap to reach each end", () => {
      expect(dropSlot(s.tabs, rects, 3, -1000)).toBe(2);
      expect(dropSlot(s.tabs, rects, 0, 1000)).toBe(1);
      expect(clampDrag(s.tabs, rects, 3, -1000)).toBe(-100);
      expect(clampDrag(s.tabs, rects, 2, 1000)).toBe(100);
      expect(clampDrag(s.tabs, rects, 0, -50)).toBe(0);
      expect(clampDrag(s.tabs, rects, 0, 1000)).toBe(60);
      expect(dropSlot(s.tabs, rects, 2, 120)).toBe(3);
      expect(dropSlot(s.tabs, rects, 3, -60)).toBe(3);
    });

    it("allows unequal width tabs to reach the same group's end", () => {
      const unequal: TabRect[] = [{ left: 0, width: 150 }, { left: 150, width: 330 }];
      expect(clampDrag(state("c d").tabs, unequal, 1, -240)).toBe(-240);
      expect(dropSlot(state("c d").tabs, unequal, 1, -240)).toBe(0);
    });

    it("slides the tabs it passes aside, toward the gap it leaves", () => {
      expect([0, 1, 2, 3].map((i) => slideOf(i, 3, 1))).toEqual([0, 1, 1, 0]);
      expect([0, 1, 2, 3].map((i) => slideOf(i, 0, 2))).toEqual([0, -1, -1, 0]);
      expect([0, 1, 2, 3].map((i) => slideOf(i, 2, 2))).toEqual([0, 0, 0, 0]);
    });
  });
});

describe("tabs kept per device", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  afterEach(() => store.clear());

  it("brings back the order and the pins, with the shown tab the same tab", () => {
    saveTabs(setPinned(moveTab(state("a b c d", 3), 3, 0), 3, true));
    const back = loadTabs();
    expect(show(back)).toBe("c* d a b");
    expect(back.tabs[back.active]?.key).toBe("d");
  });

  it("reads a list stored with a pinned tab out of place as pinned first", () => {
    store.set("awui.tabs.v1", JSON.stringify({ tabs: state("a b* c").tabs, active: 2 }));
    const back = loadTabs();
    expect(show(back)).toBe("b* a c");
    expect(back.tabs[back.active]?.key).toBe("c");
    // Tabs stored before pinning existed have no pins.
    store.set("awui.tabs.v1", JSON.stringify({ tabs: [{ key: "x", chatId: null, sessionId: null, harnessId: "fake", workspacePath: "/p", title: "x" }], active: 0 }));
    expect(loadTabs().tabs[0]?.pinned).toBeUndefined();
  });
});

describe("pinning the shown tab", () => {
  it("keeps it shown, though pinning puts a new object in its place", () => {
    const pinned = setPinned(state("a b c", 2), 2, true);
    expect(pinned.tabs.map((t) => t.key)).toEqual(["c", "a", "b"]);
    expect(pinned.active).toBe(0);
    const unpinned = setPinned(pinned, 0, false);
    expect(unpinned.tabs[unpinned.active]?.key).toBe("c");
  });
});
