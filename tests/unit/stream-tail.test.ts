// The tail of a streaming answer: an unfinished Markdown marker is held back or closed, so the frame never
// shows a raw "*" or "**", while complete prose passes through untouched.
import { describe, expect, it } from "vitest";
import { streamTail } from "../../src/web/stream-tail.js";

describe("streamTail", () => {
  it("closes a bold span that is still arriving, so the words are bold at once", () => {
    expect(streamTail("a **b")).toBe("a **b**");
    expect(streamTail("**bold")).toBe("**bold**");
    // A single asterisk that has opened nothing yet is held back rather than drawn.
    expect(streamTail("x *")).toBe("x ");
    expect(streamTail("*")).toBe("");
  });

  it("keeps a span that the tail closes: a finished line is the same line", () => {
    for (const closed of ["a **b**", "a *b*", "a `code`", "a ~~struck~~", "a _ital_", "a __bold__", "a ``fenced``"]) {
      expect(streamTail(closed)).toBe(closed);
    }
  });

  it("drops a trailing marker run that nothing opened", () => {
    expect(streamTail("x `")).toBe("x ");
    expect(streamTail("x ``")).toBe("x ");
    expect(streamTail("x **")).toBe("x ");
    expect(streamTail("x ~~")).toBe("x ");
    expect(streamTail("x _")).toBe("x ");
    expect(streamTail("x __")).toBe("x ");
    expect(streamTail("x ***")).toBe("x ");
  });

  it("leaves text with no marker, and a lone tilde (prose here), alone", () => {
    expect(streamTail("plain words, no markers.")).toBe("plain words, no markers.");
    expect(streamTail("")).toBe("");
    expect(streamTail("about ~5%")).toBe("about ~5%");
    expect(streamTail("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("keeps a bold span whose closer is one frame away, and leaves a lone asterisk alone", () => {
    // The closer lands in two pieces: the run is a closer (an odd count before it), and the pair is even again.
    expect(streamTail("a **b*")).toBe("a **b**");
    // Italic is not closed here: a lone "*" in prose ("2 * 3") would then strike words by accident.
    expect(streamTail("a *b")).toBe("a *b");
  });
});
