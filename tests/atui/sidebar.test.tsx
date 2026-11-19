// Project navigation: first-class projects, no silent fixed slices, and exact
// keyboard equivalents for every public browser action in the sidebar.
import { describe, expect, it } from "bun:test";
import { mount, startServer, wait, type Mounted } from "./helpers.js";
import path from "node:path";
import { mkdirSync } from "node:fs";


describe("atui projects", () => {
  it("shows all current sessions, folds projects, navigates by keyboard, and starts scoped chats", async () => {
    const server = await startServer({ port: 4884, env: { AWUI_FAKE_DELAY_MS: "1" } });
    let ui: Mounted | null = null;
    const post = async (route: string, body: unknown) => fetch(`${server.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    try {
      for (const name of ["alpha", "beta"]) {
        const ws = await post("/api/workspaces/open", { path: path.join(server.root, name) });
        for (let i = 0; i < (name === "alpha" ? 8 : 1); i++) {
          const chat = await post("/api/chats", { harnessId: "fake", workspaceId: ws.id });
          await fetch(`${server.base}/api/chats/${chat.chatId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `${name} session ${i + 1}`, mode: "normal" }) });
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      ui = await mount(path.join(server.root, "alpha"), { width: 160, height: 38, base: server.base });
      await ui.until("alpha session 8");
      expect(await ui.frame()).toContain("alpha session 1");
      expect(await ui.frame()).not.toContain("beta session 1");
      expect(await ui.frame()).toContain("beta");
      // C-x s focuses projects, not just a flat session list.
      ui.keys.pressKey("x", { ctrl: true });
      ui.keys.pressKey("s");
      await wait(80);
      const before = ui.app.workspace()!.id;
      // Beta is collapsed, so a mouse-open picks the project itself, unlike a
      // session press. All current sessions below it stay in the same overview.
      await ui.click("beta");
      await ui.until(() => ui?.app.workspace()?.id !== before);
      await ui.until(() => ui?.app.chat()?.title?.startsWith("beta session") === true);
      expect(ui.app.workspace()?.name).toBe("beta");
      expect(ui.app.chat()?.title).toMatch(/^beta session/);
      // The current project folds and reopens with the keyboard.
      ui.keys.pressKey("x", { ctrl: true });
      ui.keys.pressKey("s");
      ui.keys.pressKey(" ");
      const folded = await ui.frame();
      const left = folded.split("\n").map((line) => line.split("│")[0]).join("\n");
      expect(left).not.toContain("beta session 1");
      // Reopen, return to the project head, and start a scoped chat by keyboard.
      ui.keys.pressKey("j");
      await wait(35);
      ui.keys.pressKey("k");
      ui.keys.pressKey("n");
      await ui.until(() => ui?.app.chat() === null);
      expect(ui.app.workspace()?.name).toBe("beta");
      expect(await ui.frame()).toContain("What should Fake do in beta?");
      expect(ui.app.overview().sessions.filter((s) => s.workspaceId === before).length).toBe(8);
    } finally {
      await ui?.unmount();
      await server.stop();
    }
  }, 35_000);
  it("keeps immediate `n` scoped, and uses the matching project group's own newest session", async () => {
    const server = await startServer({ port: 4884 });
    mkdirSync(path.join(server.root, "gamma"), { recursive: true });
    const post = async (route: string, body: unknown) => fetch(`${server.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const gamma = await post("/api/workspaces/open", { path: path.join(server.root, "gamma") });
    const alpha = await post("/api/workspaces/open", { path: path.join(server.root, "alpha") });
    await post("/api/workspaces/open", { path: path.join(server.root, "beta") });
    const ineligible = await post("/api/chats", { harnessId: "fake-b", workspaceId: alpha.id });
    await post(`/api/chats/${ineligible.chatId}/messages`, { text: "not this harness", mode: "normal" });
    const eligible = await post("/api/chats", { harnessId: "fake", workspaceId: alpha.id });
    await post(`/api/chats/${eligible.chatId}/messages`, { text: "matching harness", mode: "normal" });
    let ui: Mounted | null = null;
    try {
      ui = await mount(path.join(server.root, "gamma"), { base: server.base });
      await ui.until("matching harness");
      // `n` on an empty project enters it before the first message is accepted.
      ui.keys.pressKey("x", { ctrl: true });
      ui.keys.pressKey("s");
      ui.keys.pressKey("HOME");
      ui.keys.pressKey("n");
      await wait(60);
      expect(ui.app.chat()).toBeNull();
      await ui.app.send("scope check");
      await ui.until(() => ui?.app.chat()?.workspace.name === "gamma");
      await ui.until(() => ui?.app.chat()?.items.some((i) => i.kind === "user" && i.text === "scope check") ?? false);
      expect(ui.app.chat()!.items.some((i) => i.kind === "user" && i.text === "scope check")).toBe(true);
      expect(await ui.frame()).toContain("alpha");
      await ui.click("alpha");
      await ui.until(() => ui?.app.chat()?.title === "matching harness");
      expect(ui.app.chat()?.title).toBe("matching harness");
      expect(ui.app.chat()?.title).not.toBe("not this harness");
    } finally {
      await ui?.unmount();
      await server.stop();
    }
  }, 30_000);
});
