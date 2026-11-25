import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardRest, placeCard } from "../../src/web/hover-card.js";

const rect = (left: number, top: number, width = 100, height = 20) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const view = { width: 1000, height: 700 };
const size = { width: 340, height: 200 };

describe("placeCard", () => {
  it("puts a right-side card beside the anchor, a little above its top", () => {
    expect(placeCard(rect(0, 300), size, view, "right")).toEqual({ left: 110, top: 294 });
  });

  it("keeps a right-side card inside the window at the bottom and the top", () => {
    expect(placeCard(rect(0, 650), size, view, "right").top).toBe(700 - 200 - 8);
    expect(placeCard(rect(0, 2), size, view, "right").top).toBe(8);
  });

  it("puts a below card under the anchor, left edges aligned", () => {
    expect(placeCard(rect(120, 100), size, view, "below")).toEqual({ left: 120, top: 126 });
  });

  it("flips a below card above the anchor when there is no room under", () => {
    expect(placeCard(rect(120, 600), size, view, "below")).toEqual({ left: 120, top: 600 - 200 - 6 });
  });

  it("slides a below card left when it would leave the window's right edge", () => {
    expect(placeCard(rect(900, 100), size, view, "below").left).toBe(1000 - 340 - 8);
  });
});

describe("cardRest", () => {
  const el = { getBoundingClientRect: () => rect(0, 300) } as unknown as Element;
  let open: (el: Element) => void;
  let close: () => void;
  let gate: ReturnType<typeof cardRest>;

  beforeEach(() => {
    vi.useFakeTimers();
    // The hook speaks to the window; in node there is none, and this file's timer is the only thing it uses.
    vi.stubGlobal("window", globalThis);
    open = vi.fn<(el: Element) => void>();
    close = vi.fn<() => void>();
    gate = cardRest(500, open, close);
  });

  afterEach(() => {
    // Anything a test pressed is left, so one test's hold cannot answer the next one's question.
    gate.leave();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a pressed row's card away in the row's new node: the switch a click starts redraws it", () => {
    const row = cardRest(500, open, close, "row-7");
    row.rest(el);
    vi.advanceTimersByTime(200);
    row.hold();
    expect(close).toHaveBeenCalledTimes(1);
    // The browser re-fires the pointer's enter on the replacement node, whose own hold has never seen a press.
    const replacement = cardRest(500, open, close, "row-7");
    replacement.rest(el);
    vi.advanceTimersByTime(2000);
    expect(open).not.toHaveBeenCalled();
    // Leaving it (in the new node) lets the card open again; a press nobody leaves lapses instead.
    replacement.leave();
    replacement.rest(el);
    vi.advanceTimersByTime(500);
    expect(open).toHaveBeenCalledTimes(1);
    replacement.hold();
    expect(close).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(4000);
    replacement.rest(el);
    vi.advanceTimersByTime(500);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("opens after the rest, and not before it", () => {
    gate.rest(el);
    vi.advanceTimersByTime(499);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledWith(el);
  });

  it("keeps the card away for the rest of the hover after a press, however often the pointer enters again", () => {
    gate.rest(el);
    vi.advanceTimersByTime(200);
    gate.hold();
    expect(close).toHaveBeenCalledTimes(1);
    // The browser re-fires an enter when the row is replaced under the pointer: it must not re-arm the wait.
    gate.rest(el);
    gate.rest(el);
    vi.advanceTimersByTime(2000);
    expect(open).not.toHaveBeenCalled();
    // Only leaving the row lets the next rest open it.
    gate.leave();
    gate.rest(el);
    vi.advanceTimersByTime(500);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("hides on a scroll without releasing a hold", () => {
    gate.hold();
    gate.clear();
    gate.rest(el);
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("forgets a rest that was replaced or left before it fired", () => {
    gate.rest(el);
    gate.rest(el);
    vi.advanceTimersByTime(500);
    expect(open).toHaveBeenCalledTimes(1);
    gate.leave();
    gate.rest(el);
    gate.leave();
    vi.advanceTimersByTime(1000);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
