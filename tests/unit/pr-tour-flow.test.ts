// Test the real tour route with an opened, confined workspace. Only gh is mocked:
// actual request validation, PR number handling, normalized diffs and cache remain.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";
import { readTour, tourCacheReset } from "../../src/server/pr-tour.js";
import * as gh from "../../src/server/github.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";

const local: WorkspaceInfo = { id: "abcdefghijklmnopqrstuv", path: "/tmp/repo", name: "repo" };

function ghReply(args: string[], head: string): string {
  const fields = args[args.indexOf("--json") + 1]?.split(",") ?? [];
  return JSON.stringify({
    ...(fields.includes("title") ? { title: "Reading guide" } : {}),
    ...(fields.includes("url") ? { url: "https://github.com/acme/repo/pull/42" } : {}),
    ...(fields.includes("headRefOid") ? { headRefOid: head } : {}),
  });
}

describe("PR tour route and snapshot freshness", () => {
  let t: TestApp | undefined;
  beforeEach(() => { tourCacheReset(); vi.restoreAllMocks(); });
  afterEach(async () => { await t?.close(); t = undefined; });

  it("validates a real hash-shaped workspace and rebuilds a saved guide", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const opened = await agent.post("/api/workspaces/open").send({ path: t.project });
    const id = opened.body.id as string;
    let head = "ab00123";
    vi.spyOn(gh, "runGh").mockImplementation(async (args: string[]) => args[1] === "view"
      ? ghReply(args, head)
      : "diff --git a/src/core.js b/src/core.js\n@@ -0,0 +1 @@\n+export const core = checked;");

    const current = await agent.get(`/api/workspaces/${id}/pr-tour?pr=42&regenerate=false`);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ stale: false, tour: { files: [{ path: "src/core.js", bucket: "source", diff: { added: 1 } }] } });
    head = "dca0123";
    expect((await agent.get(`/api/workspaces/${id}/pr-tour?pr=42`)).body.stale).toBe(true);
    expect((await agent.get(`/api/workspaces/${id}/pr-tour?pr=42&regenerate=true`)).body.stale).toBe(false);
    expect((await agent.get(`/api/workspaces/${id}/pr-tour?pr=other`)).status).toBe(400);
  });

  it("does not replace a saved guide when a head lookup is malformed", async () => {
    vi.spyOn(gh, "runGh").mockImplementation(async (args: string[]) => args[1] === "view" ? ghReply(args, "ab00123") : "diff --git a/src/core.js b/src/core.js\n@@ -0,0 +1 @@\n+return selected;");
    expect((await readTour(local, 42, false)).stale).toBe(false);
    vi.spyOn(gh, "runGh").mockImplementation(async () => JSON.stringify({ headRefOid: "INVALID" }));
    await expect(readTour(local, 42, false)).rejects.toMatchObject({ status: 502, code: "github_failed" });
    vi.mocked(gh.runGh).mockImplementation(async (args: string[]) => args[1] === "view" ? ghReply(args, "ab00123") : "diff --git a/src/core.js b/src/core.js\n@@ -0,0 +1 @@\n+return selected;");
    expect((await readTour(local, 42, true)).stale).toBe(false);
  });

  it("navigation continues to show a changed-head guide as stale until rebuilt", async () => {
    let head = "ab00123";
    vi.spyOn(gh, "runGh").mockImplementation(async (args: string[]) => args[1] === "view" ? ghReply(args, head) : "diff --git a/src/core.js b/src/core.js\n@@ -0,0 +1 @@\n+return selected;");
    expect((await readTour(local, 42, false)).stale).toBe(false);
    head = "ab00456";
    expect((await readTour(local, 42, false)).stale).toBe(true);
    expect((await readTour(local, 42, false)).stale).toBe(true);
    expect((await readTour(local, 42, true)).stale).toBe(false);
  });
});
