// Limited-session grants (grants.ts): the invite store, the per-route gate,
// and the invitation's own secret as the only way a session becomes limited.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRANTS, InviteStore, invitesFileOf, makeRequireGrant } from "../../src/server/grants.js";
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
    const { invite, secret } = await store.create("Phone", ["chat.read"]);
    expect(invite.grants).toEqual(["chat.read"]);
    expect(store.list().map((i) => i.name)).toEqual(["Phone"]);
    // The secret is 256 random bits; the file keeps only its SHA-256 hash, and the
    // presented secret verifies against it (constant-time on the two hashes).
    expect(await store.verifySecret(invite.id, secret)).toBe(true);
    expect(await store.verifySecret(invite.id, `${secret.slice(0, -1)}A`)).toBe(false);
    expect(await store.verifySecret("no-such-invite", secret)).toBe(false);
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
    const file = readFileSync(invitesFileOf(dir), "utf8");
    expect(file).not.toContain(secret);
    expect(file).toContain(createHash("sha256").update(secret).digest("hex"));
    // The list and the record never carry the secret itself.
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
    const { invite } = await first.create("Tablet", ["chat.read", "chat.approve"]);
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
  /** The owner's password sign-in: always a full session. */
  const signIn = async (invite?: string) => {
    const host = lanHost(t!.port);
    const res = await request(t!.server)
      .post("/api/login")
      .set("Host", host)
      .send({ username: USER, password: PASS, ...(invite ? { invite } : {}) });
    return String((res.headers["set-cookie"] as unknown as string[])[0]).split(";")[0] as string;
  };

  /** One invitation created through the route; its secret comes back only in this answer. */
  const createInvite = async (fullCookie: string, name: string, grants: string[]) => {
    const host = lanHost(t!.port);
    const created = await request(t!.server).post("/api/invites").set("Host", host).set("Cookie", fullCookie).send({ name, grants });
    return created.body as { invite: { id: string }; secret: string; url: string };
  };

  /** The invitation's own sign-in: its id and secret, never the owner's password. */
  const inviteSignIn = async (inviteId: string, secret: string) => {
    const host = lanHost(t!.port);
    return request(t!.server).post("/api/login").set("Host", host).send({ invite: inviteId, inviteSecret: secret });
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
    const created = await createInvite(fullCookie, "Phone", ["chat.read"]);
    expect(created.url.startsWith("/login?invite=")).toBe(true);
    expect(created.url).toContain(`key=${created.secret}`);
    const limitedCookie = String((await inviteSignIn(created.invite.id, created.secret)).headers["set-cookie"] as unknown as string[]).split(";")[0] as string;
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

  it("revoking an invitation ends its sign-in as well as its sessions", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    const fullCookie = await signIn();
    const created = await createInvite(fullCookie, "Phone", ["chat.read"]);
    const limitedCookie = String((await inviteSignIn(created.invite.id, created.secret)).headers["set-cookie"] as unknown as string[]).split(";")[0] as string;
    expect((await request(t.server).get("/api/sessions").set("Host", host).set("Cookie", limitedCookie)).status).toBe(200);
    // Revoke; the same cookie now resolves to an empty allow list.
    const revoked = await request(t.server).delete(`/api/invites/${created.invite.id}`).set("Host", host).set("Cookie", fullCookie);
    expect(revoked.status).toBe(200);
    const after = await request(t.server).get("/api/sessions").set("Host", host).set("Cookie", limitedCookie);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("missing_grant");
    // Nothing can sign in with it again: the secret is checked against a store that no
    // longer has the invitation, and the attempt mints no cookie.
    const renewed = await inviteSignIn(created.invite.id, created.secret);
    expect(renewed.status).toBe(401);
    expect(renewed.body.code).toBe("bad_invite");
    expect(renewed.headers["set-cookie"]).toBeUndefined();
    // The owner's own password sign-in is unchanged: still a full session.
    expect((await request(t.server).get("/api/bootstrap").set("Host", host).set("Cookie", await signIn())).body.grants).toBeNull();
  });

  it("a limited session cannot mint itself a wider invitation", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    const fullCookie = await signIn();
    const created = await createInvite(fullCookie, "Phone", ["chat.read"]);
    const limitedCookie = String((await inviteSignIn(created.invite.id, created.secret)).headers["set-cookie"] as unknown as string[]).split(";")[0] as string;
    const widen = await request(t.server).post("/api/invites").set("Host", host).set("Cookie", limitedCookie).send({ name: "Wide", grants: [...GRANTS] });
    expect(widen.status).toBe(403);
    const list = await request(t.server).get("/api/invites").set("Host", host).set("Cookie", limitedCookie);
    expect(list.status).toBe(403);
  });

  it("refuses a wrong secret, an unknown invitation, and a password that names one is still full", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN] });
    const host = lanHost(t.port);
    const fullCookie = await signIn();
    const created = await createInvite(fullCookie, "Phone", ["chat.read"]);
    // A wrong secret for a live invitation, and a secret for an unknown one: both 401,
    // with no cookie minted (the invitation is the credential, not a label).
    const wrong = await inviteSignIn(created.invite.id, `${created.secret.slice(0, -2)}AA`);
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("bad_invite");
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    const unknown = await inviteSignIn("no-such-invite", created.secret);
    expect(unknown.status).toBe(401);
    // An id alone (no secret) is not a sign-in: it is the owner's own password login,
    // which is full access as it always was — the invitation names nothing.
    const owner = await signIn(created.invite.id);
    const boot = await request(t.server).get("/api/bootstrap").set("Host", host).set("Cookie", owner);
    expect(boot.status).toBe(200);
    expect(boot.body.grants).toBeNull();
  });
});
