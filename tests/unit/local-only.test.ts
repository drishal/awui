// This machine's checkout and pull requests are its own: a signed-in device
// elsewhere may read project git status, but every write route answers
// `403 local_only` — the git panel's stage/commit and, since the same audit,
// push, PR create, a stack's push and merge, a PR worktree checkout, and the
// applies into the lead checkout (a reviewed worker, a race winner).
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { makeTestApp, PASS, signedIn, tempDir, USER, type TestApp } from "../helpers/app.js";

const LAN = "192.168.1.50";

let t: TestApp | null = null;
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await t?.close();
  t = null;
});

const runGit = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A project repo with a bare origin, a pushed branch, and a fake gh on PATH: the local writes can succeed. */
function gitFixture(project: string): void {
  const remote = tempDir("awui-local-only-remote-");
  runGit(remote, "init", "--bare", "-q");
  runGit(project, "init", "-q");
  runGit(project, "checkout", "-q", "-b", "main");
  runGit(project, "config", "user.email", "test@example.invalid");
  runGit(project, "config", "user.name", "test");
  writeFileSync(path.join(project, "a.txt"), "hello\n");
  runGit(project, "add", "a.txt");
  runGit(project, "commit", "-qm", "base");
  runGit(project, "checkout", "-q", "-b", "feature");
  writeFileSync(path.join(project, "b.txt"), "changed\n");
  runGit(project, "add", "b.txt");
  runGit(project, "commit", "-qm", "change");
  runGit(project, "remote", "add", "origin", remote);
  runGit(project, "push", "-q", "-u", "origin", "feature");
  // One commit ahead of the pushed branch: a refused push leaves the remote behind.
  writeFileSync(path.join(project, "c.txt"), "later\n");
  runGit(project, "add", "c.txt");
  runGit(project, "commit", "-qm", "later");
  const bin = tempDir("awui-local-only-bin-");
  const gh = path.join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === "auth") process.exit(0);\nif (args[0] === "pr" && args[1] === "create") { console.log("https://github.com/example/repo/pull/42"); process.exit(0); }\nif (args[0] === "pr" && args[1] === "view") { console.log(JSON.stringify({ url: "https://github.com/example/repo/pull/42", title: "Audit", state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "feature" })); process.exit(0); }\nprocess.exit(2);\n`,
  );
  chmodSync(gh, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

async function app() {
  t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
  const server = t.server;
  const local = await signedIn(t);
  const remoteCookie = String(
    (await request(server).post("/api/login").set("Host", `${LAN}:${t.port}`).send({ username: USER, password: PASS })).headers["set-cookie"] as unknown as string[],
  ).split(";")[0] as string;
  const host = `${LAN}:${t.port}`;
  // A remote request: the LAN Host names a remote principal even from a loopback peer.
  const remote = {
    post: (url: string, body?: object) => request(server).post(url).set("Host", host).set("Cookie", remoteCookie).send(body ?? {}),
    get: (url: string) => request(server).get(url).set("Host", host).set("Cookie", remoteCookie),
    delete: (url: string) => request(server).delete(url).set("Host", host).set("Cookie", remoteCookie),
  };
  return { t, local, remote };
}

describe("write routes need this machine", () => {
  it("refuses every checkout and pull-request write to a full remote session", async () => {
    const { t, local, remote } = await app();
    gitFixture(t.project);
    const ws = (await local.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await local.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const writes: Array<[string, object]> = [
      [`/api/chats/${chat.chatId}/git/stage`, { paths: ["a.txt"] }],
      [`/api/workspaces/${ws.id}/github/push`, {}],
      [`/api/workspaces/${ws.id}/github/pr`, { base: "main", title: "Audit" }],
      [`/api/workspaces/${ws.id}/pr-stack`, { base: "main", title: "Layer", push: false }],
      [`/api/workspaces/${ws.id}/pr-stack/stack-1/merge`, {}],
      [`/api/workspaces/${ws.id}/worktrees/checkout-pr`, { pr: 42, name: "audit-pr" }],
      [`/api/chats/${chat.chatId}/tasks/abcd1234/review`, { decision: "apply", workspaceId: ws.id }],
      [`/api/races/race-1/winner`, { chatId: chat.chatId, mode: "apply" }],
    ];
    for (const [url, body] of writes) {
      const res = await remote.post(url, body);
      expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.code, url).toBe("local_only");
    }
    // A remote refusal changed nothing on this machine: the branch is still unpushed,
    // no stack or worktree was recorded, and a read still works.
    expect(runGit(t.project, "rev-list", "--count", "origin/feature..feature")).toBe("1\n");
    // Reads stay open to the same remote session, and the checkout is untouched.
    expect((await remote.get(`/api/workspaces/${ws.id}/worktrees`)).status).toBe(200);
    expect(runGit(t.project, "status", "--porcelain")).toBe("");
  });

  it("lets this machine do the same writes", async () => {
    const { t, local } = await app();
    gitFixture(t.project);
    const ws = (await local.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const pushed = await local.post(`/api/workspaces/${ws.id}/github/push`).send({});
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body.upstream).toBe("origin/feature");
    const pr = await local.post(`/api/workspaces/${ws.id}/github/pr`).send({ base: "main", title: "Audit", body: "Verified" });
    expect(pr.status).toBe(201);
    expect(pr.body.url).toBe("https://github.com/example/repo/pull/42");
    const checkout = await local.post(`/api/workspaces/${ws.id}/worktrees/checkout-pr`).send({ pr: 42, name: "audit-pr" });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    // The stack merge and the review apply are real writes with their own records;
    // locally they get past this guard and fail on their own domain checks instead.
    const merge = await local.post(`/api/workspaces/${ws.id}/pr-stack/stack-1/merge`).send({});
    expect(merge.status).toBe(404);
    expect(merge.body.code).not.toBe("local_only");
    const chat = (await local.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const review = await local.post(`/api/chats/${chat.chatId}/tasks/abcd1234/review`).send({ decision: "apply", workspaceId: ws.id });
    expect(review.status).toBe(404);
    expect(review.body.code).not.toBe("local_only");
  });
});
