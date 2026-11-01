// Board test helpers: a signed-in agent, a workspace, bots and a room through
// the real routes, a room SSE reader, and small waits. The server is the one
// makeTestApp builds, so these tests exercise the same wiring production uses.
import http from "node:http";
import type { BotProfile, RoomInfo, RoomSnapshot, WorkspaceInfo } from "../../src/shared/protocol.js";
import type { SseMessage, TestApp } from "./app.js";
import { signedIn } from "./app.js";

type Agent = Awaited<ReturnType<typeof signedIn>>;

export async function agent(t: TestApp): Promise<Agent> {
  return signedIn(t);
}

export async function openProject(t: TestApp, a: Agent): Promise<WorkspaceInfo> {
  const res = await a.post("/api/workspaces/open").send({ path: t.project });
  if (res.status !== 200) throw new Error(`workspace open failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as WorkspaceInfo;
}

export async function makeBot(a: Agent, input: Partial<{ name: string; harnessId: string; model: string; thinkingLevel: string; instructions: string; role: string; permissionMode: string }> = {}): Promise<BotProfile> {
  const res = await a.post("/api/bots").send({ name: input.name ?? "Bot", harnessId: input.harnessId ?? "fake", ...input });
  if (res.status !== 201) throw new Error(`bot create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as BotProfile;
}

export async function makeRoom(
  a: Agent,
  workspaceId: string,
  members: Array<{ botId: string; handle?: string; rank?: number; canLead?: boolean; consultable?: boolean; consultants?: string[] }>,
  options: { name?: string; leadBotId?: string } = {},
): Promise<RoomSnapshot> {
  const res = await a.post("/api/rooms").send({ name: options.name ?? "Room", workspaceId, members, ...(options.leadBotId ? { leadBotId: options.leadBotId } : {}) });
  if (res.status !== 201) throw new Error(`room create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as RoomSnapshot;
}

export async function snapshot(a: Agent, roomId: string): Promise<RoomSnapshot> {
  const res = await a.get(`/api/rooms/${roomId}`);
  if (res.status !== 200) throw new Error(`room snapshot failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as RoomSnapshot;
}

export async function patchMember(a: Agent, roomId: string, memberId: string, patch: Record<string, unknown>): Promise<RoomInfo> {
  const res = await a.patch(`/api/rooms/${roomId}/members/${memberId}`).send(patch);
  if (res.status !== 200) throw new Error(`member patch failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as RoomInfo;
}

export async function send(a: Agent, roomId: string, text: string, mentions: string[] = [], clientId?: string): Promise<{ turn: { id: string; state: string }; queued: Array<{ id: string; state: string }> }> {
  const res = await a.post(`/api/rooms/${roomId}/messages`).send({ text, mentions, ...(clientId ? { clientId } : {}) });
  if (res.status !== 202) throw new Error(`message failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Wait for a real server-side state change, not a guessed duration. The
 * deadline matches vitest's testTimeout: under the full suite's forked
 * parallelism a multi-invocation turn can take many wall-clock seconds, and
 * the deadline only bounds a hang — the predicate decides pass or fail.
 */
export async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the server state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Wait until a room's newest records satisfy `done`, polling the snapshot (bounded). A timeout names the turn's state and the records seen, so a hang says where it stopped. */
export async function waitRecords(a: Agent, roomId: string, done: (snap: RoomSnapshot) => boolean, timeoutMs = 20_000): Promise<RoomSnapshot> {
  const started = Date.now();
  for (;;) {
    const snap = await snapshot(a, roomId);
    if (done(snap)) return snap;
    if (Date.now() - started > timeoutMs) {
      const turn = snap.activeTurn ? `${snap.activeTurn.state} (${snap.activeTurn.invocationCount} invocations)` : "none";
      const kinds = snap.records.map((record) => record.kind).join(",") || "no records";
      throw new Error(`timed out waiting for room ${roomId}: turn ${turn}, records [${kinds}]`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function botRuns(snap: RoomSnapshot): Array<Extract<RoomSnapshot["records"][number], { kind: "bot_run" }>> {
  return snap.records.filter((record): record is Extract<RoomSnapshot["records"][number], { kind: "bot_run" }> => record.kind === "bot_run");
}

export function notices(snap: RoomSnapshot): string[] {
  return snap.records.filter((record) => record.kind === "notice").map((record) => (record.kind === "notice" ? record.text : ""));
}

/** The room stream, with the same reader shape the chat SSE helper has. */
export function openRoomSse(t: TestApp, roomId: string, cookie: string, lastEventId?: number) {
  const messages: SseMessage[] = [];
  let ended = false;
  const query = lastEventId !== undefined ? `?lastEventId=${lastEventId}` : "";
  const req = http.get(
    { host: "127.0.0.1", port: t.port, path: `/api/rooms/${roomId}/events${query}`, headers: { cookie } },
    (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const msg: SseMessage = { event: "message", data: null };
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("id: ")) msg.id = Number(line.slice(4));
            else if (line.startsWith("event: ")) msg.event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) {
            msg.data = JSON.parse(data);
            messages.push(msg);
          }
        }
      });
      res.on("end", () => {
        ended = true;
      });
    },
  );
  req.on("error", () => {
    ended = true;
  });
  const roomEvents = () => messages.filter((m) => m.event === "room").map((m) => m.data as { type: string } & Record<string, unknown>);
  return {
    messages,
    roomEvents,
    get ended() {
      return ended;
    },
    lastId: () => [...messages].reverse().find((m) => m.id !== undefined)?.id,
    close: () => req.destroy(),
    async waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for a room SSE condition");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

export type { Agent };
