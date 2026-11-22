// The form document and the messages the frame posts back: the nonce is the
// only permit the harness's own HTML gets, and only bounded control values
// cross back to the app.
import { describe, expect, it } from "vitest";
import {
  clampInteractionFormHeight,
  interactionFormDocument,
  INTERACTION_FORM_CANCEL,
  INTERACTION_FORM_HEIGHT,
  INTERACTION_FORM_MAX_HEIGHT,
  INTERACTION_FORM_MIN_HEIGHT,
  INTERACTION_FORM_SUBMIT,
  readInteractionFormCancel,
  readInteractionFormHeight,
  readInteractionFormSubmit,
} from "../../src/shared/interaction-form.js";

describe("interaction form document", () => {
  it("carries the harness's form and permits only its own nonce's script and style", () => {
    const html = interactionFormDocument('<form><input name="q"></form><script>alert(1)</script>', "abc123");
    expect(html).toContain('<form><input name="q"></form>');
    // The agent's own script rides along as inert markup: no nonce, so the
    // response's script-src never permits it.
    expect(html).toContain("<script>alert(1)</script>");
    expect(html.match(/<script nonce="abc123">/g)).toHaveLength(1);
    expect(html.match(/<style nonce="abc123">/g)).toHaveLength(1);
    expect(html).not.toContain('<script nonce="abc123">alert(1)');
  });

  it("keeps a frame's height between the card's bounds", () => {
    expect(clampInteractionFormHeight(20)).toBe(INTERACTION_FORM_MIN_HEIGHT);
    expect(clampInteractionFormHeight(10_000)).toBe(INTERACTION_FORM_MAX_HEIGHT);
    expect(clampInteractionFormHeight(333.4)).toBe(333);
  });
});

describe("messages a form frame posts", () => {
  it("reads submitted controls by name and drops what is not a value", () => {
    expect(
      readInteractionFormSubmit({
        method: INTERACTION_FORM_SUBMIT,
        data: { t1: ["a", "b"], notes: "keep", count: 2, bad: { nested: true }, long: "x".repeat(100_001) },
      }),
    ).toEqual({ t1: ["a", "b"], notes: "keep", count: 2, long: "x".repeat(100_000) });
    expect(readInteractionFormSubmit({ method: "something-else", data: { a: "b" } })).toBeNull();
    expect(readInteractionFormSubmit({ method: INTERACTION_FORM_SUBMIT, data: "nope" })).toBeNull();
  });

  it("reads a cancel and a height, and nothing else", () => {
    expect(readInteractionFormCancel({ method: INTERACTION_FORM_CANCEL })).toBe(true);
    expect(readInteractionFormCancel({ method: INTERACTION_FORM_SUBMIT })).toBe(false);
    expect(readInteractionFormHeight({ method: INTERACTION_FORM_HEIGHT, height: 240 })).toBe(240);
    expect(readInteractionFormHeight({ method: INTERACTION_FORM_HEIGHT, height: -1 })).toBeUndefined();
    expect(readInteractionFormHeight({ method: INTERACTION_FORM_SUBMIT })).toBeUndefined();
  });
});
