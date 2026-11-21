// Interactive shell in a user's validated project. This is not a harness
// run or an arbitrary command route: the user explicitly opens one bounded
// PTY (5/workspace, 30 openings/minute), and writes only their real input.
// Browser close/disconnect and explicit Close own process-tree cleanup;
// natural exit leaves a 1 MiB replay for 60s, then evicts it. Nothing logs.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { WorkspaceInfo } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { IS_WINDOWS } from "./platform-win.js";
import { spawnPty, type ProjectPty } from "./terminal-backend.js";
import type { IDisposable } from "@lydell/node-pty";

export type TerminalSubscriber = { onOutput: (data: string) => void; onExit: (code: number, signal?: number) => void };

/**
 * One terminal on a mesh peer, as the rest of the server sees it (the proxy in
 * mesh/peer-terms.ts): the same surface a local record exposes to the routes.
 * Input and output are strings over the same REST/SSE contract — no command
 * forwarding, the same as a local PTY.
 */
export interface PeerTerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  subscribe(subscriber: TerminalSubscriber): () => void;
  /**
   * Fired once when the proxy is done with itself — the terminal exited, was
   * closed, or lost its last subscriber — so the manager can drop its record
   * exactly when the peer's terminal is no longer reachable.
   */
  onGone(listener: () => void): void;
}

/** What TerminalManager needs to open a peer terminal; implemented by mesh/peer-terms.ts. */
export interface PeerTermsHook {
  open(peer: string, peerCwd: string, cols: number, rows: number): Promise<{ id: string; createdAt: number; handle: PeerTerminalHandle }>;
}

export interface TerminalManagerOpts {
  /** P3 remote terminals: a create request naming a peer opens one through here instead of locally. */
  peerTerms?: PeerTermsHook;
  /** Test seam: the pty spawner, so a fake pty can stand in where node-pty cannot run. */
  spawn?: typeof spawnPty;
}

const MAX_PER_WORKSPACE = 5;
const MAX_CREATES_PER_MINUTE = 30;
const REPLAY_CAP = 1024 * 1024;
const REPLAY_KEEP_MS = 60_000;
const MAX_WRITE = 64 * 1024;
const WRITE_CHUNK = 16 * 1024;
const KILL_ESCALATE_MS = 3_000;

interface TerminalRecord {
  id: string;
  workspaceId: string;
  createdAt: number;
  cols: number;
  rows: number;
  pty: ProjectPty;
  replay: string;
  exited: boolean;
  exit: { code: number; signal?: number } | null;
  subscribers: Set<TerminalSubscriber>;
  dataDispose: IDisposable | null;
  exitDispose: IDisposable | null;
  evictTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

/** One terminal on a mesh peer, as this manager holds it: which workspace opened it, and the proxy that answers. */
interface PeerTerminalRecord {
  id: string;
  workspaceId: string;
  createdAt: number;
  handle: PeerTerminalHandle;
}

// Required to terminate Windows ConPTY/Unix setsid hierarchy safely; never
// falls back to a harness permission system or another user's session owner.
function assertDims(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols < 10 || cols > 400) throw new ChatError(400, "terminal_size", "cols must be 10-400");
  if (!Number.isInteger(rows) || rows < 4 || rows > 120) throw new ChatError(400, "terminal_size", "rows must be 4-120");
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();
  /** Terminals on mesh peers (P3): the proxies the routes reach by id, exactly like local ones. */
  private readonly peerTerminals = new Map<string, PeerTerminalRecord>();
  private readonly openings = new Map<string, number[]>();

  constructor(private readonly opts: TerminalManagerOpts = {}) {}

  /**
   * One interactive terminal in the user's validated project — or, when the
   * request names a mesh peer (P3), on that peer at `peerCwd`, through the
   * hook. Everything about the spawn stays the target's own either way: this
   * route never takes a command, a shell, or an env.
   */
  async create(ws: WorkspaceInfo, cols: number, rows: number, peer?: { peer: string; peerCwd: string }): Promise<{ id: string; createdAt: number }> {
    assertDims(cols, rows);
    if (peer !== undefined) {
      const hook = this.opts.peerTerms;
      if (hook === undefined) throw new ChatError(501, "peer_terms_off", "Remote terminals are not wired on this server");
      let opened: Awaited<ReturnType<PeerTermsHook["open"]>>;
      try {
        opened = await hook.open(peer.peer, peer.peerCwd, cols, rows);
      } catch (error) {
        // The peer's own words for why it refused (unknown peer, mesh off, a denial) are the user's to read.
        throw error instanceof ChatError ? error : new ChatError(502, "peer_terminal", error instanceof Error ? error.message : String(error));
      }
      const record: PeerTerminalRecord = { id: opened.id, workspaceId: ws.id, createdAt: opened.createdAt, handle: opened.handle };
      // When the proxy ends itself (exit, close, last subscriber gone), its id must stop resolving here.
      opened.handle.onGone(() => this.peerTerminals.delete(opened.id));
      this.peerTerminals.set(record.id, record);
      return { id: record.id, createdAt: record.createdAt };
    }
    const real = await fs.realpath(ws.path).catch(() => null);
    if (real !== ws.path) throw new ChatError(403, "workspace_path", "The workspace folder is no longer at its opened path");
    const live = [...this.terminals.values()].filter((t) => t.workspaceId === ws.id && !t.exited);
    if (live.length >= MAX_PER_WORKSPACE) throw new ChatError(409, "terminal_limit", `At most ${MAX_PER_WORKSPACE} terminals per workspace`);
    const now = Date.now();
    const window = (this.openings.get(ws.id) ?? []).filter((at) => now - at < 60_000);
    if (window.length >= MAX_CREATES_PER_MINUTE) throw new ChatError(429, "terminal_rate", "Too many terminals opened; wait a minute");
    this.openings.set(ws.id, [...window, now]);
    const shell = IS_WINDOWS ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh");
    const env = { ...process.env } as Record<string, string>;
    for (const [k, v] of Object.entries(env)) if (v === undefined || k.startsWith("GIT_") || k.startsWith("AWUI_")) delete env[k];
    let pty: ProjectPty;
    try {
      pty = (this.opts.spawn ?? spawnPty)(shell, { name: "xterm-256color", cols, rows, cwd: real, env });
    } catch {
      throw new ChatError(500, "terminal_spawn", process.platform === "win32" && process.versions.bun ? "Terminal is unsupported in this Windows build: Bun.Terminal has no ConPTY provider here" : `Could not start ${shell}`);
    }
    const record: TerminalRecord = {
      id: randomUUID(), workspaceId: ws.id, createdAt: now, cols, rows, pty, replay: "", exited: false,
      exit: null, subscribers: new Set(), dataDispose: null, exitDispose: null, evictTimer: null, killTimer: null,
    };
    this.terminals.set(record.id, record);
    record.dataDispose = pty.onData((chunk) => {
      record.replay = (record.replay + chunk).slice(-REPLAY_CAP);
      for (const subscriber of record.subscribers) {
        try { subscriber.onOutput(chunk); } catch { /* one client does not stall PTY */ }
      }
    });
    record.exitDispose = pty.onExit(({ exitCode, signal }) => this.finish(record, exitCode, signal));
    return { id: record.id, createdAt: now };
  }

  write(ws: WorkspaceInfo, id: string, data: string): void {
    const record = this.owned(ws, id);
    if ("handle" in record) {
      // The same bound a local write answers; the bytes cross the link as one term.input.
      if (typeof data !== "string" || data.length > MAX_WRITE) throw new ChatError(400, "terminal_write", `A write is at most ${MAX_WRITE} characters`);
      record.handle.write(data);
      return;
    }
    if (record.exited) return;
    if (typeof data !== "string" || data.length > MAX_WRITE) throw new ChatError(400, "terminal_write", `A write is at most ${MAX_WRITE} characters`);
    for (let at = 0; at < data.length; at += WRITE_CHUNK) record.pty.write(data.slice(at, at + WRITE_CHUNK));
  }

  resize(ws: WorkspaceInfo, id: string, cols: number, rows: number): void {
    const record = this.owned(ws, id);
    assertDims(cols, rows);
    if ("handle" in record) {
      record.handle.resize(cols, rows);
      return;
    }
    if (record.exited) return;
    try { record.pty.resize(cols, rows); } catch { return; }
    record.cols = cols;
    record.rows = rows;
  }

  close(ws: WorkspaceInfo, id: string): void {
    const record = this.owned(ws, id);
    if ("handle" in record) {
      this.peerTerminals.delete(id);
      record.handle.close();
      return;
    }
    this.kill(record);
    this.remove(record);
  }

  subscribe(ws: WorkspaceInfo, id: string, subscriber: TerminalSubscriber): () => void {
    const record = this.owned(ws, id);
    // A peer terminal replays and exits through its proxy, on the same contract a local one does.
    if ("handle" in record) return record.handle.subscribe(subscriber);
    record.subscribers.add(subscriber);
    if (record.replay) subscriber.onOutput(record.replay);
    if (record.exited && record.exit) subscriber.onExit(record.exit.code, record.exit.signal);
    return () => {
      record.subscribers.delete(subscriber);
      if (record.subscribers.size === 0 && !record.exited) this.close(ws, id);
    };
  }

  shutdown(): void {
    for (const record of [...this.terminals.values()]) { this.kill(record); this.remove(record); }
    for (const record of [...this.peerTerminals.values()]) { this.peerTerminals.delete(record.id); record.handle.close(); }
    this.openings.clear();
  }

  /** One terminal by id, whichever side of a link it runs on; a workspace's terminals stay its own. */
  private owned(ws: WorkspaceInfo, id: string): TerminalRecord | PeerTerminalRecord {
    const peer = this.peerTerminals.get(id);
    if (peer !== undefined) {
      if (peer.workspaceId !== ws.id) throw new ChatError(404, "no_terminal", "No such terminal");
      return peer;
    }
    const record = this.terminals.get(id);
    if (!record || record.workspaceId !== ws.id) throw new ChatError(404, "no_terminal", "No such terminal");
    return record;
  }

  private finish(record: TerminalRecord, code: number, signal?: number): void {
    if (record.exited) return;
    record.exited = true;
    record.exit = { code, ...(signal !== undefined ? { signal } : {}) };
    record.dataDispose?.dispose();
    record.dataDispose = null;
    record.exitDispose?.dispose();
    record.exitDispose = null;
    for (const subscriber of record.subscribers) {
      try { subscriber.onExit(code, record.exit.signal); } catch { /* no noisy clients */ }
    }
    record.subscribers.clear();
    record.evictTimer = setTimeout(() => { record.evictTimer = null; this.terminals.delete(record.id); }, REPLAY_KEEP_MS);
    record.evictTimer.unref?.();
  }

  private kill(record: TerminalRecord): void {
    if (record.killTimer) { clearTimeout(record.killTimer); record.killTimer = null; }
    const pid = record.pty.pid;
    if (IS_WINDOWS) {
      try { spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* closed */ }
      return;
    }
    try { process.kill(-pid, "SIGTERM"); } catch { try { record.pty.kill(); } catch { /* closed */ } }
    record.killTimer = setTimeout(() => {
      record.killTimer = null;
      try { process.kill(-pid, "SIGKILL"); } catch { try { record.pty.kill(); } catch { /* closed */ } }
    }, KILL_ESCALATE_MS);
    record.killTimer.unref?.();
  }

  private remove(record: TerminalRecord): void {
    if (record.evictTimer) { clearTimeout(record.evictTimer); record.evictTimer = null; }
    record.dataDispose?.dispose();
    record.dataDispose = null;
    record.exitDispose?.dispose();
    record.exitDispose = null;
    record.subscribers.clear();
    this.terminals.delete(record.id);
  }
}
