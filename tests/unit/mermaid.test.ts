// The mermaid fence policy (src/web/mermaid.ts): which fences count, what a Pele
// rejection means while an answer is still being written, and the quiet wording
// under a diagram that did not draw. Pele is called directly here (its core plus
// the flowchart type) so the failures are Pele's own and the test never depends on
// the browser's dynamic import.
import { describe, expect, test } from "vitest";
import { parse, register, render } from "pele/core";
import flowchart from "pele/diagrams/flowchart";
import { drawMermaid, isMermaidFence, mermaidNote, mermaidOptions, nextMermaidId, rejectedMermaid, rejectionOf, takeStyles } from "../../src/web/mermaid.js";

register(flowchart);

const FLOW = "flowchart LR\n  A[Mermaid text] --> B[SVG]\n";
const GROWN = "flowchart LR\n  A[Start] --> B[Render]\n  B --> C[SVG]\n";
const CUT = "flowchart LR\n  A[Start] -->";
const WRONG = "flowchart LR\n  A]Start[ --> B";

/** Pele as the browser draws it, without a container: the string path. */
const draw = (source: string): string => render(parse(source), { images: false }).svg;

describe("isMermaidFence", () => {
  test("names the language however the fence spells it", () => {
    expect(isMermaidFence("mermaid")).toBe(true);
    expect(isMermaidFence("Mermaid")).toBe(true);
    expect(isMermaidFence("  MERMAID ")).toBe(true);
    expect(isMermaidFence("js")).toBe(false);
    expect(isMermaidFence("mermaid2")).toBe(false);
    expect(isMermaidFence(null)).toBe(false);
  });
});

describe("drawMermaid", () => {
  test("draws a valid flowchart as SVG, labels and all", async () => {
    const outcome = await drawMermaid(draw, FLOW, true);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.svg).toContain("<svg");
    for (const label of ["Mermaid text", "SVG"]) expect(outcome.svg).toContain(label);
  });

  test("a settled and genuinely wrong source is invalid, with one readable line and no throw", async () => {
    const outcome = await drawMermaid(draw, WRONG, true);
    expect(outcome).toEqual({ ok: false, reason: "invalid", message: expect.stringContaining("line 2") });
  });

  test("text that stops mid-token is partial, streaming or settled", async () => {
    expect(await drawMermaid(draw, CUT, false)).toEqual({ ok: false, reason: "partial" });
    // An answer cut off mid-diagram is unfinished, not wrong: no note even once it settles.
    expect(await drawMermaid(draw, CUT, true)).toEqual({ ok: false, reason: "partial" });
  });

  test("nothing drawn yet is partial, not an error", async () => {
    expect(await drawMermaid(draw, "", false)).toEqual({ ok: false, reason: "partial" });
    expect(await drawMermaid(draw, "flow", false)).toEqual({ ok: false, reason: "partial" });
  });

  test("growing text: partial first, then the finished diagram", async () => {
    const early = await drawMermaid(draw, CUT, false);
    expect(early.ok).toBe(false);
    const late = await drawMermaid(draw, `${CUT} B[Render]\n  B --> C[SVG]`, false);
    expect(late.ok).toBe(true);
  });

  test("a failure that is not Pele's own is read, never thrown, and stays one line", async () => {
    const outcome = await drawMermaid(
      () => {
        throw new Error("chunk load failed\nwith a stack\nand more");
      },
      GROWN,
      true,
    );
    expect(outcome).toEqual({ ok: false, reason: "invalid", message: "chunk load failed." });
  });
});

describe("rejectedMermaid", () => {
  test("an unknown diagram type has no position, so it is a verdict on the whole text", () => {
    const rejection = rejectionOf({ message: "No diagram type detected for the given text.", line: 0, column: 0 });
    expect(rejectedMermaid("not a diagram at all", rejection, true)).toEqual({ ok: false, reason: "invalid", message: "No diagram type detected for the given text." });
  });

  test("a redraw's wrapped failure is read for the error it holds", () => {
    const message = "Lexical error on line 2. Unrecognized text.";
    const rejection = rejectionOf({ fonts: {}, natural: undefined, adapts: true, stale: false, error: new Error(message) });
    expect(rejection).toEqual({ message });
    expect(rejectedMermaid(WRONG, rejection, true)).toEqual({ ok: false, reason: "invalid", message });
  });

  test("a position before the last line is an error in the text, not a cut", () => {
    const rejection = { message: "Parse error on line 2:\n  A]Start[ --> B", line: 2, column: 4 };
    expect(rejectedMermaid("flowchart LR\n  A]Start[ --> B", rejection, true)).toEqual({ ok: false, reason: "invalid", message: "Parse error on line 2." });
  });

  test("trailing blank lines do not make a cut look settled", () => {
    const rejection = { message: "Parse error on line 2:", line: 2, column: 15 };
    expect(rejectedMermaid("flowchart LR\n  A[Start] -->\n\n", rejection, true)).toEqual({ ok: false, reason: "partial" });
  });
});

describe("mermaidNote", () => {
  test("says nothing while the answer streams", () => {
    const rejection = rejectionOf({ message: "Lexical error on line 2. Unrecognized text.", line: 2, column: 4 });
    expect(mermaidNote(rejectedMermaid(WRONG, rejection, false), false)).toBeNull();
  });

  test("a wrong diagram gets one sentence, and a cut one says it is unfinished", () => {
    const wrong = rejectedMermaid(WRONG, { message: "Lexical error on line 2. Unrecognized text.", line: 2, column: 4 }, true);
    expect(mermaidNote(wrong, true)).toBe("Couldn't draw this diagram as Mermaid. Lexical error on line 2. Unrecognized text.");
    const cut = rejectedMermaid(CUT, { message: "Parse error on line 2:", line: 2, column: 15 }, true);
    expect(mermaidNote(cut, true)).toBe("This diagram stops before it is finished.");
  });

  test("a drawn diagram says nothing", () => {
    expect(mermaidNote({ ok: true, svg: "<svg/>" }, true)).toBeNull();
  });
});

describe("mermaidOptions", () => {
  test("no remote images, links as Markdown leaves them, and the instance's own id prefix", () => {
    expect(mermaidOptions("mermaid-7")).toEqual({ idPrefix: "mermaid-7", images: false, linkRel: "noopener noreferrer nofollow" });
  });
});

describe("nextMermaidId", () => {
  test("is fresh each time and safe for an id", () => {
    const first = nextMermaidId();
    const second = nextMermaidId();
    expect(first).not.toBe(second);
    for (const id of [first, second]) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("takeStyles", () => {
  test("empties the style attributes in document order and leaves every other attribute", () => {
    const markup = '<svg class="pele" style="--_fg:red;color:var(--_fg)"><g><rect style="rx:4px" width="4"/></g><text fill="var(--_fg)">Start</text></svg>';
    const { markup: plain, styles } = takeStyles(markup);
    expect(styles).toEqual(["--_fg:red;color:var(--_fg)", "rx:4px"]);
    // The empty attribute stays: it is what says which element held the declaration.
    expect(plain).toBe('<svg class="pele" style=""><g><rect style="" width="4"/></g><text fill="var(--_fg)">Start</text></svg>');
  });

  test("a diagram with no styles is left exactly as it is", () => {
    const markup = "<svg><rect width=\"4\"/></svg>";
    expect(takeStyles(markup)).toEqual({ markup, styles: [] });
  });
});
