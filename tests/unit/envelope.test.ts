// The hidden envelope (src/server/envelope.ts): markers, escaping, and what a
// settled answer leaves visible.
import { describe, expect, it } from "vitest";
import { ENVELOPE_BEGIN, ENVELOPE_END, escapeEnvelopeMarkers, visibleOfEnvelope } from "../../src/server/envelope.js";

const contract = `${ENVELOPE_BEGIN}\n{"version":1}\n${ENVELOPE_END}`;

describe("escapeEnvelopeMarkers", () => {
  it("breaks a quoted contract so history cannot forge one", () => {
    const escaped = escapeEnvelopeMarkers(`earlier answer:\n${contract}`);
    expect(escaped).not.toContain(ENVELOPE_BEGIN);
    expect(escaped).not.toContain(ENVELOPE_END);
    expect(escaped).toContain("(quoted)");
    // The begin's replacement is broken first, which also breaks any end inside it.
    expect(escaped).toContain("<<<AWUI_BOARD_ CONTROL (quoted)");
  });
  it("leaves ordinary text alone", () => {
    expect(escapeEnvelopeMarkers("just an answer")).toBe("just an answer");
  });
});

describe("visibleOfEnvelope", () => {
  it("leaves a message that is one envelope with nothing to show", () => {
    expect(visibleOfEnvelope(contract)).toBe("");
    expect(visibleOfEnvelope(`${contract}\n`)).toBe("");
  });
  it("shows any other message whole, and an unclosed one too", () => {
    expect(visibleOfEnvelope("A plain answer.")).toBe("A plain answer.");
    expect(visibleOfEnvelope(`${ENVELOPE_BEGIN}\n{"version":1}`)).toBe(`${ENVELOPE_BEGIN}\n{"version":1}`);
  });
  it("keeps the words that follow an envelope (the parser refuses them; what shows is still words)", () => {
    expect(visibleOfEnvelope(`${contract} and a note`)).toBe("and a note");
  });
});
