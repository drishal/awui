import { describe, expect, it } from "vitest";
import { SessionMarks } from "../../src/server/session-marks.js";
import { asHarnessId, type ProjectSession, type SessionsOverview } from "../../src/shared/protocol.js";
import { focusProject, groupByProject, placeOf, sidebarSections, snoozeInputAt, snoozeInputDefault, snoozeOptions } from "../../src/web/session-groups.js";

describe("session marks", () => {
  it("keeps a session in one place: pin, archive, settle, and snooze each clear the others", async () => {
    const m = SessionMarks.inMemory();
    expect(await m.set("s", { pinned: true })).toEqual({ pinned: true });
    expect(await m.set("s", { settled: true })).toEqual({ settled: true });
    expect(await m.set("s", { snoozedUntil: 5000 })).toEqual({ snoozedUntil: 5000 });
    expect(await m.set("s", { archived: true })).toEqual({ archived: true });
    expect(await m.set("s", { pinned: true, replace: true })).toEqual({ pinned: true });
    expect(await m.set("s", { replace: true })).toEqual({});
    expect(m.get("s")).toBeUndefined();
  });

  it("keeps unread beside a place, and clears it without moving the session", async () => {
    const m = SessionMarks.inMemory();
    await m.set("a", { pinned: true });
    expect(await m.set("a", { unread: true })).toEqual({ pinned: true, unread: true });
    expect(m.get("a")).toEqual({ pinned: true, unread: true });
    // Reading it leaves the pin where it was.
    expect(await m.set("a", { unread: false })).toEqual({ pinned: true });
    // Activity clears settled/snoozed but not unread.
    await m.set("b", { snoozedUntil: 9e12, unread: true });
    m.wake("b");
    await new Promise((r) => setTimeout(r, 5));
    expect(m.get("b")).toEqual({ unread: true });
    // A selection clears in one call.
    await m.setMany(["c", "d"], { unread: true });
    await m.setMany(["c", "d"], { unread: false });
    expect([m.get("c"), m.get("d")]).toEqual([undefined, undefined]);
  });

  it("applies one change to a selection, and clears the selection in one go", async () => {
    const m = SessionMarks.inMemory();
    await m.set("a", { pinned: true });
    await m.set("b", { snoozedUntil: 9e12 });
    expect(await m.setMany(["a", "b", "c"], { settled: true })).toEqual({ a: { settled: true }, b: { settled: true }, c: { settled: true } });
    expect(["a", "b", "c"].map((id) => m.get(id))).toEqual([{ settled: true }, { settled: true }, { settled: true }]);
    // replace clears the whole selection, which is its undo.
    await m.setMany(["a", "b", "c"], { replace: true });
    expect(["a", "b", "c"].map((id) => m.get(id))).toEqual([undefined, undefined, undefined]);
  });

  it("remembers how a session began, and keeps it through a place, an undo, and a wake", async () => {
    const m = SessionMarks.inMemory();
    expect(await m.setOrigin("r", "routine")).toEqual({ origin: "routine" });
    // A place sits beside the origin; an undo replaces the place, not where it came from.
    expect(await m.set("r", { settled: true })).toEqual({ settled: true, origin: "routine" });
    expect(await m.set("r", { replace: true })).toEqual({ origin: "routine" });
    await m.set("r", { snoozedUntil: 9e12 });
    m.wake("r");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(m.get("r")).toEqual({ origin: "routine" });
  });

  it("wakes a settled or snoozed session, and leaves pins alone", async () => {
    const m = SessionMarks.inMemory();
    await m.set("a", { settled: true });
    await m.set("b", { snoozedUntil: 9e12 });
    await m.set("c", { pinned: true });
    for (const id of ["a", "b", "c"]) m.wake(id);
    await new Promise((r) => setTimeout(r, 5));
    expect([m.get("a"), m.get("b"), m.get("c")]).toEqual([undefined, undefined, { pinned: true }]);
  });
});

describe("the sidebar's places", () => {
  const s = (id: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({ id, harnessId: asHarnessId("pi"), title: id, updatedAt: "2026-10-08T10:00:00Z", workspaceId: "w", ...extra });
  const now = 1_000_000;
  const overview: SessionsOverview = {
    workspaces: [{ id: "w", path: "/w", name: "w" }],
    sessions: [
      s("asks", { liveChatId: "c1", status: "running", asking: true }),
      s("busy", { liveChatId: "c2", status: "running" }),
      s("open", { liveChatId: "c3", status: "running" }),
      s("pin", { pinned: true }),
      s("done", { settled: true }),
      s("later", { snoozedUntil: now + 1 }),
      s("woke", { snoozedUntil: now - 1 }),
      s("old", { archived: true }),
      s("plain"),
    ],
    errors: [],
  };
  const opts = { currentId: "w", query: "", harnessId: "pi", now, isActive: (x: ProjectSession) => x.id === "open" };

  it("puts what needs you and what works above the pins, and keeps the open chat in its project", () => {
    expect(overview.sessions.map((x) => placeOf(x, opts))).toEqual(["needs", "working", "project", "pinned", "settled", "snoozed", "project", "archived", "project"]);
    const sections = sidebarSections(overview, opts);
    expect([sections.needs, sections.working, sections.pinned].map((l) => l.map((x) => x.id))).toEqual([["asks"], ["busy"], ["pin"]]);
    expect(sections.counts).toEqual({ snoozed: 1, settled: 1, archived: 1 });
    expect(groupByProject(overview, opts)[0]?.sessions.map((x) => x.id)).toEqual(["open", "woke", "plain"]);
    expect(groupByProject(overview, { ...opts, showSettled: true, showSnoozed: true })[0]?.sessions.map((x) => x.id)).toEqual(["open", "done", "later", "woke", "plain"]);
  });

  it("reads a picked snooze time, and refuses one that has passed", () => {
    const now = new Date(2026, 9, 9, 15, 30).getTime();
    expect(snoozeInputDefault(now)).toBe("2026-10-10T09:00");
    expect(snoozeInputAt("2026-10-10T09:00", now)).toBe(new Date(2026, 9, 10, 9, 0).getTime());
    expect(snoozeInputAt("2026-10-09T15:29", now)).toBeNull();
    expect(snoozeInputAt("", now)).toBeNull();
    expect(snoozeInputAt("tomorrow", now)).toBeNull();
  });

  it("the focused folder shows settled, snoozed, and archived rows when their toggles are on", () => {
    const shown = { ...opts, showSettled: true, showSnoozed: true, showArchived: true };
    const ids = (focused: ReturnType<typeof focusProject>) => (focused?.sections ?? []).flatMap((section) => section.sessions.map((x) => x.id));
    expect(ids(focusProject(overview, "w", shown))).toEqual(expect.arrayContaining(["done", "later", "old", "plain"]));
    // Needs you, Working, and Pinned keep their own sections above.
    expect(ids(focusProject(overview, "w", shown))).toEqual(expect.not.arrayContaining(["asks", "busy", "pin"]));
    // And they stay out of the date list until their toggle is on.
    expect(ids(focusProject(overview, "w", opts))).not.toContain("later");
  });

  it("offers an hour, tomorrow at 9, and next Monday at 9", () => {
    const friday = new Date(2026, 9, 9, 15, 30).getTime();
    const [hour, tomorrow, week] = snoozeOptions(friday);
    expect(hour?.until).toBe(friday + 3_600_000);
    expect(new Date(tomorrow?.until ?? 0).toString()).toContain("Sat Oct 10 2026 09:00");
    expect(new Date(week?.until ?? 0).toString()).toContain("Mon Oct 12 2026 09:00");
  });
});
