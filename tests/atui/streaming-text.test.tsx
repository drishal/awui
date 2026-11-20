// Streamed markdown draws no cursor, and nothing in it changes on a timer: the
// same text lays out at the same height frame after frame.
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { AtuiContext } from "../../src/atui/ui/context.js";
import { Md } from "../../src/atui/ui/transcript.js";
import { DARK } from "../../src/atui/theme.js";
import type { Atui } from "../../src/atui/state.js";

const OLD_CARET = "▍";
const WIDTH = 40;

/** Just what Md reads from the app. */
const stub = { theme: () => DARK, pacedMemory: () => new Map<string, number>() } as unknown as Atui;

/** The drawn rows down to the last one with anything on it. */
const used = (frame: string): string[] => {
  const rows = frame.split("\n");
  while (rows.length && !rows[rows.length - 1]!.trim()) rows.pop();
  return rows;
};

async function stream(text: string) {
  const [streaming, setStreaming] = createSignal(true);
  const setup = await testRender(
    () => (
      <AtuiContext.Provider value={stub}>
        <box width={WIDTH} height="100%" flexDirection="column">
          <Md text={text} streaming={streaming()} fg={DARK.text} />
        </box>
      </AtuiContext.Provider>
    ),
    { width: WIDTH, height: 16, exitOnCtrlC: false },
  );
  return { setup, setStreaming };
}

/** The frame once one-off work (code highlighting) has landed. */
async function settled(setup: Awaited<ReturnType<typeof testRender>>): Promise<string> {
  await setup.flush({ maxPasses: 8 });
  let last = setup.captureCharFrame();
  let same = 0;
  for (let i = 0; i < 60 && same < 6; i++) {
    await Bun.sleep(50);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    same = frame === last ? same + 1 : 0;
    last = frame;
  }
  return last;
}

const cases: [string, string][] = [
  ["a plain line", "Hello there, still writing"],
  ["text ending in a newline", "First paragraph of the answer.\n"],
  ["text ending in a paragraph break", "First paragraph of the answer.\n\n"],
  ["a line exactly the width", "x".repeat(WIDTH)],
  ["a list ending in a newline", "A list:\n\n- one\n- two\n"],
  ["an open code fence", "Code:\n\n```ts\nconst a = 1\n"],
];

describe("atui streamed markdown", () => {
  for (const [name, text] of cases) {
    it(`draws no cursor and holds its height for ${name}`, async () => {
      const { setup, setStreaming } = await stream(text);
      try {
        const first = await settled(setup);
        expect(first).not.toContain(OLD_CARET);
        // Across more than a blink period (the old cursor was 600 ms on, 400 off).
        const heights = new Set<number>([used(first).length]);
        for (let i = 0; i < 6; i++) {
          await Bun.sleep(200);
          await setup.renderOnce();
          const frame = setup.captureCharFrame();
          expect(frame).not.toContain(OLD_CARET);
          expect(frame).toBe(first);
          heights.add(used(frame).length);
        }
        expect(heights.size).toBe(1);
        // The last drawn row is text, never a row left for a cursor.
        expect(used(first).at(-1)!.trim().length).toBeGreaterThan(0);
        setStreaming(false);
        await setup.flush({ maxPasses: 8 });
        const done = setup.captureCharFrame();
        expect(done).not.toContain(OLD_CARET);
        if (!text.includes("```")) expect(used(done).length).toBe(used(first).length);
      } finally {
        setup.renderer.destroy();
        await setup.dispose();
      }
    });
  }
});
