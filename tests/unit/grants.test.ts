// Limited-session grants (grants.ts): the invite store, the per-route gate,
// and how a session's grants ride an existing password sign-in.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRANTS, InviteStore, invitesFileOf, makeRequireGrant } from "../../src/server/grants.js";
import { hashPassword } from "../../src/server/auth.js";
import { makeTestApp, PASS, USER, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const LAN = "192.168.1.50";
const lanHost = (port: number) => `${LAN}:${port}`;

describe("the invite store", () => {
  it("creates, lists, edits, and removes invitations", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-invites-"));
    const store = new InviteStore(invitesFileOf(dir));
    const invite = store.create("Phone", ["chat.read"]);
    expect(invite.grants).toEqual(["chat.read"]);
    expect(store.list().map((i) => i.name)).toEqual(["Phone"]);
    // Unknown grants are dropped on load, so a hand-edited file widens nothing.
    // The store's write is one async temp+rename; a fresh store (a restart) that reads
    // the landed file is the signal — each poll awaits that store's own load first.
    await vi.waitFor(
      async () => {
        const reloaded = new InviteStore(invitesFileOf(dir));
        await reloaded.loaded;
        expect(reloaded.get(invite.id)?.grants).toEqual(["chat.read"]);
      },
      20_000,
    );
    expect(store.update(invite.id, "Phone (read-only)", ["chat.read", "chat.approve"])?.grants).toEqual(["chat.read", "chat.approve"]);
    expect(store.update(invite.id, null, null)?.name).toBe("Phone (read-only)");
    expect(store.remove(invite.id)).toBe(true);
    expect(store.get(invite.id)).toBeNull();
    expect(store.remove(invite.id)).toBe(false);
  });

  it("round-trips through the state folder so a restart keeps them", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-invites-"));
    const file = invitesFileOf(dir);
    const first = new InviteStore(file);
    const invite = first.create("Tablet", ["chat.read", "chat.approve"]);
    // The store's write is one serialized temp+rename per file (state-file.ts); a fresh
    // store (a restart) reading the landed file is the signal here — deterministic time
    // control does not reach a fs rename, so each poll awaits that store's own load.
    await vi.waitFor(
      async () => {
        const again = new InviteStore(file);
        await again.loaded;
        expect(again.get(invite.id)?.name).toBe("Tablet");
        expect(again.get(invite.id)?.grants).toEqual(["chat.read", "chat.approve"]);
      },
      20_000,
    );
  });
});

describe("the per-route gate", () => {
  const gate = makeRequireGrant(async (req, res) => {
    void req;
    return (res.locals.grants as string[] | null) ?? null;
  });
  /**
   * What the gate did: `null` when it passed to next, else the refusal it answered with.
   * A refusal never continues (no next(error)): it answers on the response and stops, so
   * the two outcomes race — whichever settles first is the answer.
   */
  const call = (locals: Record<string, unknown>) => {
    const req = { headers: {} } as unknown as Request;
    let answered: { status: number; body: Record<string, unknown> } | null = null;
    const res: Response = {
      locals,
      status(s: number) {
        answered = { status: s, body: {} };
        return res;
      },
      json(b: Record<string, unknown>) {
        if (answered) answered.body = b;
        return undefined;
      },
    } as unknown as Response;
    // The gate's own promise settles in both cases (pass returns next()'s undefined,
    // refusal returns after answering); the answer is read once it has.
    return Promise.resolve(gate("chat.read")(req, res, () => undefined)).then(() => answered);
  };

  it("passes full sessions and sessions with the grant", async () => {
    await expect(call({ grants: null })).resolves.toBeNull();
    await expect(call({ grants: ["chat.read", "chat.write"] })).resolves.toBeNull();
  });

  it("refuses a limited session without the grant, naming it", async () => {
    // The gate answers a refusal on the response (403 missing_grant), never next(error).
    const answered = await call({ grants: ["chat.write"] });
    expect(answered?.status).toBe(403);
    expect(answered?.body.code).toBe("missing_grant");
    expect(answered?.body.grant).toBe("chat.read");
  });
});

describe("limited sign-ins end to end", () => {
  const signIn = async (invite?: string) => {
    const host = lanHost(t!.port);
    const res = await request(t!.server)
      .post("/api/login")
      .set("Host", host)
      .send({ username: USER, password: PASS, ...(invite ? { invite } : {}) });
    return String((res.headers["set-cookie"] as unknown as string[])[0]).split(";")[0] as string;
  };

  it("keeps a password sign-in full when no invitation is named", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN], withSettings: true });
    const ws = await request(t.server).post("/api/workspaces/open").send({ path: t.project });
    const wsId = (ws.body as { id: string }).id;
    const cookie = await signIn();
    const host = lanHost(t.port);
    const boot = await request(t.server).get("/api/bootstrap").set("Host", host).set("Cookie", cookie);
    expect(boot.status).toBe(200);
    expect(boot.body.grants).toBeNull();
    // Full: prompt and approve are reachable.
    const chat = await request(t.server).post("/api/chats").set("Host", host).set("Cookie", cookie).send({ harnessId: "fake", workspaceId: wsId });
    expect(chat.status).toBe(201);
    const chatId = (chat.body as { chatId: string }).chatId;
    const sent = await request(t.server).post(`/api/chats/${chatId}/messages`).set("Host", host).set("Cookie", cookie).send({ text: "hello" });
    expect(sent.status).toBe(202);
    // Settings: the server is on the network with a login (as the running server is), so
    // a remote full session keeps managing them (settings.ts's lockout only refuses a
    // save that would shut the saving device out).
    const onNetwork = await request(t.server).put("/api/settings").send({ host: "0.0.0.0", username: USER, password: PASS });
    expect(onNetwork.status).toBe(200);
    const settings = await request(t.server).put("/api/settings").set("Host", host).set("Cookie", cookie).send({ showStatusBar: true });
    expect(settings.status).toBe(200);
        const gitEdit = await request(t!.server).post(`/api/chats/${chatId}/git/stage`).set("Host", host).set("Cookie", cookie).send({ paths: ["src/app.ts"] });
    expect(gitEdit.status, JSON.stringify(gitEdit.body)).toBe(403);
    expect(gitEdit.body.code).toBe("local_only");
  });

  it("a read-only invitation reads but cannot prompt, approve, or manage settings", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    // The store is server-side; create one through the route with a full session first.
    const fullCookie = await signIn();
    const created = await request(t.server).post("/api/invites").set("Host", host).set("Cookie", fullCookie).send({ name: "Phone", grants: ["chat.read"] });
    const inviteId = (created.body as { invite: { id: string } }).invite.id;
    const limitedCookie = await signIn(inviteId);

    // Reads work.
    const boot = await request(t.server).get("/api/bootstrap").set("Host", host).set("Cookie", limitedCookie);
    expect(boot.status).toBe(200);
    expect(boot.body.grants).toEqual(["chat.read"]);
    const sessions = await request(t.server).get("/api/sessions").set("Host", host).set("Cookie", limitedCookie);
    expect(sessions.status).toBe(200);
    // The full session opened the project already; the workspace id is the same one.
    const opened = await request(t.server).post("/api/workspaces/open").send({ path: t.project });
    const wsId = (opened.body as { id: string }).id;

    // Prompting is refused: the gate fires before anything else.
    const chatCreate = await request(t.server).post("/api/chats").set("Host", host).set("Cookie", limitedCookie).send({ harnessId: "fake", workspaceId: wsId });
    expect(chatCreate.status).toBe(403);
    expect(chatCreate.body.code).toBe("missing_grant");

    // Approving is refused (grant was not given).
    const approve = await request(t.server).post("/api/chats/x/requests/r").set("Host", host).set("Cookie", limitedCookie).send({ answer: "approve" });
    expect(approve.status).toBe(403);

    // Settings are refused.
    const settings = await request(t.server).put("/api/settings").set("Host", host).set("Cookie", limitedCookie).send({ showStatusBar: true });
    expect(settings.status).toBe(403);
    const readSettings = await request(t.server).get("/api/settings").set("Host", host).set("Cookie", limitedCookie);
    expect(readSettings.status).toBe(403);

    // Workspace management is refused; the file list still reads.
    const open = await request(t.server).post("/api/workspaces/open").set("Host", host).set("Cookie", limitedCookie).send({ path: t.project });
    expect(open.status).toBe(403);
    const openedFirst = await request(t.server).post("/api/workspaces/open").send({ path: t.project });
    const openedId = (openedFirst.body as { id: string }).id;
    const files = await request(t.server).get(`/api/workspaces/${openedId}/files`).set("Host", host).set("Cookie", limitedCookie);
    expect(files.status).toBe(200);
  });

  it("revoking an invitation cuts its sessions off at once", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    const fullCookie = await signIn();
    const created = await request(t.server).post("/api/invites").set("Host", host).set("Cookie", fullCookie).send({ name: "Phone", grants: ["chat.read"] });
    const inviteId = (created.body as { invite: { id: string } }).invite.id;
    const limitedCookie = await signIn(inviteId);
    expect((await request(t.server).get("/api/sessions").set("Host", host).set("Cookie", limitedCookie)).status).toBe(200);
    // Revoke; the same cookie now resolves to an empty allow list.
    const revoked = await request(t.server).delete(`/api/invites/${inviteId}`).set("Host", host).set("Cookie", fullCookie);
    expect(revoked.status).toBe(200);
    const after = await request(t.server).get("/api/sessions").set("Host", host).set("Cookie", limitedCookie);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("missing_grant");
    // A sign-in naming the dead invitation is a full session again (no live invitation named).
    const renewedCookie = await signIn(inviteId);
    expect((await request(t.server).get("/api/sessions").set("Host", host).set("Cookie", renewedCookie)).status).toBe(200);
    expect((await request(t.server).get("/api/bootstrap").set("Host", host).set("Cookie", renewedCookie)).body.grants).toBeNull();
  });

  it("a limited session cannot mint itself a wider invitation", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    const fullCookie = await signIn();
    const created = await request(t.server).post("/api/invites").set("Host", host).set("Cookie", fullCookie).send({ name: "Phone", grants: ["chat.read"] });
    const inviteId = (created.body as { invite: { id: string } }).invite.id;
    const limitedCookie = await signIn(inviteId);
    const widen = await request(t.server).post("/api/invites").set("Host", host).set("Cookie", limitedCookie).send({ name: "Wide", grants: [...GRANTS] });
    expect(widen.status).toBe(403);
    const list = await request(t.server).get("/api/invites").set("Host", host).set("Cookie", limitedCookie);
    expect(list.status).toBe(403);
  });

  it("an unknown invitation id signs in as a full session, not an empty one", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    const cookie = await signIn("no-such-invite");
    const boot = await request(t.server).get("/api/bootstrap").set("Host", host).set("Cookie", cookie);
    expect(boot.status).toBe(200);
    expect(boot.body.grants).toBeNull();
  });
});
