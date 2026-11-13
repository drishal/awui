// The chat's replayable event stream: a snapshot replaces what came before it,
// so the log never holds more than one full copy of the chat.
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatSnapshot } from "../../src/shared/protocol.js";
import { EventLog } from "../../src/server/chats/chat.js";

const snap = { items: [] } as unknown as ChatSnapshot;
const status = (s: "idle" | "running"): ChatEvent => ({ type: "status", status: s });

function stream(log: EventLog, lastEventId: number | undefined) {
  const got: Array<[number, string]> = [];
  log.subscribe({ send: (id, event) => got.push([id, event.type]), close: () => undefined }, lastEventId, () => snap);
  return got;
}

describe("the event log", () => {
  it("replays what a reconnecting stream missed", () => {
    const log = new EventLog();
    log.record(status("running"));
    log.record(status("idle"));
    expect(stream(log, 1)).toEqual([[2, "status"]]);
  });

  it("keeps only the newest snapshot and what follows it", () => {
    const log = new EventLog();
    log.record(status("running"));
    log.record({ type: "snapshot", snapshot: snap });
    log.record(status("idle"));
    log.record({ type: "snapshot", snapshot: snap });
    log.record(status("running"));
    // Just behind the newest snapshot: it and what follows are replayed.
    expect(stream(log, 3)).toEqual([
      [4, "snapshot"],
      [5, "status"],
    ]);
    // Further behind: one fresh snapshot, which carries the same state.
    expect(stream(log, 1)).toEqual([[5, "snapshot"]]);
  });

  it("serializes a live event once, however many viewers watch the chat", () => {
    const log = new EventLog();
    const frames: string[] = [];
    let stringified = 0;
    const event: ChatEvent = { type: "status", status: "running" };
    const spy = { ...event, toJSON() { stringified += 1; return { type: "status", status: "running" }; } } as unknown as ChatEvent;
    for (let i = 0; i < 4; i += 1) log.subscribe({ send: (_id, _e, json) => frames.push(json()), close: () => undefined }, undefined, () => snap);
    frames.length = 0;
    log.record(spy);
    expect(frames).toHaveLength(4);
    expect(new Set(frames).size).toBe(1);
    expect(JSON.parse(frames[0] as string)).toEqual(event);
    expect(stringified).toBe(1);
  });
});
