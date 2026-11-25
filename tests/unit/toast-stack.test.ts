import { describe, expect, it } from "vitest";
import { DOCK_GAP, dismissToast, holdToasts, layoutToasts, LEAVE_MS, MIN_FROM_BOTTOM, nextDeadline, pushToast, releaseToasts, stackInset, stackOffset, sweepToasts, type Toast } from "../../src/web/toast-stack.js";

const add = (stack: Toast[], key: string, now = 0, ms = 1000) => pushToast(stack, { key, text: key, ms }, now);

describe("toast stack", () => {
  it("puts the newest in front and draws three, counting the rest", () => {
    let s: Toast[] = [];
    for (const k of ["a", "b", "c", "d", "e"]) s = add(s, k);
    const { cards, hidden } = layoutToasts(s);
    expect(cards.map((c) => [c.toast.key, c.slot])).toEqual([["e", 0], ["d", 1], ["c", 2]]);
    expect(hidden).toBe(2);
  });

  it("merges a repeat for the same key into one card in front", () => {
    let s = add([], "chat:1", 0);
    s = add(s, "chat:2", 10);
    s = add(s, "chat:1", 500);
    expect(s.map((t) => [t.key, t.count])).toEqual([["chat:1", 2], ["chat:2", 1]]);
    expect(s[0]?.deadline).toBe(1500);
  });

  it("freezes timers while held and resumes with the time left", () => {
    let s = add([], "a", 0, 1000);
    s = holdToasts(s, 400);
    expect(s[0]).toMatchObject({ deadline: null, left: 600 });
    expect(sweepToasts(s, 99999)).toHaveLength(1);
    s = releaseToasts(s, 5000);
    expect(s[0]?.deadline).toBe(5600);
    expect(nextDeadline(s)).toBe(5600);
    expect(sweepToasts(s, 5599)).toHaveLength(1);
    expect(sweepToasts(s, 5600)).toHaveLength(0);
  });

  it("sinks a dismissed card in its slot while the rest move up, then removes it", () => {
    let s: Toast[] = [];
    for (const k of ["a", "b", "c"]) s = add(s, k);
    const b = s.find((t) => t.key === "b") as Toast;
    s = dismissToast(s, b.id, 100);
    const { cards } = layoutToasts(s);
    expect(cards.filter((c) => !c.toast.leaving).map((c) => [c.toast.key, c.slot])).toEqual([["c", 0], ["a", 1]]);
    expect(cards.find((c) => c.toast.leaving)?.slot).toBe(1);
    expect(sweepToasts(s, 100 + LEAVE_MS).map((t) => t.key)).toEqual(["c", "a"]);
  });

  it("docks 12 px above the topmost thing the notice must clear, and never off the screen", () => {
    // A 844 px phone, the dock's top edge at 594: the stack's bottom sits 12 px above it.
    expect(stackOffset(844, 594, 0)).toBe(844 - 594 + DOCK_GAP);
    // Cards behind hang below the front one, so the stack's own box moves up by the same amount.
    expect(stackOffset(844, 594, 14)).toBe(844 - 594 + 14 + DOCK_GAP);
    // A tall dock (an approval card's whole sheet) keeps the stack on the screen.
    expect(stackOffset(844, 830, 0)).toBe(MIN_FROM_BOTTOM);
  });

  it("keeps its lane clear of the context rail's measured width", () => {
    expect(stackInset(0)).toBe(DOCK_GAP + 4);
    expect(stackInset(40)).toBe(DOCK_GAP + 4 + 40);
    expect(stackInset(272)).toBe(DOCK_GAP + 4 + 272);
  });

  it("does not hold a sinking card, and a new notice of its key starts a fresh card", () => {
    let s = add([], "a", 0);
    s = dismissToast(s, (s[0] as Toast).id, 0);
    expect(holdToasts(s, 10)[0]?.deadline).toBe(LEAVE_MS);
    s = add(s, "a", 20);
    expect(s).toHaveLength(2);
    expect(s[0]?.count).toBe(1);
  });
});
