import { describe, expect, it } from "vitest";
import type { AssistantItem, ChatItem, ToolItem } from "../../src/shared/protocol.js";
import { buildTurns } from "../../src/web/turns.js";
import { phaseDelay, waitingOnYou, workingPhase } from "../../src/web/working-phase.js";

const user: ChatItem = { kind: "user", id: "u", text: "go", at: 1 };
const assistant = (over: Partial<AssistantItem>): AssistantItem => ({ kind: "assistant", id: `a${Math.random()}`, text: "", thinking: "", streaming: true, ...over }) as AssistantItem;
const bash = (status: ToolItem["status"], command: string): ToolItem => ({ kind: "tool", id: `t${command}`, name: "bash", args: JSON.stringify({ command }), status, output: "", truncated: false, category: "command", summary: command, paths: [] });
const phase = (items: ChatItem[]) => workingPhase(buildTurns([user, ...items], "running")[0]!, "/p");

describe("workingPhase", () => {
  it("is Working before anything is known", () => {
    expect(phase([])).toBe("Working");
  });
  it("is Thinking while thoughts stream", () => {
    expect(phase([assistant({ thinking: "Let me look" })])).toBe("Thinking");
  });
  it("is the running call's sentence", () => {
    expect(phase([assistant({ streaming: false, thinking: "x" }), bash("running", "npm test")])).toBe("Running npm test");
  });
  it("names the newest of several running calls, and skips finished ones", () => {
    expect(phase([bash("done", "ls"), bash("running", "npm run lint"), bash("running", "npm test")])).toBe("Running npm test");
    expect(phase([bash("done", "ls"), assistant({ streaming: false })])).toBe("Working");
  });
  it("is Writing once the answer streams", () => {
    expect(phase([bash("done", "ls"), assistant({ text: "Here is" })])).toBe("Writing");
  });
  it("is Waiting for you while a request is unanswered, whatever else the run is doing", () => {
    const request = (outcome?: string): ChatItem => ({
      kind: "request",
      id: "r1",
      request: { id: "req1", kind: "confirm", title: "Allow tool: read", createdAt: 1 },
      ...(outcome ? { outcome } : {}),
    });
    expect(phase([request()])).toBe("Waiting for you");
    // A call left running behind the question does not outshout the person it waits on.
    expect(phase([bash("running", "npm test"), request()])).toBe("Waiting for you");
    // Answered, the row is a record: the phase is the run's own words again.
    expect(phase([request("Approved")])).toBe("Working");
  });
  it("waitingOnYou is the same question the phase asks, for the fold's mark", () => {
    const request = (outcome?: string): ChatItem => ({
      kind: "request",
      id: "r1",
      request: { id: "req1", kind: "confirm", title: "Allow tool: read", createdAt: 1 },
      ...(outcome ? { outcome } : {}),
    });
    const turn = (items: ChatItem[]) => buildTurns([user, ...items], "running")[0]!;
    expect(waitingOnYou(turn([bash("running", "npm test"), request()]))).toBe(true);
    expect(waitingOnYou(turn([request("Approved")]))).toBe(false);
    expect(waitingOnYou(turn([bash("running", "npm test")]))).toBe(false);
  });
});

describe("phaseDelay", () => {
  it("shows the first change at once, then holds the rest of the interval", () => {
    expect(phaseDelay(0, 5000)).toBe(0);
    expect(phaseDelay(1000, 1200)).toBe(400);
    expect(phaseDelay(1000, 1700)).toBe(0);
  });
});
