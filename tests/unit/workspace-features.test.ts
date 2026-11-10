import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";
import type { ChatSnapshot, WorktreeInfo } from "../../src/shared/protocol.js";
import { pullRequestChecksParse } from "../../src/server/github.js";

const t: TestApp[] = [];
const after = async () => { for (const app of t.splice(0)) await app.close(); };
afterAll(after);

const runGit = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

describe("workspace feature flows", () => {
  it("compares chosen agents in distinct real worktrees and keeps one writer per session", async () => {
    const app = await makeTestApp();
    t.push(app);
    const agent = await signedIn(app);
    runGit(app.project, "init", "-q");
    runGit(app.project, "config", "user.email", "test@example.com");
    runGit(app.project, "config", "user.name", "test");
    writeFileSync(path.join(app.project, "app.txt"), "base\n");
    runGit(app.project, "add", "app.txt");
    runGit(app.project, "commit", "-qm", "base");
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body;
    const res = await agent.post("/api/compare").send({ workspaceId: ws.id, name: "try-both", base: "HEAD", prompt: "edit two files", choices: [{ harnessId: "fake" }, { harnessId: "fake-b" }] });
    expect(res.status).toBe(201);
    expect(res.body.results).toHaveLength(2);
    const snapshots = res.body.results.map((r: { snapshot: ChatSnapshot; tree: WorktreeInfo; error?: string }) => r.snapshot) as ChatSnapshot[];
    expect(snapshots[0]?.chatId).not.toBe(snapshots[1]?.chatId);
    expect(snapshots[0]?.sessionId).not.toBe(snapshots[1]?.sessionId);
    expect(snapshots[0]?.workspace.path).not.toBe(snapshots[1]?.workspace.path);
    // Start responses are pre-prompt and immutable: read the live owners instead.
    await vi.waitFor(() => expect(snapshots.every((snapshot) => app.manager.get(snapshot.chatId).status === "idle")).toBe(true));
    for (const snapshot of snapshots) {
      expect(existsSync(snapshot.workspace.path)).toBe(true);
      expect(readFileSync(path.join(snapshot.workspace.path, "src", "app.ts"), "utf8")).toContain("Managed by the fake harness");
      expect(snapshot.workspace.path.startsWith(path.join(app.project, ".awui", "worktrees"))).toBe(true);
      expect(snapshot.items.some((i) => i.kind === "user" && i.text === "edit two files")).toBe(true);
    }
  }, 20_000);

  it("starts a real PTY only inside a validated workspace, replays output, and kills it on detach", async () => {
    const app = await makeTestApp({ withTerminal: true });
    t.push(app);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body;
    const created = (await agent.post(`/api/workspaces/${ws.id}/terminal`).send({ cols: 80, rows: 24 })).body as { id: string };
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    await agent.post(`/api/workspaces/${ws.id}/terminal/${created.id}/write`).send({ data: "printf awui-terminal-ok\\n\n" });
    const events = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PT replay timeout")), 6000);
      timer.unref();
      let all = "";
      const req = http.get({ host: "127.0.0.1", port: app.port, path: `/api/workspaces/${ws.id}/terminal/${created.id}/events` }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          all += String(chunk);
          if (all.includes("awui-terminal-ok")) {
            clearTimeout(timer);
            req.destroy();
            resolve(all);
          }
          if (all.includes("exit")) {
            clearTimeout(timer);
            resolve(all);
          }
        });
      });
      req.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    expect(events).toContain("awui-terminal-ok");
    // Disconnecting the last viewer closes the process instead of leaving a shell.
    await vi.waitFor(async () => {
      const ignored = await agent.post(`/api/workspaces/${ws.id}/terminal/${created.id}/write`).send({ data: "printf should-not-write\\n" });
      expect(ignored.status).toBe(404);
    }, { interval: 20, timeout: 5000 });
  }, 20_000);

  it("renders a preview from stored html, with no external request network", async () => {
    const app = await makeTestApp();
    t.push(app);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body;
    const snapshot = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const token = app.manager.get(snapshot.chatId).render?.token;
    expect(token).toBeTruthy();
    const sse = openSse(app, snapshot.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((event) => event.type === "snapshot"));
    await agent.post(`/api/chats/${snapshot.chatId}/messages`).send({ text: "render a page" });
    await sse.waitFor(() => sse.chatEvents().some((event) => event.type === "status" && event.status === "idle"));
    const state = app.manager.get(snapshot.chatId).snapshot();
    const renderTool = state.items.find((item) => item.kind === "tool" && item.htmlRender);
    const id = renderTool?.kind === "tool" ? renderTool.htmlRender?.id : undefined;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const preview = await agent.post(`/api/chats/${snapshot.chatId}/html-render/${id}/preview`).send({ appearance: "dark", theme: { "--bg": "#111827", "--text": "#ffffff", "--accent": "#89b4fa" } });
    expect(preview.status).toBe(200);
    expect(preview.body.width).toBe(1280);
    expect(preview.body.height).toBe(900);
    const image = await agent.get(`/api/images/${preview.body.id}`);
    expect(image.status).toBe(200);
    expect(image.body.byteLength).toBeGreaterThan(100);
  }, 20_000);

  it("refuses a comparison that names one harness twice before creating anything", async () => {
    const app = await makeTestApp();
    t.push(app);
    const agent = await signedIn(app);
    runGit(app.project, "init", "-q");
    runGit(app.project, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body;
    const res = await agent.post("/api/compare").send({ workspaceId: ws.id, name: "twice", base: "HEAD", prompt: "go", choices: [{ harnessId: "fake" }, { harnessId: "fake" }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("duplicate_harness");
    expect(existsSync(path.join(app.project, ".awui", "worktrees"))).toBe(false);
  });

  it("answers an unknown terminal's event stream with a plain 404, not an empty stream", async () => {
    const app = await makeTestApp({ withTerminal: true });
    t.push(app);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body;
    const res = await agent.get(`/api/workspaces/${ws.id}/terminal/00000000-0000-0000-0000-000000000000/events`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no_terminal");
  });

  it("parses the gh PR status buckets without inventing links or credentials", () => {
    expect(pullRequestChecksParse('[{"name":"unit","bucket":"pass","link":"https://github.com/o/r/runs/1"},{"name":"lint","bucket":"fail"},{"name":""}]')).toEqual([{ name: "unit", state: "pass", link: "https://github.com/o/r/runs/1" }, { name: "lint", state: "fail", link: null }]);
  });
});
