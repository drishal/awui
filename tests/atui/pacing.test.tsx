// Stream reveal lifecycle: never re-type resumed content, and no chase effect
// after the active provider's final assistant item engages the transcript.
import { describe, expect, it } from "bun:test";
import { createEffect, createRoot, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { usePaced } from "../../src/atui/ui/fx.js";
import { mount, startServer, wait, type Mounted } from "./helpers.js";
import path from "node:path";

const waitFor = async (predicate: () => boolean, timeout = 5000) => {
  const until = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Timed out waiting for a render condition");
    await wait(25);
  }
};

describe("atui streaming lifecycle", () => {
  it("begins with the received text, grows only forward, and finishes at settle", async () => {
    const [text, setText] = createSignal("Already decoded history");
    const [live, setLive] = createSignal(true);
    let paced!: () => string;
    let resets = 0;
    const setup = await testRender(() => {
      paced = usePaced(text, live);
      createEffect(() => paced());
      return <text>{paced()}</text>;
    }, { width: 42, height: 5 });
    try {
      await setup.renderOnce();
      expect(paced()).toBe("Already decoded history");
      expect(setup.renderer.getDebugInputs()).toHaveLength(0);
      setText("Already decoded history, then fresh prose");
      await waitFor(() => paced().startsWith("Already decoded history, t"));
      const before = paced().length;
      expect(before).toBeGreaterThanOrEqual(23);
      expect(paced()).toMatch(/^Already decoded history/);
      expect(before).toBeGreaterThanOrEqual(23);
      await wait(220);
      expect(paced().length).toBeGreaterThan(before);
      setLive(false);
      await waitFor(() => paced() === text());
      const final = paced();
      await wait(150);
      expect(paced()).toBe(final);
    } finally {
      setup.renderer.destroy();
      await setup.dispose();
    }
  });

  it("settles with all of its final answer, not a stale tail or perpetual Working", async () => {
    const port = 4883;
    const server = await startServer({ port, env: { AWUI_FAKE_DELAY_MS: "300" } });
    let ui: Mounted | null = null;
    try {
      ui = await mount(path.join(server.root, "alpha"), { width: 160, height: 100, base: server.base });
      await ui.type("slow stream for a finished response");
      ui.keys.pressEnter();
      await ui.until(() => ui?.app.chat()?.status === "running");
      let expected = "";
      await wait(1200);
      await waitFor(() => ui?.app.chat()?.items.some((i) => i.kind === "assistant" && i.text.includes("Echo: slow stream for a finished response")) ?? false, 18000);
      await ui.until(() => ui?.app.chat()?.status === "idle", 40000);
      expected = ui.app.chat()!.items.filter((i) => i.kind === "assistant").map((i) => i.text).join("\n");
      expect(expected).toContain("line 1 with **markdown**");
      const frame = await ui.frame();
      expect(frame).not.toContain("Working ·");
      expect(frame).toContain("● Echo: slow stream for a finished response");
      expect(frame).toContain("markdown");
      expect(frame).toContain("line 60 with markdown");
      expect(ui.app.chat()!.status).toBe("idle");
    } finally {
      await ui?.unmount();
      await server.stop();
    }
  }, 60000);
});
