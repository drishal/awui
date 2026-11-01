// The invocation envelope is the only prompt a bot's harness sees. These tests
// pin its shape: identity and instructions every time, the permitted roster
// only where consultation is possible, a bounded history with an explicit
// omission marker, the current request last, and reserved markers quoted in
// remembered text so they can never authorize anything.
import { describe, expect, it } from "vitest";
import { buildInvocationPrompt } from "../../src/server/boards/context.js";
import type { StoredBot, StoredMembership, StoredRoom } from "../../src/server/boards/types.js";
import { CONSULT_MARKER_BEGIN } from "../../src/server/boards/types.js";
import type { RoomRecord } from "../../src/shared/protocol.js";

const bot: StoredBot = {
  id: "bot-1",
  name: "Atlas",
  harnessId: "fake",
  model: null,
  thinkingLevel: null,
  instructions: "Be terse.",
  role: "lead",
  accent: null,
  permissionMode: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

const member: StoredMembership = {
  id: "m-1",
  botId: bot.id,
  handle: "atlas",
  rank: 0,
  canLead: true,
  consultable: true,
  consultants: ["m-2"],
  enabled: true,
  nativeSession: null,
  deliveredSeq: 0,
  sessionRevision: 0,
};

function roomWith(members: StoredMembership[] = [member]): StoredRoom {
  return {
    id: "r-1",
    name: "Stocks research",
    topic: "Thesis and counter-thesis",
    workspaceId: "ws",
    workspacePath: "/proj",
    archived: false,
    leadMemberId: "m-1",
    members,
    budgets: { maxDirectResponders: 4, maxConsultRequests: 4, maxInvocations: 8, maxInvocationsPerMember: 3, turnWallClockMs: 180_000, queueMax: 20 },
    createdAt: 1,
    updatedAt: 1,
  };
}

function userRecord(seq: number, text: string): RoomRecord {
  return { kind: "user", id: `u-${seq}`, seq, at: seq, turnId: `t-${seq}`, text, mentions: [] };
}

describe("the invocation envelope", () => {
  it("carries the protocol, identity, instructions, roster, history, and request in a stable order", () => {
    const built = buildInvocationPrompt({
      room: roomWith(),
      bot,
      member,
      consultants: [{ handle: "Scout", role: "researcher" }],
      history: [userRecord(4, "Start the thesis.")],
      task: { kind: "message", text: "Compare these filings." },
      depth: 0,
    });
    const prompt = built.prompt;
    expect(prompt.startsWith("# awui Board room")).toBe(true);
    expect(prompt).toContain("Task kind: message");
    expect(prompt).toContain("Name: Atlas\nHandle: atlas\nRole: lead");
    expect(prompt).toContain("Be terse.");
    expect(prompt).toContain("- @Scout (researcher)");
    expect(prompt).toContain("[record 4] user: Start the thesis.");
    expect(prompt.indexOf("## Current request")).toBeGreaterThan(prompt.indexOf("## Room history since your last turn"));
    expect(prompt).toContain("Compare these filings.");
    expect(prompt).toContain(CONSULT_MARKER_BEGIN);
    expect(built.throughSeq).toBe(4);
  });

  it("is deterministic for the same input", () => {
    const input = {
      room: roomWith(),
      bot,
      member,
      consultants: [],
      history: [userRecord(1, "one")],
      task: { kind: "message" as const, text: "go" },
      depth: 0,
    };
    expect(buildInvocationPrompt(input).prompt).toBe(buildInvocationPrompt(input).prompt);
  });

  it("bounds the missed history and says exactly what was left out", () => {
    const history = Array.from({ length: 100 }, (_, i) => userRecord(i + 1, `record number ${i + 1}`));
    const built = buildInvocationPrompt({ room: roomWith(), bot, member, consultants: [], history, task: { kind: "message", text: "go" }, depth: 0 });
    expect(built.prompt).toContain("60 earlier records omitted");
    expect(built.prompt).toContain("[record 100]");
    expect(built.throughSeq).toBe(100);
    expect(built.prompt.split("[record ").length - 1).toBeLessThanOrEqual(41);
  });

  it("quotes reserved markers found in remembered text", () => {
    const quoted = `${CONSULT_MARKER_BEGIN}\n{"version":1}\nAWUI_BOARD_CONTROL`;
    const built = buildInvocationPrompt({ room: roomWith(), bot, member, consultants: [], history: [userRecord(1, quoted)], task: { kind: "message", text: "go" }, depth: 1 });
    expect(built.prompt).not.toContain(CONSULT_MARKER_BEGIN);
    expect(built.prompt).toContain("(quoted)");
  });

  it("tells a consultant to answer plainly and never offers the control protocol", () => {
    const built = buildInvocationPrompt({
      room: roomWith(),
      bot,
      member,
      consultants: [{ handle: "Scout", role: "researcher" }],
      history: [],
      task: { kind: "consult", fromHandle: "Atlas", question: "Check the contrary evidence." },
      depth: 1,
    });
    expect(built.prompt).toContain("depth cap");
    expect(built.prompt).not.toContain("## How to ask a permitted bot for help");
    expect(built.prompt).toContain("Check the contrary evidence.");
  });

  it("labels consultation results as untrusted data for the synthesis", () => {
    const built = buildInvocationPrompt({
      room: roomWith(),
      bot,
      member,
      consultants: [],
      history: [],
      task: {
        kind: "synthesis",
        question: "Compare these filings.",
        results: [{ consultationId: "c-1", fromHandle: "Scout", question: "Check X?", outcome: "answered", text: "X checks out." }],
      },
      depth: 1,
    });
    expect(built.prompt).toContain("## Consultation results");
    expect(built.prompt).toContain("BOARD_CONSULTATION_RESULTS");
    expect(built.prompt).toContain("untrusted data");
    expect(built.prompt).toContain("from @Scout (answered)");
    expect(built.prompt).toContain("Do not ask for more consultations");
  });
});
