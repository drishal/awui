// Bot and room CRUD through the real routes: profiles validate their harness
// and capability claims, rooms validate their workspace, handles are unique
// per room, ranks and allowlists are room-local, the lead rule is explicit, and
// a profile still used by a room cannot be deleted out from under it.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/app.js";
import { agent, makeBot, makeRoom, openProject, patchMember } from "../helpers/board.js";

describe("bot profiles", () => {
  it("creates, lists, and patches a profile with an honest revision", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const created = await makeBot(a, { name: "Atlas", role: "lead", instructions: "Be terse." });
      expect(created).toMatchObject({ name: "Atlas", harnessId: "fake", model: null, thinkingLevel: null, role: "lead", instructions: "Be terse.", revision: 1 });
      const patched = await a.patch(`/api/bots/${created.id}`).send({ name: "Atlas II", model: "fake/slow", thinkingLevel: "high" });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: "Atlas II", model: "fake/slow", thinkingLevel: "high", revision: 2 });
      const list = await a.get("/api/bots");
      expect(list.body).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("refuses an unknown harness and settings the harness cannot enforce", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      expect((await a.post("/api/bots").send({ name: "Nope", harnessId: "missing" })).status).toBe(404);
      const unsupported = await a.post("/api/bots").send({ name: "Modes", harnessId: "fake-b", permissionMode: "default" });
      expect(unsupported.status).toBe(422);
      expect(unsupported.body.code).toBe("unsupported_setting");
    } finally {
      await t.close();
    }
  });

  it("deletes only a profile no room uses", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const unused = await makeBot(a, { name: "Unused" });
      expect((await a.delete(`/api/bots/${unused.id}`)).status).toBe(200);
      const used = await makeBot(a, { name: "Used" });
      await makeRoom(a, ws.id, [{ botId: used.id, handle: "used" }]);
      const refused = await a.delete(`/api/bots/${used.id}`);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("bot_in_use");
    } finally {
      await t.close();
    }
  });
});

describe("rooms and memberships", () => {
  it("creates a room with a lead and default handles, and lists it", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas Bot" });
      const scout = await makeBot(a, { name: "Scout" });
      const snap = await makeRoom(a, ws.id, [{ botId: lead.id }, { botId: scout.id, rank: 2 }]);
      expect(snap.room.workspaceId).toBe(ws.id);
      expect(snap.room.members.map((member) => member.handle)).toEqual(["atlas-bot", "scout"]);
      expect(snap.room.leadMemberId).toBe(snap.room.members[0]?.id);
      expect(snap.room.members[1]?.rank).toBe(2);
      const rooms = await a.get("/api/rooms");
      expect(rooms.body).toHaveLength(1);
      expect(rooms.body[0]).toMatchObject({ id: snap.room.id, memberCount: 2, status: "idle" });
    } finally {
      await t.close();
    }
  });

  it("validates the workspace, duplicate handles, premature allowlists, and the lead rule", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas" });
      expect((await a.post("/api/rooms").send({ name: "R", workspaceId: "nope", members: [{ botId: lead.id }] })).status).toBe(404);
      expect((await a.post("/api/workspaces/open").send({ path: "/" })).status).toBe(403);
      const duplicate = await a.post("/api/rooms").send({ name: "R", workspaceId: ws.id, members: [{ botId: lead.id, handle: "same" }, { botId: lead.id, handle: "same" }] });
      expect(duplicate.status).toBe(409);
      const allowlist = await a.post("/api/rooms").send({ name: "R", workspaceId: ws.id, members: [{ botId: lead.id, consultants: ["x"] }] });
      expect(allowlist.status).toBe(400);
      const notLead = await a.post("/api/rooms").send({ name: "R", workspaceId: ws.id, members: [{ botId: lead.id, canLead: false }], leadBotId: lead.id });
      expect(notLead.status).toBe(400);
    } finally {
      await t.close();
    }
  });

  it("edits rank, handle, allowlists, and enabled state, and clears a lead that becomes ineligible", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas" });
      const scout = await makeBot(a, { name: "Scout" });
      const snap = await makeRoom(a, ws.id, [
        { botId: lead.id, handle: "atlas" },
        { botId: scout.id, handle: "scout", rank: 1 },
      ]);
      const [atlas, scoutMember] = snap.room.members;
      const patched = await patchMember(a, snap.room.id, scoutMember!.id, { handle: "scout-2", rank: 0, canLead: true });
      expect(patched.members.find((member) => member.id === scoutMember!.id)).toMatchObject({ handle: "scout-2", rank: 0, canLead: true });
      expect((await a.patch(`/api/rooms/${snap.room.id}/members/${scoutMember!.id}`).send({ handle: "atlas" })).status).toBe(409);
      expect((await a.patch(`/api/rooms/${snap.room.id}/members/${scoutMember!.id}`).send({ consultants: [scoutMember!.id] })).status).toBe(400);
      expect((await a.patch(`/api/rooms/${snap.room.id}/members/${scoutMember!.id}`).send({ consultants: ["ghost"] })).status).toBe(400);
      const withAllowlist = await patchMember(a, snap.room.id, atlas!.id, { consultants: [scoutMember!.id] });
      expect(withAllowlist.members.find((member) => member.id === atlas!.id)?.consultants).toEqual([scoutMember!.id]);
      const demoted = await patchMember(a, snap.room.id, atlas!.id, { canLead: false });
      expect(demoted.leadMemberId).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("removes a member and refuses to remove or reset a running one", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas" });
      const scout = await makeBot(a, { name: "Scout" });
      const snap = await makeRoom(a, ws.id, [
        { botId: lead.id, handle: "atlas" },
        { botId: scout.id, handle: "scout" },
      ]);
      const [atlas, scoutMember] = snap.room.members;
      await patchMember(a, snap.room.id, atlas!.id, { consultants: [scoutMember!.id] });
      const removed = await a.delete(`/api/rooms/${snap.room.id}/members/${scoutMember!.id}`);
      expect(removed.status).toBe(200);
      expect(removed.body.members).toHaveLength(1);
      expect(removed.body.members[0].consultants).toEqual([]);
      const reset = await a.post(`/api/rooms/${snap.room.id}/members/${atlas!.id}/reset`);
      expect(reset.status).toBe(200);
    } finally {
      await t.close();
    }
  });

  it("does not acknowledge a message whose record could not be written", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      const records = path.join(t.stateDir, "boards", "rooms", room.room.id, "records.jsonl");
      // A folder where the records file belongs makes the durable append fail.
      await mkdir(records, { recursive: true });
      try {
        const sent = await a.post(`/api/rooms/${room.room.id}/messages`).send({ text: "will not be acked", mentions: [] });
        expect(sent.status).toBe(500);
        expect(sent.body.code).toBe("board_store_read");
      } finally {
        await rm(records, { recursive: true, force: true });
      }
      const snap = await t.boards.roomSnapshot(room.room.id);
      expect(snap.queued).toHaveLength(0);
      expect(snap.records).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("enforces budgets, archives, and refuses a send while archived", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas" });
      const scout = await makeBot(a, { name: "Scout" });
      const snap = await makeRoom(a, ws.id, [
        { botId: lead.id, handle: "atlas" },
        { botId: scout.id, handle: "scout" },
      ]);
      const limited = await a.patch(`/api/rooms/${snap.room.id}`).send({ budgets: { maxDirectResponders: 1 } });
      expect(limited.status).toBe(200);
      const tooMany = await a.post(`/api/rooms/${snap.room.id}/messages`).send({ text: "x", mentions: snap.room.members.map((member) => member.id) });
      expect(tooMany.status).toBe(400);
      expect((await a.patch(`/api/rooms/${snap.room.id}`).send({ archived: true })).status).toBe(200);
      const blocked = await a.post(`/api/rooms/${snap.room.id}/messages`).send({ text: "x", mentions: [] });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("archived");
      expect((await a.patch(`/api/rooms/${snap.room.id}`).send({ archived: false })).status).toBe(200);
      expect((await a.patch(`/api/rooms/${snap.room.id}`).send({ leadMemberId: "ghost" })).status).toBe(400);
    } finally {
      await t.close();
    }
  });
});
