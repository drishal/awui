// The consultation protocol: the parser refuses everything it does not
// understand and never best-effort parses; authorization resolves handles only
// inside the room, only for enabled, consultable, allowlisted members. The
// integration cases drive a real room through FakeAdapter and assert what ran.
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/app.js";
import { agent, botRuns, makeBot, makeRoom, openProject, patchMember, send, snapshot, waitRecords } from "../helpers/board.js";
import { authorizeConsultRequests, parseControlDocument } from "../../src/server/boards/consult.js";
import { CONSULT_MARKER_BEGIN, CONSULT_MARKER_END } from "../../src/server/boards/types.js";
import type { RoomRecord, RoomSnapshot } from "../../src/shared/protocol.js";

function document(requests: unknown, extra = ""): string {
  return `${CONSULT_MARKER_BEGIN}\n${JSON.stringify({ version: 1, action: "consult", requests })}\n${CONSULT_MARKER_END}${extra}`;
}

function consultations(snap: RoomSnapshot): Array<Extract<RoomRecord, { kind: "consultation" }>> {
  return snap.records.filter((record): record is Extract<RoomRecord, { kind: "consultation" }> => record.kind === "consultation");
}

describe("the control-document parser", () => {
  it("accepts exactly one envelope with one to three well-formed requests", () => {
    const parsed = parseControlDocument(document([{ to: "Scout", question: "Check this." }]));
    expect(parsed).toEqual({ kind: "consult", requests: [{ to: "Scout", question: "Check this." }] });
  });

  it("treats ordinary text, even text quoting the markers, as a plain answer", () => {
    expect(parseControlDocument("I would say: <<<AWUI_BOARD_CONTROL is a marker.")).toEqual({ kind: "plain" });
    expect(parseControlDocument("plain answer")).toEqual({ kind: "plain" });
  });

  it("refuses trailing prose, multiple envelopes, malformed JSON, and unknown fields", () => {
    expect(parseControlDocument(document([{ to: "Scout", question: "q" }], "\n\nHope that helps!"))).toMatchObject({ kind: "invalid" });
    const twice = `${document([{ to: "Scout", question: "q" }])}\n${document([{ to: "Skeptic", question: "q" }])}`;
    expect(parseControlDocument(twice)).toMatchObject({ kind: "invalid" });
    const bad = `${CONSULT_MARKER_BEGIN}\n{not json}\n${CONSULT_MARKER_END}`;
    expect(parseControlDocument(bad)).toMatchObject({ kind: "invalid" });
    const unknown = `${CONSULT_MARKER_BEGIN}\n{"version":1,"action":"consult","requests":[{"to":"Scout","question":"q","extra":1}]}\n${CONSULT_MARKER_END}`;
    expect(parseControlDocument(unknown)).toMatchObject({ kind: "invalid" });
    const wrongVersion = `${CONSULT_MARKER_BEGIN}\n{"version":2,"action":"consult","requests":[{"to":"Scout","question":"q"}]}\n${CONSULT_MARKER_END}`;
    expect(parseControlDocument(wrongVersion)).toMatchObject({ kind: "invalid" });
  });

  it("refuses an oversized document, more than three requests, and an empty question", () => {
    const huge = document([{ to: "Scout", question: "q".repeat(17 * 1024) }]);
    expect(parseControlDocument(huge)).toMatchObject({ kind: "invalid" });
    expect(parseControlDocument(document(Array.from({ length: 4 }, () => ({ to: "Scout", question: "q" }))))).toMatchObject({ kind: "invalid" });
    expect(parseControlDocument(document([{ to: "Scout", question: "   " }]))).toMatchObject({ kind: "invalid" });
  });
});

describe("consultation authorization", () => {
  const members = [
    { id: "m1", handle: "Atlas", enabled: true, consultable: true },
    { id: "m2", handle: "Scout", enabled: true, consultable: true },
    { id: "m3", handle: "Skeptic", enabled: false, consultable: true },
    { id: "m4", handle: "Ghost", enabled: true, consultable: false },
  ];

  it("resolves handles case-insensitively and honors the allowlist, self, and budget", () => {
    const result = authorizeConsultRequests({
      requests: [
        { to: "scout", question: "One" },
        { to: "Atlas", question: "Self" },
        { to: "Skeptic", question: "Disabled" },
        { to: "Ghost", question: "Not consultable" },
        { to: "Nobody", question: "Unknown" },
      ],
      fromMemberId: "m1",
      members,
      allowlist: ["m2"],
      remaining: 4,
      seen: new Set(),
    });
    expect(result.accepted.map((entry) => entry.to.id)).toEqual(["m2"]);
    expect(result.refused.map((entry) => entry.reason)).toEqual([
      "A bot cannot consult itself",
      "@Skeptic is not open to consultations",
      "@Ghost is not open to consultations",
      "There is no member @Nobody in this room",
    ]);
  });

  it("refuses past the remaining budget", () => {
    const result = authorizeConsultRequests({
      requests: [{ to: "Scout", question: "One" }, { to: "Scout", question: "Two" }],
      fromMemberId: "m1",
      members,
      allowlist: ["m2"],
      remaining: 1,
      seen: new Set(),
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("no consultation budget left");
  });
});

describe("consultations in a room", () => {
  async function room(text: string) {
    const t = await makeTestApp();
    const a = await agent(t);
    const ws = await openProject(t, a);
    const lead = await makeBot(a, { name: "Atlas", harnessId: "fake", role: "lead" });
    const scout = await makeBot(a, { name: "Scout", harnessId: "fake-b", role: "researcher" });
    const snap = await makeRoom(a, ws.id, [
      { botId: lead.id, handle: "atlas", canLead: true },
      { botId: scout.id, handle: "scout" },
    ]);
    const [leadMember, scoutMember] = snap.room.members;
    await patchMember(a, snap.room.id, leadMember!.id, { consultants: [scoutMember!.id] });
    await send(a, snap.room.id, text);
    const done = await waitRecords(a, snap.room.id, (s) => s.activeTurn === null && botRuns(s).length > 0);
    return { t, a, snap: done };
  }

  it("runs one allowed consultant and re-invokes the requester with the answer", async () => {
    const { t, snap } = await room("consult");
    try {
      const records = consultations(snap);
      expect(records).toHaveLength(1);
      expect(records[0]?.outcome).toBe("answered");
      const runs = botRuns(snap);
      // The lead's control turn, the consultant's run, and the lead's plain synthesis.
      expect(runs).toHaveLength(3);
      expect(runs.filter((run) => run.consultOf !== undefined)).toHaveLength(1);
      const final = runs[runs.length - 1];
      expect(final?.items.some((item) => item.kind === "assistant" && item.text.includes("Final answer after consultations"))).toBe(true);
      // The control document itself never becomes a visible answer item.
      const controlRuns = runs.filter((run) => run.consultOf === undefined);
      expect(controlRuns[0]?.items.some((item) => item.kind === "assistant")).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("refuses an unknown target without invoking it", async () => {
    const { t, snap } = await room("consult-unknown");
    try {
      expect(consultations(snap)).toHaveLength(1);
      expect(consultations(snap)[0]?.outcome).toBe("refused");
      expect(botRuns(snap)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("refuses a duplicate question in the same turn", async () => {
    const { t, snap } = await room("consult-dup");
    try {
      const outcomes = consultations(snap).map((record) => record.outcome).sort();
      expect(outcomes).toEqual(["answered", "refused"]);
      expect(botRuns(snap).filter((run) => run.consultOf !== undefined)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("never executes a malformed control document", async () => {
    const { t, snap } = await room("consult-bad");
    try {
      expect(consultations(snap)).toHaveLength(0);
      expect(botRuns(snap)).toHaveLength(1);
      expect(snap.records.some((record) => record.kind === "notice" && /not run/.test(record.text))).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("refuses self-consultation", async () => {
    const { t, snap } = await room("consult-self");
    try {
      expect(consultations(snap)).toHaveLength(1);
      expect(consultations(snap)[0]?.outcome).toBe("refused");
      expect(botRuns(snap)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("records a failed consultant and still lets the requester answer", async () => {
    const { t, snap } = await room("consult-fail");
    try {
      expect(consultations(snap)[0]?.outcome).toBe("failed");
      const runs = botRuns(snap);
      expect(runs.some((run) => run.consultOf !== undefined && run.status === "failed")).toBe(true);
      expect(runs[runs.length - 1]?.items.some((item) => item.kind === "assistant" && item.text.includes("Final answer after consultations"))).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("surfaces a consultant's approval request and routes the answer to it", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const scout = await makeBot(a, { name: "Scout", harnessId: "fake-b" });
      const created = await makeRoom(a, ws.id, [
        { botId: lead.id, handle: "atlas", canLead: true },
        { botId: scout.id, handle: "scout" },
      ]);
      const [leadMember, scoutMember] = created.room.members;
      await patchMember(a, created.room.id, leadMember!.id, { consultants: [scoutMember!.id] });
      await send(a, created.room.id, "consult-ask");
      const asking = await waitRecords(a, created.room.id, (s) => s.pending.length > 0);
      expect(asking.pending[0]?.memberId).toBe(scoutMember!.id);
      const requestId = asking.pending[0]!.id;
      const answer = await a.post(`/api/rooms/${created.room.id}/requests/${encodeURIComponent(requestId)}/answer`).send({ answer: { kind: "confirm", confirmed: true } });
      expect(answer.status).toBe(200);
      const done = await waitRecords(a, created.room.id, (s) => s.activeTurn === null && consultations(s).some((record) => record.outcome === "answered"));
      expect(botRuns(done).filter((run) => run.consultOf !== undefined)).toHaveLength(1);
      expect((await snapshot(a, created.room.id)).pending).toHaveLength(0);
    } finally {
      await t.close();
    }
  });
});
