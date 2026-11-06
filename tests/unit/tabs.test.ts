import { describe, expect, it } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { setPinned } from "../../src/web/tab-order.js";
import { closeTab, findTab, markUnread, NO_TABS, placeChat, placeTab, runningChats, syncActive, type Tab, type TabState } from "../../src/web/tabs.js";

const snap = (chatId: string, sessionId: string | null = `fake:${chatId}`, title = chatId) =>
  ({ chatId, sessionId, harnessId: "fake", workspace: { id: "w", path: "/p", name: "p" }, title }) as unknown as ChatSnapshot;
const ids = (s: TabState) => s.tabs.map((t) => t.chatId);

describe("session tabs", () => {
  it("opens the first chat as a tab, then shows others in the current tab unless asked for a new one", () => {
    let s = placeChat(NO_TABS, snap("a"));
    expect([ids(s), s.active]).toEqual([["a"], 0]);
    s = placeChat(s, snap("b"));
    expect([ids(s), s.active]).toEqual([["b"], 0]);
    s = placeChat(s, snap("c"), { newTab: true });
    expect([ids(s), s.active]).toEqual([["b", "c"], 1]);
    // A new tab goes right after the shown one.
    s = placeChat({ ...s, active: 0 }, snap("d"), { newTab: true });
    expect([ids(s), s.active]).toEqual([["b", "d", "c"], 1]);
  });

  it("places a chat in the background: the tab its key names, else a new one after the shown, and the view stays", () => {
    const key = "tmine";
    const tabOf = (chatId: string | null, k: string, title = chatId ?? "New chat"): Tab => ({ key: k, chatId, sessionId: chatId ? `fake:${chatId}` : null, harnessId: "fake", workspacePath: "/p", title });
    // The shown tab is "b" (active 1); the draft the start screen's send belongs to sits after it.
    const s: TabState = { tabs: [tabOf("a", "t0"), tabOf("b", "t1"), tabOf(null, key)], active: 1 };
    // The create landed after the user switched to b: the draft tab that sent it is
    // filled in, and the view stays on b.
    const landed = placeChat(s, snap("new", "fake:new", "Named"), { background: true, forKey: key });
    expect(ids(landed)).toEqual(["a", "b", "new"]);
    expect(landed.active).toBe(1);
    expect(landed.tabs[2]?.key).toBe(key);
    // Without a key of its own (a stale one, or no draft), a new tab after the shown one.
    const beside = placeChat(s, snap("new2", "fake:new2", "Other"), { background: true });
    expect(ids(beside)).toEqual(["a", "b", "new2", null]);
    expect(beside.active).toBe(1);
  });

  it("switches to the tab that already holds the chat or its session instead of opening it twice", () => {
    let s = placeChat(placeChat(NO_TABS, snap("a")), snap("b"), { newTab: true });
    s = placeChat(s, snap("a"), { newTab: true });
    expect([ids(s), s.active]).toEqual([["a", "b"], 0]);
    // The same session resumed as a new chat (after a server restart) lands in its old tab.
    const key = s.tabs[1]?.key;
    s = placeChat(s, snap("b2", "fake:b"));
    expect([ids(s), s.active, s.tabs[1]?.key]).toEqual([["a", "b2"], 1, key]);
    expect(findTab(s, { chatId: null, sessionId: "fake:a" })).toBe(0);
  });

  it("shows a session being opened in its tab at once, and its snapshot fills that same tab in", () => {
    const opening = { chatId: null, sessionId: "fake:b", harnessId: "fake", workspacePath: "/p", title: "b, from the list" };
    let s = placeTab(placeChat(NO_TABS, snap("a")), opening, { newTab: true });
    expect([ids(s), s.active, s.tabs[1]?.title]).toEqual([["a", null], 1, "b, from the list"]);
    const key = s.tabs[1]?.key;
    s = placeChat(s, snap("b"));
    expect([ids(s), s.active, s.tabs[1]?.key, s.tabs[1]?.title]).toEqual([["a", "b"], 1, key, "b"]);
    // Without newTab it takes over the shown tab, keeping that tab's key.
    const shown = placeChat(NO_TABS, snap("a"));
    const over = placeTab(shown, opening);
    expect([ids(over), over.tabs[0]?.key]).toEqual([[null], shown.tabs[0]?.key]);
  });

  it("closes a tab and hands the view to its right neighbour, else its left", () => {
    const three = placeChat(placeChat(placeChat(NO_TABS, snap("a")), snap("b"), { newTab: true }), snap("c"), { newTab: true });
    expect(ids(closeTab({ ...three, active: 1 }, 1))).toEqual(["a", "c"]);
    expect(closeTab({ ...three, active: 1 }, 1).active).toBe(1);
    expect(closeTab({ ...three, active: 2 }, 2).active).toBe(1);
    expect(closeTab({ ...three, active: 2 }, 0).active).toBe(1);
    expect(closeTab({ ...three, active: 0 }, 2).active).toBe(0);
    expect(closeTab(placeChat(NO_TABS, snap("a")), 0)).toEqual(NO_TABS);
  });

  it("keeps the shown tab's title and session in step with its chat", () => {
    const s = placeChat(NO_TABS, snap("a", null, "New chat"));
    const named = syncActive(s, snap("a", "fake:a1", "Fix the build"));
    expect(named.tabs[0]).toMatchObject({ chatId: "a", sessionId: "fake:a1", title: "Fix the build", key: s.tabs[0]?.key });
    expect(syncActive(named, snap("a", "fake:a1", "Fix the build"))).toBe(named);
    // Another chat (being swapped in) does not overwrite the tab.
    expect(syncActive(named, snap("zzz"))).toBe(named);
  });

  it("keeps a tab pinned through its chat's updates, and opens new tabs after the pinned ones", () => {
    let s = placeChat(placeChat(NO_TABS, snap("a")), snap("b"), { newTab: true });
    s = setPinned({ ...s, active: 0 }, 0, true);
    s = placeChat(s, snap("a", "fake:a1", "Named"));
    expect(s.tabs[0]).toMatchObject({ chatId: "a", pinned: true, title: "Named" });
    expect(syncActive(s, snap("a", "fake:a1", "Renamed")).tabs[0]?.pinned).toBe(true);
    // The pinned tab is shown, yet a new tab goes after the pinned group, not inside it.
    s = placeChat(s, snap("c"), { newTab: true });
    expect([ids(s), s.active]).toEqual([["a", "c", "b"], 1]);
    s = placeChat(setPinned({ ...s, active: 1 }, 1, true), snap("d"), { newTab: true });
    expect(ids(s)).toEqual(["a", "c", "d", "b"]);
  });

  it("marks a background tab whose run finished, never the shown one", () => {
    const s = placeChat(placeChat(NO_TABS, snap("a")), snap("b"), { newTab: true });
    const marked = markUnread(s, new Set(["a", "b"]));
    expect(marked.tabs.map((t) => Boolean(t.unread))).toEqual([true, false]);
    expect(markUnread(marked, new Set())).toBe(marked);
    // Showing it again clears the mark.
    expect(placeChat({ ...marked, active: 1 }, snap("a")).tabs[0]?.unread).toBeUndefined();
  });

  it("counts runs as running, not a harness that is starting", () => {
    expect([...runningChats([{ liveChatId: "a", status: "running" }, { liveChatId: "b", status: "starting" }, { liveChatId: "c", status: "compacting" }, { status: "running" }, { liveChatId: "d", status: "idle" }])]).toEqual(["a", "c"]);
  });
});
