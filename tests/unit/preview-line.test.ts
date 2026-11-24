// The one line a session's card shows (previewLine): the last answer, else the prompt, as plain words.
import { describe, expect, it } from "vitest";
import type { SessionPreview } from "../../src/shared/protocol.js";
import { previewLine } from "../../src/web/preview-line.js";

const preview = (over: Partial<SessionPreview>): SessionPreview => ({ prompt: null, answer: null, turns: 1, model: null, files: [], ...over }) as SessionPreview;

describe("previewLine", () => {
  it("takes the answer, else the prompt, and is nothing when neither exists", () => {
    expect(previewLine(preview({ prompt: "fix it", answer: "Done." }))).toBe("Done.");
    expect(previewLine(preview({ prompt: "fix it" }))).toBe("fix it");
    expect(previewLine(preview({}))).toBeNull();
    expect(previewLine(null)).toBeNull();
  });

  it("strips Markdown markers line by line and joins the lines with a dot", () => {
    expect(previewLine(preview({ answer: "## Result\n**Fixed** the `parser`\n- one\n- two" }))).toBe("Result · Fixed the parser · one · two");
  });

  it("cuts a long line at 220 characters", () => {
    const line = previewLine(preview({ answer: "word ".repeat(100) }));
    expect(line?.length).toBeLessThanOrEqual(220);
    expect(line?.endsWith("…")).toBe(true);
  });
});
