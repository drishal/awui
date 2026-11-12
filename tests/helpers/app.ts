import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createApp } from "../../src/server/app.js";
import { hashPassword, PasswordAuth } from "../../src/server/auth.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { RoomManager } from "../../src/server/boards/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import type { Herdr } from "../../src/server/herdr.js";
import { Security } from "../../src/server/security.js";
import type { InteractionRequest, PushNote } from "../../src/shared/protocol.js";
import { ThemeStore } from "../../src/server/theme.js";
import { Workspaces } from "../../src/server/workspaces.js";
import { TerminalManager } from "../../src/server/terminal.js";
import { DEFAULT_ORCHESTRATION_LIMITS, type OrchestrationLimits } from "../../src/server/orchestration/limits.js";
import { SecondOpinions } from "../../src/server/second-opinions.js";
import type { RoutineRuns } from "../../src/server/routine-runs.js";
import type { ResumeIntents } from "../../src/server/resume-intent.js";

export const USER = "alice";
export const PASS = "correct horse battery";

export function tempDir(prefix = "awui-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  /** Listening server: cookies are bound to host:port, so reuse one port. */
  server: http.Server;
  port: number;
  close(): Promise<void>;
  manager: ChatManager;
  registry: HarnessRegistry;
  root: string;
  project: string;
  security: Security;
  fake: FakeAdapter;
  boards: RoomManager;
  stateDir: string;
  workspaces: Workspaces;
  boardNotes: Array<{ kind: PushNote["kind"]; roomId: string; title: string; body: string; request?: InteractionRequest }>;
}

export async function makeTestApp(options: {
  allowedHosts?: string[];
  allowedTailscaleUsers?: string[];
  /** Configure a login so other devices can sign in. */
  withPassword?: boolean;
  /** Hostnames treated as this machine's LAN addresses (HOST=0.0.0.0). */
  lanHosts?: string[];
  themeFile?: string | null;
  chunkDelayMs?: number;
  heartbeatMs?: number;
  /** Watch the room-level notes the manager sends (in place of ordinary per-chat news). */
  onBoardNote?: (note: { kind: PushNote["kind"]; roomId: string; title: string; body: string; request?: InteractionRequest }) => void;
  /** Fake B cannot store past turns (as Hermes and Claude Code): handoffs to it are briefings. */
  fakeBBriefOnly?: boolean;
  /** The fake harness takes this long to stop a run (the stop-timeout test). */
  fakeStopDelayMs?: number;
  /** Serve the Settings routes over a config.yml in this test's own settings folder. */
  withSettings?: boolean;
  /** Keep file checkpoints (in this test's own folder). */
  withCheckpoints?: boolean;
  /** Start tests needing a real PTY lifecycle; shuts down in close(). */
  withTerminal?: boolean;
  /** Herdr's panes (a stand-in socket's); none otherwise, whatever herdr runs on this machine. */
  herdr?: Herdr;
  /** The orchestration surface's limits, over the built-in defaults (config.yml's `orchestration:`). */
  orchestrationLimits?: Partial<OrchestrationLimits>;
  /** The routines' run history, when a test drives a routine itself (in memory otherwise). */
  routineRuns?: RoutineRuns;
  /** The sessions a previous process left running, when a test drives the resume itself. */
  resumeIntents?: ResumeIntents;
} = {}): Promise<TestApp> {
  const root = tempDir();
  const project = path.join(root, "proj");
  mkdirSync(project);
  const registry = new HarnessRegistry();
  const fake = new FakeAdapter({ chunkDelayMs: options.chunkDelayMs ?? 2, ...(options.fakeStopDelayMs ? { stopDelayMs: options.fakeStopDelayMs } : {}) });
  registry.register(fake);
  registry.register(
    new FakeAdapter({ id: "fake-b", displayName: "Fake B", capabilities: { supportsSteer: false, supportsRewind: false, supportsPermissionMode: false, supportsResumeCommand: false, ...(options.fakeBBriefOnly ? { supportsHandoff: false } : {}) } }),
  );
  await registry.refreshStatus();
  const { workspaces } = await Workspaces.create([root], root);
  // The orchestration limits this app runs under, as config.yml's `orchestration:` block would set them.
  const orchLimits: OrchestrationLimits = { ...DEFAULT_ORCHESTRATION_LIMITS, ...options.orchestrationLimits };
  const orchestrationLimits = () => orchLimits;
  const lan = options.lanHosts ? new Set(options.lanHosts) : null;
  const security = new Security({
    port: 4783,
    allowedHosts: options.allowedHosts ?? [],
    allowedTailscaleUsers: options.allowedTailscaleUsers ?? [],
    secret: randomBytes(32),
    ...(options.withPassword ? { password: new PasswordAuth(await hashPassword(USER, PASS)) } : {}),
    ...(lan ? { lanHosts: () => lan } : {}),
  });
  const manager = new ChatManager();
  const stateDir = path.join(root, ".state");
  const terminals = options.withTerminal ? new TerminalManager() : undefined;
  const boardNotes: TestApp["boardNotes"] = [];
  const boards = new RoomManager({
    registry,
    workspaces,
    chats: manager,
    stateDir,
    log: () => undefined,
    notify: (note) => {
      boardNotes.push(note);
      options.onBoardNote?.(note);
    },
  });
  await boards.start();
  const app = createApp({
    version: "test",
    home: root,
    registry,
    manager,
    workspaces,
    security,
    theme: new ThemeStore(options.themeFile ?? null, options.themeFile != null, () => undefined),
    pairingUrls: [],
    webDir: null,
    heartbeatMs: options.heartbeatMs ?? 20_000,
    stateDir,
    secondOpinions: await SecondOpinions.open(stateDir),
    orchestrationLimits,
    ...(options.routineRuns ? { routineRuns: options.routineRuns } : {}),
    ...(options.resumeIntents ? { resumeIntents: options.resumeIntents } : {}),
    ...(terminals ? { terminals } : {}),
    boards,
    ...(options.herdr ? { herdr: options.herdr } : {}),
    ...(options.withCheckpoints ? { checkpointsDir: path.join(root, ".state", "checkpoints") } : {}),
    ...(options.withSettings
      ? {
          settings: {
            configDir: path.join(root, "settings"),
            running: { port: 4783, host: "127.0.0.1" as const, username: "", password: null, workspaceRoots: [root], allowedHosts: [], allowedTailscaleUsers: [], acpAgents: "[]" },
            envSet: new Set<string>(),
            credentialsFile: path.join(root, "credentials.json"),
            canRestart: false,
            home: root,
          },
        }
      : {}),
    log: () => undefined,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  manager.render = { baseUrl: `http://127.0.0.1:${port}` };
  manager.orchestration = { baseUrl: `http://127.0.0.1:${port}`, enabled: () => orchLimits.enabled };
  const close = async () => {
    terminals?.shutdown();
    await boards.shutdown();
    await manager.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { app, server, port, close, manager, registry, root, project, security, fake, boards, stateDir, workspaces, boardNotes };
}

/** A supertest agent on this machine: local requests need no sign-in. */
export async function signedIn(t: TestApp) {
  const agent = request.agent(t.server);
  return Object.assign(agent, { cookie: "" });
}

export interface SseMessage {
  id?: number;
  event: string;
  data: unknown;
}

/** Minimal SSE reader for tests. */
export function openSse(t: TestApp, chatId: string, cookie: string, lastEventId?: number, resource?: string) {
  const messages: SseMessage[] = [];
  const url = resource ?? `/api/chats/${chatId}/events`;
  let ended = false;
  const query = lastEventId !== undefined ? `?lastEventId=${lastEventId}` : "";
  const req = http.get(
    { host: "127.0.0.1", port: t.port, path: `${url}${query}`, headers: { cookie } },
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
  const chatEvents = () => messages.filter((m) => m.event === "chat").map((m) => m.data as { type: string } & Record<string, unknown>);
  return {
    messages,
    chatEvents,
    get ended() {
      return ended;
    },
    lastId: () => [...messages].reverse().find((m) => m.id !== undefined)?.id,
    close: () => req.destroy(),
    async waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for SSE condition");
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}
