// The sticky prompt bar's rule (sticky-prompt.ts): whose prompt it names, and when it lets go.
import { describe, expect, it } from "vitest";
import { STICKY_BAR_PX, stickyLabel, stickyLine, stickyTurn, type TurnBox } from "../../src/web/sticky-prompt.js";

/** Turns of 300 px with a 40 px prompt, the first one starting at `first` (its top edge, from the view's top). */
const column = (first: number, count = 5) => (index: number): TurnBox => {
  const top = first + index * 300;
  return { promptBottom: top + 40, bottom: top + 300 };
};

describe("which turn's prompt the bar shows", () => {
  it("shows none while the prompt is in view, and the turn's once it has scrolled off", () => {
    expect(stickyTurn(5, column(0))).toBe(-1);
    expect(stickyTurn(5, column(-30))).toBe(-1);
    expect(stickyTurn(5, column(-40))).toBe(0);
    expect(stickyTurn(5, column(-200))).toBe(0);
  });

  it("lets go as the turn's end reaches the bar, before the next prompt slides under it", () => {
    // Turn 0 ends at -first + 300; the next prompt is at its end.
    expect(stickyTurn(5, column(-300 + STICKY_BAR_PX + 1))).toBe(0);
    expect(stickyTurn(5, column(-300 + STICKY_BAR_PX))).toBe(-1);
    // Once the next prompt has gone up too, the bar names that one.
    expect(stickyTurn(5, column(-300 - 40))).toBe(1);
  });

  it("names the last turn, and none for an empty chat", () => {
    expect(stickyTurn(5, column(-4 * 300 - 100))).toBe(4);
    expect(stickyTurn(0, column(0))).toBe(-1);
  });

  it("counts turns not drawn yet as above the view, and measures only a few", () => {
    const drawn = column(-1000 + 3 * 300);
    let measured = 0;
    // The two oldest are not in the page; turn 3 is the first drawn, with its prompt just off the top.
    const box = (index: number) => {
      measured++;
      return index < 3 ? null : drawn(index - 3);
    };
    expect(stickyTurn(8, box)).toBe(3);
    expect(measured).toBeLessThanOrEqual(8);
    // Nothing but undrawn turns above the view's first drawn prompt: no bar.
    expect(stickyTurn(8, (index) => (index < 3 ? null : column(10)(index - 3)))).toBe(-1);
    let many = 0;
    stickyTurn(1000, (index) => {
      many++;
      return column(-100_000)(index);
    });
    expect(many).toBeLessThan(30);
  });
});

describe("the bar's words", () => {
  it("folds a prompt to one bounded line", () => {
    expect(stickyLine("  fix the\n\n  build   please ")).toBe("fix the build please");
    expect(stickyLine("x".repeat(500))).toHaveLength(160);
    expect(stickyLine("  \n ")).toBe("(no text)");
  });

  it("reads a prompt's Markdown as its words", () => {
    // The frame's own prompt: a heading, a numbered list with bold and inline code.
    expect(stickyLine("## Migration order\n\n1. **Freeze** writes to `users_legacy` for five minutes.\n2. Backfill in batches.")).toBe("Migration order Freeze writes to users_legacy for five minutes. Backfill in batches.");
    expect(stickyLine("- a bullet\n- another")).toBe("a bullet another");
    expect(stickyLine("_italic_ and __bold__ and ***both***")).toBe("italic and bold and both");
    expect(stickyLine("See [the docs](https://example.com/a_b) for it")).toBe("See the docs for it");
    expect(stickyLine("> quoted [![alt](img.png)](x) words")).toBe("quoted alt words");
    // Underscores inside a name are not an italic mark.
    expect(stickyLine("rename_this_file and keep it")).toBe("rename_this_file and keep it");
  });

  it("names the prompt it goes back to", () => {
    expect(stickyLabel(12, "fix the build")).toBe("Back to prompt #12: fix the build");
  });
});
