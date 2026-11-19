// Markdown reasoning must remain quieter than the answer even when syntax styles colour spans.
import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { syntaxFor } from "../../src/atui/ui/syntax.js";
import { DARK } from "../../src/atui/theme.js";

describe("atui markdown hierarchy", () => {
  it("keeps reasoning below the answer's foreground weight", async () => {
    const setup = await testRender(() => <text>style probe</text>, { width: 20, height: 2 });
    try {
      const normal = syntaxFor(DARK, setup.renderer.nativeScene);
      const quiet = syntaxFor(DARK, setup.renderer.nativeScene, true);
      const answer = normal.getStyle("default")?.fg;
      const thought = quiet.getStyle("default")?.fg;
      expect(answer).toBeDefined();
      expect(thought).toBeDefined();
      expect(thought!.equals(answer)).toBe(false);
      expect((thought!.r + thought!.g + thought!.b) / 3).toBeLessThan((answer!.r + answer!.g + answer!.b) / 3 * 0.75);
      expect(quiet.getStyle("markup.strong")?.fg?.equals(normal.getStyle("markup.strong")?.fg)).toBe(false);
    } finally {
      setup.renderer.destroy();
      await setup.dispose();
    }
  });
});
