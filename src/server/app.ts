import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError, type ZodType } from "zod";
import { buildIdOf } from "./build-id.js";
import { embeddedWeb } from "./embedded.js";
import {
  answerSchema,
  botCreateSchema,
  botPatchSchema,
  memberAddSchema,
  memberPatchSchema,
  roomAnswerSchema,
  roomCreateSchema,
  roomHistoryQuery,
  roomMessageSchema,
  roomPatchSchema,
  type Bootstrap,
  chainSchema,
  type ChatEvent,
  chatSearchSchema,
  checkpointCompareSchema,
  type CheckpointComparison,
  continueAtSchema,
  compactSchema,
  createChatSchema,
  fileViewSchema,
  fileUploadSchema,
  forkChatSchema,
  handoffSchema,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_MESSAGE_CHARS,
  openWorkspaceSchema,
  patchConfigSchema,
  renameSchema,
  settingsPatchSchema,
  resumeChatSchema,
  herdrFocusSchema,
  rewindSchema,
  runCommandSchema,
  gitPathsSchema,
  gitCommitSchema,
  savedPromptSchema,
  sessionMarkSchema,
  routineSchema,
  sessionBulkMarkSchema,
  sessionOrderSchema,
  pushSubscriptionSchema,
  pushTestSchema,
  putBackSchema,
  restoreSchema,
  type CheckpointPreview,
  type CheckpointRestored,
  type Checkout,
  type ProjectSession,
  sendMessageSchema,
  fileSearchSchema,
  projectSearchSchema,
  queueSchema,
  sessionPreviewSchema,
  type SessionPreview,
  resumeCommandSchema,
  type ResumeCommand,
  type GitStatus,
  uploadPasteSchema,
  usageReportSchema,
  type SessionsOverview,
  type SessionSummary,
  type WorkspaceInfo,
} from "../shared/protocol.js";
import { approvalAnswers } from "../shared/approval.js";
import { ChatError, errorMessage, type Chat } from "./chats/chat.js";
import type { BoardManager } from "./boards/types.js";
import { storedImage } from "./image-store.js";
import { isHtmlRenderId, readHtmlRender, saveHtmlRender } from "./html-render.js";
import type { ChatManager } from "./chats/manager.js";
import type { HarnessRegistry } from "./harness/registry.js";
import type { HarnessAdapter, NativeSessionSummary } from "./harness/types.js";
import { briefPrompt, isEmptySeed, toSeed } from "./harness/handoff.js";
import { sniffImage } from "./images.js";
import { resolvePaste, storePaste } from "./paste-store.js";
import { projectFiles, searchFiles } from "./project-files.js";
import { searchProject } from "./project-search.js";
import type { Security } from "./security.js";
import type { ThemeStore } from "./theme.js";
import { readSettings, writeSettings, type Requester, type SettingsContext } from "./settings.js";
import { readAwuiConfig, writeAwuiConfig } from "./awui-settings.js";
import { readUserConfig, uiSettings } from "./user-config.js";
import { HerdrError, type Herdr } from "./herdr.js";
import { SessionMarks } from "./session-marks.js";
import { SessionOrder } from "./session-order.js";
import { checkoutOf } from "./checkouts.js";
import { SavedPrompts } from "./saved-prompts.js";
import { Routines } from "./routines.js";
import { Limits } from "./limits.js";
import { Notifier, pushEndpointProblem } from "./notify.js";
import { ChatSearcher, type SearchTarget } from "./chat-search.js";
import { readMedia, viewFile } from "./file-view.js";
import { writeProjectFile } from "./project-upload.js";
import { UsageReader, type UsageTarget } from "./usage-report.js";
import { Checkpoints } from "./checkpoints.js";
import { gitFileDiff, gitStatus } from "./git-status.js";
import { commitStaged, GitActionError, stageFiles, unstageFiles } from "./git-actions.js";
import { runCommand } from "./run-command.js";
import { shellLine } from "./shell-line.js";
import type { Workspaces } from "./workspaces.js";
import { allowEnvrc, direnvState, prepareSpawnEnv } from "./direnv.js";
import { ModelCatalog } from "./model-catalog.js";

/** How many of each harness's newest sessions the sidebar sees across projects. */
export const RECENT_SESSIONS_PER_HARNESS = 200;

export interface AppDeps {
  version: string;
  home: string;
  registry: HarnessRegistry;
  manager: ChatManager;
  workspaces: Workspaces;
  security: Security;
  theme: ThemeStore;
  pairingUrls: string[];
  webDir: string | null;
  /** Where config.yml lives; its browser settings are re-read on every page load. */
  configDir?: string | null;
  /** The Settings dialog's view of config.yml; without it the settings routes answer 404. */
  settings?: SettingsContext;
  heartbeatMs?: number;
  /** Pinned and archived sessions; in memory when absent. */
  marks?: SessionMarks;
  /** Hand-made session orders; in memory when absent. */
  order?: SessionOrder;
  /** Saved prompts, for every device; in memory when absent (tests). */
  prompts?: SavedPrompts;
  /** Scheduled runs; in memory when absent. */
  routines?: Routines;
  /** Subscription limits; in memory when absent. */
  limits?: Limits;
  /** Notes and Web Push for devices that turned notifications on; in memory when absent. */
  notifier?: Notifier;
  /** Where file checkpoints live (shadow repositories, and each session's list of them); none when absent. */
  checkpointsDir?: string | null;
  /** The server state folder, where agent-rendered HTML pages are stored. */
  stateDir?: string | null;
  /** The start screen's model answers per harness and project; saved in the state folder when absent and one is set. */
  modelCatalog?: ModelCatalog;
  /** Herdr's panes, to mark the sessions they run; none when absent (tests that do not ask for it). */
  herdr?: Herdr;
  /** Board rooms; without one the board routes answer 404 and ownership filtering is a no-op. */
  boards?: BoardManager;
  log?: (message: string) => void;
}

/** What a render frame shows when its page is gone: a line in the frame, in system colours (no theme reaches it). */
const RENDER_GONE_PAGE =
  '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">' +
  '<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:14px system-ui,sans-serif;color:GrayText;background:transparent">' +
  "<p>This page is no longer stored on the server.</p>";

function body<T>(schema: ZodType<T>, req: Request): T {
  return schema.parse(req.body ?? {});
}

function parseLastEventId(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * One native session as a sidebar row: ids, ISO timestamps, and the live chat
 * when one is open. Pass `ws` to attach the owning project — the all-projects
 * list carries `workspaceId`; the per-harness list intentionally does not.
 */
function toSession(adapter: HarnessAdapter, s: NativeSessionSummary, ws: WorkspaceInfo, live?: Chat | null): ProjectSession;
function toSession(adapter: HarnessAdapter, s: NativeSessionSummary, ws: null, live?: Chat | null): SessionSummary;
function toSession(
  adapter: HarnessAdapter,
  s: NativeSessionSummary,
  ws: WorkspaceInfo | null,
  live?: Chat | null,
): SessionSummary | ProjectSession {
  const summary: SessionSummary = {
    id: `${adapter.id}:${s.nativeId}`,
    harnessId: adapter.id,
    title: s.title,
    updatedAt: latest(s.updatedAt, live?.talkedAt ?? null),
    ...(s.messageCount !== undefined ? { messageCount: s.messageCount } : {}),
    ...(live ? { liveChatId: live.chatId, status: live.status, ...(live.pendingCount > 0 ? { asking: true as const } : {}) } : {}),
  };
  return ws ? { ...summary, workspaceId: ws.id } : summary;
}

/** A session's last activity: its file's, or a live chat's newer conversation here. */
function latest(saved: Date | null, talkedAt: number | null): string | null {
  const at = Math.max(saved?.getTime() ?? 0, talkedAt ?? 0);
  return at > 0 ? new Date(at).toISOString() : null;
}

export function createApp(deps: AppDeps) {
  const { registry, manager, workspaces, security, theme } = deps;
  const marks = deps.marks ?? SessionMarks.inMemory();
  const order = deps.order ?? SessionOrder.inMemory();
  const prompts = deps.prompts ?? SavedPrompts.inMemory();
  const routines = deps.routines ?? Routines.inMemory();
  const limits = deps.limits ?? Limits.inMemory(registry);
  manager.onLimits = (account) => limits.report(account);
  const notifier = deps.notifier ?? Notifier.inMemory();
  const modelCatalog = deps.modelCatalog ?? new ModelCatalog(deps.stateDir ? path.join(deps.stateDir, "model-catalog.json") : null);
  const chatSearcher = new ChatSearcher();
  const usageReader = new UsageReader();
  if (deps.checkpointsDir) manager.checkpoints = { service: new Checkpoints(deps.checkpointsDir), sessionsDir: path.join(deps.checkpointsDir, "sessions") };
  manager.onNews = (chat, kind, text, request) => {
    // A board-owned chat's runs are the room's business: the room sends its own notes.
    if (chat.owner) return;
    // An approval's note carries its two answers, so the notification's own buttons can send one.
    const answers = request ? approvalAnswers(request) : null;
    notifier.notify({
      kind,
      chatId: chat.chatId,
      sessionId: chat.sessionId,
      title: chat.title || "New chat",
      body: text,
      ...(request && answers ? { approval: { requestId: request.id, ...answers } } : {}),
    });
    if ((kind === "ask" || kind === "error") && chat.sessionId) marks.wake(chat.sessionId);
  };
  manager.onRunStart = (chat) => {
    if (chat.owner) return;
    if (chat.sessionId) marks.wake(chat.sessionId);
  };
  const log = deps.log ?? ((m: string) => console.error(m));
  // What this process serves as the web bundle: a page compares it with the build
  // it loaded to notice a deploy (the binary embeds the bundle; a source run has
  // dist/web). "dev" when neither exists, which the client then ignores.
  const build = buildIdOf(embeddedWeb()?.get("/index.html")?.text ?? (deps.webDir ? readIndexHtml(deps.webDir) : null));
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // The render-doc page serves its own CSP header (see the route below); the global
  // helmet CSP would add a *second* one and the browser enforces the stricter, which
  // would forbid that page's own framing from the same origin. So helmet skips it.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/render/") && req.path.endsWith("/doc")) return next();
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "font-src": ["'self'"],
          "connect-src": ["'self'"],
          "object-src": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
        },
      },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: false,
    })(req, res, next);
  });
  app.use(security.trust);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, build });
  });

  // Sign-in for other devices; reachable without a session.
  app.post("/api/login", express.json({ limit: "8kb" }), security.login);
  app.post("/api/logout", security.logout);

  // The render tool in a chat's harness child posts its page here. It is not a
  // browser session, so it authenticates with the random token the child was
  // spawned with (`AWUI_RENDER_TOKEN`) instead of a cookie; the token names the
  // one live chat the page belongs to. Mounted before requireAuth, and only
  // ever from loopback (the bind is authenticated by the token, not the host).
  app.post("/api/render", express.json({ limit: "600kb" }), async (req, res) => {
    const stateDir = deps.stateDir;
    if (!stateDir) throw new ChatError(404, "render_off", "HTML render is not wired on this server");
    const token = req.get("x-awui-render-token") ?? "";
    const chat = token !== "" ? manager.chatForRenderToken(token) : undefined;
    if (!chat) throw new ChatError(403, "bad_render_token", "Not a live chat's render token");
    // Board-owned chats are never given a render token, and must not get one through this route either.
    if (chat.owner) throw new ChatError(403, "bad_render_token", "Not a live chat's render token");
    const html = typeof req.body?.html === "string" ? req.body.html : "";
    const saved = await saveHtmlRender(stateDir, { html, title: req.body?.title, height: req.body?.height });
    if (!saved) throw new ChatError(400, "bad_render", "Empty or oversized HTML document");
    res.json({ id: saved.id, url: `/api/chats/${chat.chatId}/html-render/${saved.id}` });
  });

  app.use("/api", security.requireAuth, (_req, res, next) => {
    // Session-bearing JSON must never be cached by a browser or proxy.
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  // Only sending a message may carry images; every other body stays small.
  const textJson = express.json({ limit: `${Math.ceil((MAX_MESSAGE_CHARS * 4) / 1024) + 64}kb` });
  const messageJson = express.json({
    limit: `${Math.ceil((MAX_MESSAGE_CHARS * 4 + MAX_IMAGES * Math.ceil(MAX_IMAGE_BYTES / 3) * 4) / 1024) + 64}kb`,
  });
  app.use("/api", (req, res, next) => {
    // An upload's body is the file itself, whatever type the browser names; its route reads it raw.
    if (req.method === "POST" && /^\/workspaces\/[^/]+\/upload$/.test(req.path)) return next();
    return (req.method === "POST" && /^\/(?:chats|rooms)\/[^/]+\/messages$/.test(req.path) ? messageJson : textJson)(req, res, next);
  });

  // A broken config.yml keeps the defaults here; the server logged why at startup.
  const browserSettings = () => {
    try {
      return uiSettings(readUserConfig(deps.configDir ?? null)?.config);
    } catch {
      return uiSettings(undefined);
    }
  };

  let statusAt = 0;
  app.get("/api/bootstrap", async (req, res) => {
    if (Date.now() - statusAt > 60_000 || req.query.refresh === "1") {
      await registry.refreshStatus();
      statusAt = Date.now();
    }
    const t = await theme.get();
    const payload: Bootstrap = {
      version: deps.version,
      build,
      auth: {
        mode: res.locals.local === true ? "local" : "password",
        username: security.username,
        remoteEnabled: security.username !== null,
      },
      harnesses: registry.status(),
      roots: workspaces.rootList,
      home: deps.home,
      theme: { active: t.name ?? "built-in", ...(t.problem ? { problem: t.problem } : {}) },
      ui: browserSettings(),
      pairing: { urls: deps.pairingUrls },
      limits: { maxMessageChars: MAX_MESSAGE_CHARS },
    };
    res.json(payload);
  });

  // Settings: any signed-in device may read and change them (a save that would lock that device out is refused) and restart.
  const settingsCtx = (): SettingsContext => {
    if (!deps.settings) throw new ChatError(404, "no_settings", "Settings are not available on this server");
    return deps.settings;
  };
  const requester = (req: Request, res: Response): Requester => ({
    local: res.locals.local === true,
    kind: res.locals.hostKind as Requester["kind"],
    authority: String(res.locals.authority ?? ""),
    tailscaleUser: res.locals.hostKind === "remote" ? String(req.headers["tailscale-user-login"] ?? "").toLowerCase() || null : null,
  });
  app.get("/api/settings", (_req, res) => {
    res.json(readSettings(settingsCtx(), true));
  });
  app.put("/api/settings", (req, res) => {
    const ctx = settingsCtx();
    res.json(writeSettings(ctx, body(settingsPatchSchema, req), requester(req, res)));
  });

  // The awui harness's own providers (its isolated agent dir's models.json).
  // Server-side only edits; an apiKey is never returned (redacted to a flag).
  app.get("/api/awui/settings", async (_req, res) => {
    res.json(await readAwuiConfig(registry));
  });
  app.put("/api/awui/settings", async (req, res) => {
    res.json(await writeAwuiConfig(registry, req.body));
  });
  app.post("/api/settings/restart", (_req, res) => {
    const ctx = settingsCtx();
    if (!ctx.canRestart) throw new ChatError(409, "no_supervisor", "Nothing would start the server again: restart it yourself");
    res.status(202).json({ restarting: true });
    // The same graceful stop as a SIGTERM from systemd, which then starts it again (Restart=always).
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);
  });

  app.get("/api/theme", async (_req, res) => {
    res.json(await theme.get());
  });

  app.get("/api/workspaces/browse", async (req, res) => {
    const p = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json(await workspaces.browse(p));
  });

  app.post("/api/workspaces/open", async (req, res) => {
    const { path: p } = body(openWorkspaceSchema, req);
    res.json(await workspaces.open(p));
  });

  // Approve a project's .envrc (direnv allow): the composer/start screen offer this when the
  // workspace's tree has a blocked one. Goes to someone signed in from anywhere — it writes to
  // the user's direnv state (~/.local/share/direnv/allow), the same consent `direnv allow` asks
  // for in a terminal, and the user just read what they are allowing in the prompt's file link.
  app.post("/api/workspaces/:id/direnv-allow", async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    if (!direnvState(ws.path).blocked) throw new ChatError(409, "not_blocked", "No blocked .envrc here");
    if (!allowEnvrc(ws.path)) throw new ChatError(500, "direnv_failed", "direnv allow did not run");
    res.json(await workspaces.get(ws.id));
  });

  // A project's files for a client's @mention picker, relative to the project.
  // Read-only and confined to an opened workspace (by id, never a path).
  app.get("/api/workspaces/:id/files", async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { q } = fileSearchSchema.parse(req.query);
    res.json({ files: searchFiles(await projectFiles(ws.path), q) });
  });

  // A file dropped into the project: new files only, one name, bounded by the body.
  app.post("/api/workspaces/:id/upload", express.raw({ type: () => true, limit: "8mb" }), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { name } = fileUploadSchema.parse(req.query);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (bytes.length === 0) throw new ChatError(400, "empty_file", "That file is empty");
    res.status(201).json(await writeProjectFile(ws.path, name, bytes));
  });

  // Usage across sessions (usage-report.ts): the sidebar's sessions' calls, read from the harnesses' files.
  app.get("/api/usage", async (req, res) => {
    const { days, tz } = usageReportSchema.parse(req.query);
    const overview = await listSessions(null);
    const byId = new Map(overview.workspaces.map((w) => [w.id, w]));
    const unreadable = new Set<string>();
    const targets: UsageTarget[] = overview.sessions.map((session) => {
      const adapter = registry.get(session.harnessId);
      const ws = byId.get(session.workspaceId);
      const prefix = `${session.harnessId}:`;
      if (!adapter?.readUsage || !ws || !session.id.startsWith(prefix)) {
        if (adapter && !adapter.readUsage) unreadable.add(adapter.displayName);
        return { session, read: null };
      }
      return { session, read: () => adapter.readUsage?.({ cwd: ws.path, nativeId: session.id.slice(prefix.length) }) ?? Promise.resolve(null) };
    });
    res.json(await usageReader.report(targets, { days, tz, workspaces: overview.workspaces, unreadable: [...unreadable] }));
  });

  // Saved prompts (saved-prompts.ts): every device and atui share them.
  app.get("/api/prompts", (_req, res) => {
    res.json({ prompts: prompts.list() });
  });
  app.post("/api/prompts", async (req, res) => {
    res.json(await prompts.save(body(savedPromptSchema, req)));
  });
  app.delete("/api/prompts/:id", async (req, res) => {
    await prompts.remove(req.params.id);
    res.json({ ok: true });
  });

  // The file viewer: one of the project's own files, read-only and bounded (file-view.ts).
  // An image's bytes for the viewer's preview: same confinement as the text view,
  // typed by magic bytes, with nosniff so the browser takes the type we send.
  app.get("/api/workspaces/:id/media", async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { path: wanted } = fileViewSchema.parse(req.query);
    const { bytes, mimeType } = await readMedia(ws.path, wanted);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(bytes);
  });
  app.get("/api/workspaces/:id/file", async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { path: wanted } = fileViewSchema.parse(req.query);
    res.json(await viewFile(ws.path, wanted));
  });

  // Search in project: lines holding a fixed string (never a pattern), bounded
  // (project-search.ts). Only inside an opened workspace, as the file list is.
  app.get("/api/workspaces/:id/search", async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { q, case: matchCase } = projectSearchSchema.parse(req.query);
    try {
      res.json(await searchProject(ws.path, q, matchCase === "1"));
    } catch (error) {
      throw new ChatError(500, "search_failed", `Search failed: ${errorMessage(error)}`);
    }
  });

  const adapterOr404 = (id: string) => {
    const adapter = registry.get(id);
    if (!adapter) throw new ChatError(404, "unknown_harness", "Unknown harness");
    return adapter;
  };
  // A harness can be installed and still unavailable (a Hermes gateway owning its home,
  // say), and it can also come back after this server booted. So a cached "unavailable"
  // is asked again before it refuses — the registry throttles that (registry.ts).
  const availableAdapter = async (id: string) => {
    const adapter = adapterOr404(id);
    if (await registry.available(adapter.id)) return adapter;
    const status = registry.status().find((s) => s.id === adapter.id);
    throw new ChatError(422, "harness_unavailable", `${adapter.displayName} is unavailable${status?.reason ? `: ${status.reason}` : ""}`);
  };

  // One harness's status, asked again. The harness menu asks about the rows it shows as
  // blocked, so a gateway that finished starting (or a CLI just installed) stops being
  // greyed out without a page reload. The registry throttles that ask (registry.ts): a
  // signed-in device cannot force a discovery, including a Hermes CLI spawn, per request.
  app.get("/api/harnesses/:id/status", async (req, res) => {
    const adapter = adapterOr404(req.params.id);
    const status = await registry.recheck(adapter.id);
    if (!status) throw new ChatError(404, "unknown_harness", "Unknown harness");
    res.json(status);
  });

  app.get("/api/harnesses/:id/sessions", async (req, res) => {
    const adapter = await availableAdapter(req.params.id);
    const ws = await workspaces.get(String(req.query.workspaceId ?? ""));
    const problem = adapter.workspaceProblem(ws.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    const native = (await adapter.listSessions(ws.path)).filter((s) => !deps.boards?.ownsNativeSession(adapter.id, s.nativeId));
    const seen = new Set<string>();
    const sessions: SessionSummary[] = native.map((s) => {
      seen.add(s.nativeId);
      // No workspaceId: this route is already project-scoped.
      return toSession(adapter, s, null, manager.liveChatFor(adapter.id, s.nativeId));
    });
    // Live chats whose session the harness has not persisted yet.
    for (const chat of manager.list()) {
      if (chat.owner || chat.harnessId !== adapter.id || chat.workspace.id !== ws.id || chat.status === "disposed") continue;
      if (chat.nativeId && seen.has(chat.nativeId)) continue;
      sessions.unshift({
        id: chat.sessionId ?? `${adapter.id}:live-${chat.chatId}`,
        harnessId: adapter.id,
        title: chat.title || "New chat",
        updatedAt: new Date(chat.lastActivity).toISOString(),
        liveChatId: chat.chatId,
        status: chat.status,
      });
    }
    res.json({ sessions });
  });

  // The models a chat in this workspace could start on, so the start screen can
  // offer one before any session exists. The same call a chat's own config makes.
  app.get("/api/harnesses/:id/models", async (req, res) => {
    const adapter = await availableAdapter(req.params.id);
    const ws = await workspaces.get(String(req.query.workspaceId ?? ""));
    const problem = adapter.workspaceProblem(ws.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    // The answer is served from the catalog at any age, saved across restarts and refreshed behind
    // the request once stale (model-catalog.ts: a cold probe costs seconds); Refresh asks the harness now.
    // A cold probe spawns the harness in the project: evaluate its .envrc off the event loop first.
    await prepareSpawnEnv(ws.path);
    try {
      res.json(await modelCatalog.get(adapter, ws.path, req.query.refresh === "1"));
    } catch (error) {
      throw new ChatError(502, "models_unavailable", `${adapter.displayName} could not list its models: ${errorMessage(error)}`);
    }
    // The other harnesses' answers for this project, filled in behind it, so switching harness here is instant.
    const others = registry.list().filter((other) => other.id !== adapter.id && registry.isAvailable(other.id) && !other.workspaceProblem(ws.path));
    void modelCatalog.warm(others, ws.path);
  });

  // A session's last prompt and answer, for a history picker's preview: from
  // the live chat when one is open, else the harness's own file (read only,
  // the harness is not started). Cut short: a preview, not a transcript.
  app.get("/api/sessions/preview", async (req, res) => {
    const input = sessionPreviewSchema.parse(req.query);
    const adapter = adapterOr404(input.harnessId);
    const prefix = `${adapter.id}:`;
    if (!input.sessionId.startsWith(prefix)) throw new ChatError(400, "wrong_harness", "Session belongs to another harness");
    const nativeId = input.sessionId.slice(prefix.length);
    // A room membership's native session is never an ordinary preview target.
    if (deps.boards?.ownsNativeSession(adapter.id, nativeId)) throw new ChatError(404, "no_preview", "That session belongs to a Board room");
    const ws = await workspaces.get(input.workspaceId);
    const live = manager.liveChatFor(adapter.id, nativeId);
    const items = live ? live.snapshot().items : ((await adapter.readTranscript?.({ cwd: ws.path, nativeId }).catch(() => null))?.items ?? null);
    if (!items) throw new ChatError(404, "no_preview", "That session cannot be read without opening it");
    const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
    const prompts = items.filter((i) => i.kind === "user" && !i.command);
    const lastPrompt = prompts[prompts.length - 1];
    const after = lastPrompt ? items.slice(items.indexOf(lastPrompt) + 1) : items;
    const answer = [...after].reverse().find((i) => i.kind === "assistant" && i.text.trim());
    const modelled = [...items].reverse().find((i) => i.kind === "assistant" && i.model);
    const files: string[] = [];
    for (const item of items) {
      if (item.kind !== "tool" || item.status === "error" || (item.category !== "edit" && item.category !== "write")) continue;
      for (const p of item.paths) {
        const rel = path.isAbsolute(p) ? path.relative(ws.path, p) : p;
        if (rel.startsWith("..") || !rel) continue;
        const at = files.indexOf(rel);
        if (at >= 0) files.splice(at, 1);
        files.push(rel);
      }
    }
    const preview: SessionPreview = {
      prompt: lastPrompt && lastPrompt.kind === "user" ? cut(lastPrompt.text.trim(), 400) : null,
      answer: answer && answer.kind === "assistant" ? cut(answer.text.trim(), 1500) : null,
      turns: prompts.length,
      model: modelled && modelled.kind === "assistant" ? (modelled.model ?? null) : null,
      files: files.slice(-8),
    };
    res.json(preview);
  });

  // "Copy resume command": the line that resumes a session in its harness's own
  // CLI, from a terminal outside awui. Only the adapter knows its CLI, and session
  // ids are opaque to clients, so the line is made here. `live` lets the client
  // say to close the chat here first: awui keeps one writer per session, and a
  // terminal running the same session would be a second.
  app.get("/api/sessions/resume-command", async (req, res) => {
    const input = resumeCommandSchema.parse(req.query);
    const adapter = adapterOr404(input.harnessId);
    if (!adapter.capabilities.supportsResumeCommand || !adapter.resumeCommand) throw new ChatError(400, "unsupported", "This harness has no resume command");
    const prefix = `${adapter.id}:`;
    if (!input.sessionId.startsWith(prefix)) throw new ChatError(400, "wrong_harness", "Session belongs to another harness");
    const nativeId = input.sessionId.slice(prefix.length);
    // A room membership's session resumes only through its room, never in a terminal as an ordinary chat.
    if (deps.boards?.ownsNativeSession(adapter.id, nativeId)) throw new ChatError(404, "not_saved", "That session belongs to a Board room");
    const ws = await workspaces.get(input.workspaceId);
    const argv = await adapter.resumeCommand({ cwd: ws.path, nativeId });
    if (!argv) throw new ChatError(404, "not_saved", "That session has nothing saved to resume yet");
    const body: ResumeCommand = { command: shellLine(ws.path, argv), live: manager.liveChatFor(adapter.id, nativeId) !== undefined };
    res.json(body);
  });

  // The sidebar's list: each harness's newest sessions across projects, every
  // session of the current project (`?path=`), and live chats not saved yet.
  // Projects outside WORKSPACE_ROOTS, or that a harness cannot open, are left out.
  const listSessions = async (path: string | null): Promise<SessionsOverview> => {
    const resolved = new Map<string, Promise<WorkspaceInfo | null>>();
    const workspaceFor = (cwd: string) => {
      let ws = resolved.get(cwd);
      if (!ws) {
        ws = workspaces.open(cwd).catch(() => null);
        resolved.set(cwd, ws);
      }
      return ws;
    };
    const current = path ? await workspaceFor(path) : null;
    const projects = new Map<string, WorkspaceInfo>(current ? [[current.id, current]] : []);
    const sessions = new Map<string, ProjectSession>();
    const add = (adapter: HarnessAdapter, s: NativeSessionSummary, ws: WorkspaceInfo) => {
      const id = `${adapter.id}:${s.nativeId}`;
      if (sessions.has(id)) return;
      projects.set(ws.id, ws);
      sessions.set(id, toSession(adapter, s, ws, manager.liveChatFor(adapter.id, s.nativeId)));
    };
    const errors: string[] = [];
    const adapters = registry.list().filter((a) => registry.isAvailable(a.id));
    await Promise.all(
      adapters.map(async (adapter) => {
        try {
          const here = current && !adapter.workspaceProblem(current.path) ? await adapter.listSessions(current.path) : [];
          if (current) for (const s of here) if (!deps.boards?.ownsNativeSession(adapter.id, s.nativeId)) add(adapter, s, current);
          for (const s of await adapter.listRecentSessions(RECENT_SESSIONS_PER_HARNESS)) {
            if (deps.boards?.ownsNativeSession(adapter.id, s.nativeId)) continue;
            const ws = await workspaceFor(s.cwd);
            if (ws && !adapter.workspaceProblem(ws.path)) add(adapter, s, ws);
          }
        } catch (error) {
          errors.push(`${adapter.displayName}: ${errorMessage(error)}`);
        }
      }),
    );
    for (const chat of manager.list()) {
      if (chat.owner || chat.status === "disposed") continue;
      const id = chat.sessionId ?? `${chat.harnessId}:live-${chat.chatId}`;
      if (sessions.has(id)) continue;
      projects.set(chat.workspace.id, chat.workspace);
      sessions.set(id, {
        id,
        harnessId: chat.harnessId,
        title: chat.title || "New chat",
        updatedAt: new Date(chat.lastActivity).toISOString(),
        liveChatId: chat.chatId,
        status: chat.status,
        workspaceId: chat.workspace.id,
        ...(chat.pendingCount > 0 ? { asking: true as const } : {}),
      });
    }
    const inHerdr = deps.herdr ? await deps.herdr.bySession() : null;
    for (const [id, s] of sessions) {
      const mark = marks.get(id);
      const pane = inHerdr?.get(id);
      if (mark || pane) sessions.set(id, { ...s, ...mark, ...(pane ? { herdr: { paneId: pane.paneId, status: pane.status } } : {}) });
    }
    const checkouts: Record<string, Checkout> = {};
    await Promise.all(
      [...projects.values()].map(async (ws) => {
        const checkout = await checkoutOf(ws.path);
        if (checkout) checkouts[ws.id] = checkout;
      }),
    );
    return {
      workspaces: [...projects.values()],
      sessions: [...sessions.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
      errors,
      checkouts,
      orders: order.all(),
    };
  };
  app.get("/api/sessions", async (req, res) => {
    res.json(await listSessions(typeof req.query.path === "string" && req.query.path ? req.query.path : null));
  });

  // Search every chat (chat-search.ts): the sidebar's sessions, newest first,
  // read from the live chat or the harness's own file; never starts a harness.
  app.get("/api/sessions/search", async (req, res) => {
    const input = chatSearchSchema.parse(req.query);
    const overview = await listSessions(null);
    const byId = new Map(overview.workspaces.map((w) => [w.id, w]));
    const targets: SearchTarget[] = overview.sessions
      .filter((s) => !input.harnessId || s.harnessId === input.harnessId)
      .map((session) => ({
        session,
        read: async () => {
          const live = session.liveChatId ? manager.list().find((c) => c.chatId === session.liveChatId) : undefined;
          if (live) return live.snapshot().items;
          const adapter = registry.get(session.harnessId);
          const ws = byId.get(session.workspaceId);
          const prefix = `${session.harnessId}:`;
          if (!adapter?.readTranscript || !ws || !session.id.startsWith(prefix)) return null;
          return (await adapter.readTranscript({ cwd: ws.path, nativeId: session.id.slice(prefix.length) }))?.items ?? null;
        },
      }));
    res.json(await chatSearcher.search(input.q, targets, overview.workspaces));
  });

  // Notifications. A push only wakes the device's service worker, which then reads the notes here.
  app.get("/api/push/key", (_req, res) => {
    res.json({ key: notifier.applicationServerKey });
  });
  app.post("/api/push/subscribe", async (req, res) => {
    const { endpoint } = body(pushSubscriptionSchema, req);
    const problem = pushEndpointProblem(endpoint);
    if (problem) throw new ChatError(422, "bad_push_endpoint", problem);
    await notifier.subscribe(endpoint);
    res.json({ ok: true });
  });
  app.post("/api/push/unsubscribe", async (req, res) => {
    await notifier.unsubscribe(body(pushSubscriptionSchema, req).endpoint);
    res.json({ ok: true });
  });
  app.post("/api/push/test", (req, res) => {
    const { endpoint } = body(pushTestSchema, req);
    res.json(notifier.notify({ kind: "done", chatId: "", sessionId: null, title: "awui", body: "Notifications work on this device" }, endpoint));
  });
  /** Notes after `since` (epoch ms, as `now` last said); without it, the last two minutes. */
  app.get("/api/notifications", (req, res) => {
    const raw = typeof req.query.since === "string" && /^\d{1,15}$/.test(req.query.since) ? Number(req.query.since) : null;
    const now = Date.now();
    res.json({ notes: notifier.since(raw ?? now - 120_000), now });
  });

  app.get("/api/limits", async (_req, res) => {
    res.json(await limits.get());
  });

  app.post("/api/sessions/marks", async (req, res) => {
    const { sessionId, ...change } = body(sessionMarkSchema, req);
    if (change.snoozedUntil !== undefined && change.snoozedUntil !== null && change.snoozedUntil <= Date.now()) throw new ChatError(400, "bad_snooze", "Snooze until a time to come");
    res.json(await marks.set(sessionId, change));
  });
  /** The same change for several sessions at once: one write, and one undo for the selection. */
  app.post("/api/sessions/marks/bulk", async (req, res) => {
    const { ids, ...change } = body(sessionBulkMarkSchema, req);
    if (change.snoozedUntil !== undefined && change.snoozedUntil !== null && change.snoozedUntil <= Date.now()) throw new ChatError(400, "bad_snooze", "Snooze until a time to come");
    res.json({ marks: await marks.setMany(ids, change) });
  });

  // Routines: a prompt on a cadence, in a project, on a harness. The timer that
  // starts them is index.ts's; these are the dialog's reads and writes.
  app.get("/api/routines", (_req, res) => {
    res.json({ routines: routines.all() });
  });
  app.put("/api/routines", async (req, res) => {
    const input = body(routineSchema, req);
    await workspaces.get(input.workspaceId);
    await availableAdapter(input.harnessId);
    try {
      res.json(await routines.save(input));
    } catch (error) {
      throw new ChatError(409, "too_many_routines", errorMessage(error));
    }
  });
  app.delete("/api/routines/:id", async (req, res) => {
    if (!(await routines.remove(req.params.id))) throw new ChatError(404, "no_routine", "No such routine");
    res.json({ ok: true });
  });

  app.post("/api/sessions/order", async (req, res) => {
    const { harnessId, workspaceId, ids } = body(sessionOrderSchema, req);
    res.json({ ids: await order.set(harnessId, workspaceId, ids) });
  });

  // ---- Board: reusable bot profiles, rooms, and their streams -----------------
  // All of it sits behind the same requireAuth as every other /api route. A
  // server without board wiring answers 404 rather than pretending.
  const board = (): BoardManager => {
    if (!deps.boards) throw new ChatError(404, "board_off", "Board rooms are not wired on this server");
    return deps.boards;
  };

  app.get("/api/bots", async (_req, res) => {
    res.json(await board().listBots());
  });
  app.post("/api/bots", async (req, res) => {
    res.status(201).json(await board().createBot(body(botCreateSchema, req)));
  });
  app.patch("/api/bots/:id", async (req, res) => {
    res.json(await board().patchBot(req.params.id, body(botPatchSchema, req)));
  });
  app.delete("/api/bots/:id", async (req, res) => {
    await board().deleteBot(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/rooms", async (_req, res) => {
    res.json(await board().listRooms());
  });
  app.post("/api/rooms", async (req, res) => {
    const info = await board().createRoom(body(roomCreateSchema, req));
    // The snapshot opens the room immediately, instead of a refetch from the client.
    res.status(201).json(await board().roomSnapshot(info.id));
  });
  app.get("/api/rooms/:id", async (req, res) => {
    res.json(await board().roomSnapshot(req.params.id));
  });
  app.patch("/api/rooms/:id", async (req, res) => {
    res.json(await board().patchRoom(req.params.id, body(roomPatchSchema, req)));
  });
  app.post("/api/rooms/:id/members", async (req, res) => {
    res.json(await board().addMember(req.params.id, body(memberAddSchema, req)));
  });
  app.patch("/api/rooms/:id/members/:memberId", async (req, res) => {
    res.json(await board().patchMember(req.params.id, req.params.memberId, body(memberPatchSchema, req)));
  });
  app.delete("/api/rooms/:id/members/:memberId", async (req, res) => {
    res.json(await board().removeMember(req.params.id, req.params.memberId));
  });
  app.post("/api/rooms/:id/members/:memberId/reset", async (req, res) => {
    res.json(await board().resetMemberSession(req.params.id, req.params.memberId));
  });

  // Persist and queue: the turn runs on its own, with no request holding it open.
  app.post("/api/rooms/:id/messages", async (req, res) => {
    res.status(202).json(await board().postMessage(req.params.id, body(roomMessageSchema, req)));
  });
  app.post("/api/rooms/:id/stop", async (req, res) => {
    await board().stop(req.params.id);
    res.json({ ok: true });
  });
  app.delete("/api/rooms/:id/queue/:turnId", async (req, res) => {
    res.json({ queued: await board().cancelQueued(req.params.id, req.params.turnId) });
  });
  app.post("/api/rooms/:id/requests/:requestId/answer", async (req, res) => {
    const { answer } = body(roomAnswerSchema, req);
    await board().answerRequest(req.params.id, req.params.requestId, answer);
    res.json({ ok: true });
  });
  app.get("/api/rooms/:id/history", async (req, res) => {
    const query = roomHistoryQuery.parse(req.query);
    res.json({ records: await board().roomHistory(req.params.id, query) });
  });
  app.get("/api/rooms/:id/usage", async (req, res) => {
    res.json(await board().roomUsage(req.params.id));
  });
  app.get("/api/rooms/:id/export", async (req, res) => {
    const markdown = await board().exportRoom(req.params.id);
    const info = await board().roomSnapshot(req.params.id);
    const slug = info.room.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}-${new Date().toISOString().slice(0, 10)}.md"`);
    res.send(markdown);
  });

  // The room stream: same snapshot/replay semantics as a chat's.
  app.get("/api/rooms/:id/events", async (req, res) => {
    const manager = board();
    const last = parseLastEventId(req.headers["last-event-id"] ?? req.query.lastEventId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    let closed = false;
    const write = (chunk: string) => {
      if (!closed) res.write(chunk);
    };
    let unsubscribe: () => void;
    try {
      // subscribe validates the room before it sends anything, so an unknown id ends the stream cleanly.
      unsubscribe = await manager.subscribe(
        req.params.id,
        {
          send: (id: number, event) => write(`id: ${id}\nevent: room\ndata: ${JSON.stringify(event)}\n\n`),
          close: () => {
            if (!closed) {
              closed = true;
              res.end();
            }
          },
        },
        last,
      );
    } catch {
      closed = true;
      res.end();
      return;
    }
    const heartbeat = setInterval(() => write("event: heartbeat\ndata: {}\n\n"), deps.heartbeatMs ?? 20_000);
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // A board-owned chat is driven only by its room scheduler. Ordinary chat routes
  // must not read it, answer its requests, or open a second writer on it.
  app.use("/api/chats/:id", (req, _res, next) => {
    const owned = deps.boards !== undefined && manager.list().some((chat) => chat.chatId === req.params.id && chat.owner);
    if (owned) throw new ChatError(404, "chat_not_found", "No such chat");
    next();
  });

  app.post("/api/chats", async (req, res) => {
    const input = body(createChatSchema, req);
    const adapter = await availableAdapter(input.harnessId);
    const ws = await workspaces.get(input.workspaceId);
    const chat = await manager.create(adapter, ws);
    if (input.model || input.thinkingLevel) {
      // The start screen picked these before the session existed: apply them now, while the chat
      // is still starting and nothing has run, so the first prompt already uses them.
      try {
        await chat.setConfig({ ...(input.model ? { model: input.model } : {}), ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}) });
      } catch (error) {
        await chat.dispose("The chosen model or thinking level was refused").catch(() => undefined);
        throw error;
      }
    }
    res.status(201).json(chat.snapshot());
  });

  app.post("/api/chats/resume", async (req, res) => {
    const input = body(resumeChatSchema, req);
    const adapter = await availableAdapter(input.harnessId);
    const prefix = `${adapter.id}:`;
    if (!input.sessionId.startsWith(prefix)) throw new ChatError(400, "wrong_harness", "Session belongs to another harness");
    const ws = await workspaces.get(input.workspaceId);
    const nativeId = input.sessionId.slice(prefix.length);
    // Refuse a board-owned session before any resume: a second writer outside the room scheduler is never allowed.
    if (deps.boards?.ownsNativeSession(adapter.id, nativeId)) throw new ChatError(404, "not_found", "That session belongs to a Board room");
    // A herdr pane runs this session's harness already: a second one here would write the same session file.
    if (deps.herdr && !input.ignoreHerdr && !manager.liveChatFor(adapter.id, nativeId)) {
      const pane = (await deps.herdr.bySession()).get(input.sessionId);
      if (pane) {
        throw new ChatError(409, "open_in_herdr", `This session is open in herdr (pane ${pane.paneId}, ${pane.status}): opening it here as well would run a second ${adapter.displayName} on the same session`);
      }
    }
    const chat = await manager.resume(adapter, ws, nativeId);
    res.json(chat.snapshot());
  });

  /**
   * Restart a chat's harness on the same session: the settings, tools, skills, and
   * extensions it loads are read again while the conversation stays. The old chat is
   * disposed and a new one resumes the session, so the answer carries the new chat id.
   */
  app.post("/api/chats/:id/restart", async (req, res) => {
    const old = manager.get(req.params.id);
    if (old.status !== "idle" && old.status !== "error") throw new ChatError(409, "busy", "Wait until the agent is idle");
    const prefix = `${old.adapter.id}:`;
    if (!old.sessionId?.startsWith(prefix)) throw new ChatError(409, "no_session", "This chat has no saved session to restart yet");
    const nativeId = old.sessionId.slice(prefix.length);
    const { workspace, adapter } = old;
    await old.dispose("Restarted");
    const chat = await manager.resume(adapter, workspace, nativeId);
    res.json(chat.snapshot());
  });

  // Show a herdr pane (a session open there). Only this machine: herdr's socket controls its terminals,
  // and a pane switched from another device would change a screen nobody there is looking at.
  app.post("/api/herdr/focus", async (req, res) => {
    if (res.locals.local !== true) throw new ChatError(403, "local_only", "Only this machine can switch herdr's panes");
    if (!deps.herdr?.on) throw new ChatError(404, "herdr_off", "The herdr integration is turned off");
    const { paneId } = body(herdrFocusSchema, req);
    try {
      await deps.herdr.focus(paneId);
    } catch (error) {
      if (error instanceof HerdrError) throw new ChatError(error.code === "not_running" || error.code === "timeout" ? 503 : 422, "herdr_failed", `herdr: ${error.message}`);
      throw error;
    }
    res.json({ ok: true });
  });

  // An image under a prompt (see image-store): the id is the hash of its bytes, so it never changes.
  app.get("/api/images/:id", (req, res) => {
    const image = /^[0-9a-f]{32}$/.test(req.params.id) ? storedImage(req.params.id) : null;
    if (!image) throw new ChatError(404, "no_image", "That image is no longer held; reload the chat");
    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(image.bytes);
  });

  // An agent-rendered HTML page, shown in a sandboxed frame. The id addresses
  // the bytes the chat's render tool stored; the chat in the path must be one
  // whose transcript carries that id, so one chat cannot read another's page.
  // Served as HTML, but to an opaque-origin frame (never allow-same-origin),
  // so its scripts cannot reach the app's session.
  app.get("/api/chats/:id/html-render/:renderId", async (req, res) => {
    const stateDir = deps.stateDir;
    if (!stateDir) throw new ChatError(404, "render_off", "HTML render is not wired on this server");
    const chat = manager.get(req.params.id);
    const id = req.params.renderId;
    const html = isHtmlRenderId(id) && chat.ownsHtmlRender(id) ? await readHtmlRender(stateDir, id) : null;
    res.setHeader("X-Content-Type-Options", "nosniff");
    // The chat embeds this page in a sandboxed iframe on the same origin; the
    // global helmet CSP (`frame-ancestors 'none'`) would block that framing.
    // A missing page is framed too: a JSON error under 'none' shows as the
    // browser's own "can't open this page" instead of saying what happened.
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'; sandbox allow-scripts allow-forms");
    if (html === null) {
      res.status(404).setHeader("Cache-Control", "no-store");
      res.type("html").send(RENDER_GONE_PAGE);
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.send(html);
  });

  app.get("/api/chats/:id", (req, res) => {
    res.json(manager.get(req.params.id).snapshot());
  });

  app.get("/api/chats/:id/events", (req, res) => {
    const chat = manager.get(req.params.id);
    const last = parseLastEventId(req.headers["last-event-id"] ?? req.query.lastEventId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    let closed = false;
    const write = (chunk: string) => {
      if (!closed) res.write(chunk);
    };
    const unsubscribe = chat.subscribe(
      {
        send: (id: number, event: ChatEvent) => write(`id: ${id}\nevent: chat\ndata: ${JSON.stringify(event)}\n\n`),
        close: () => {
          if (!closed) {
            closed = true;
            res.end();
          }
        },
      },
      last,
    );
    const heartbeat = setInterval(() => write("event: heartbeat\ndata: {}\n\n"), deps.heartbeatMs ?? 20_000);
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/chats/:id/pastes", express.json({ limit: "1100kb" }), async (req, res) => {
    const chat = manager.get(req.params.id);
    const { text } = body(uploadPasteSchema, req);
    res.status(201).json(await storePaste(chat.chatId, text));
  });

  app.post("/api/chats/:id/messages", async (req, res) => {
    const chat = manager.get(req.params.id);
    const { text, images, mode, compactFirst, attachments } = body(sendMessageSchema, req);
    for (const image of images) {
      if (sniffImage(image.data) !== image.mimeType) throw new ChatError(400, "bad_image", "An attachment is not the image type it claims to be");
    }
    const pastes = attachments.length > 0 ? await Promise.all(attachments.map((a) => resolvePaste(chat.chatId, a.id))) : [];
    const header = pastes
      .map((p) => `[Pasted content is saved as ${p.path} (${p.lines.toLocaleString("en-US")} lines). Read that file with your tools rather than asking me to resend it.]`)
      .join("\n");
    await chat.send(header ? `${header}\n\n${text}` : text, mode, images, compactFirst ? { compactFirst } : {});
    res.status(202).json({ accepted: true, mode });
  });

  app.post("/api/chats/:id/rewind", async (req, res) => {
    const chat = manager.get(req.params.id);
    const { turn, text, images } = body(rewindSchema, req);
    for (const image of images) {
      if (sniffImage(image.data) !== image.mimeType) throw new ChatError(400, "bad_image", "An attachment is not the image type it claims to be");
    }
    await chat.rewind(turn, text, images);
    res.status(202).json({ accepted: true });
  });

  app.post("/api/chats/:id/abort", (req, res) => {
    const chat = manager.get(req.params.id);
    chat.abort().catch((error: unknown) => log(`abort failed: ${errorMessage(error)}`));
    res.status(202).json({ accepted: true });
  });

  app.patch("/api/chats/:id/config", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.setConfig(body(patchConfigSchema, req));
    res.json(chat.snapshot().config);
  });

  // A subagent's own transcript, for the viewer: read from the file its harness wrote.
  app.get("/api/chats/:id/tools/:toolId/agents/:runId", async (req, res) => {
    res.json(await manager.get(req.params.id).subagentTranscript(req.params.toolId, req.params.runId));
  });

  app.get("/api/chats/:id/commands", async (req, res) => {
    res.json({ commands: await manager.get(req.params.id).commands() });
  });

  app.post("/api/chats/:id/models/refresh", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.refreshModels();
    res.json(chat.snapshot().config);
  });

  // An edited or removed queued message: the whole queue, as it should now be.
  app.put("/api/chats/:id/queue", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.replaceQueue(body(queueSchema, req));
    res.json({ accepted: true });
  });

  app.post("/api/chats/:id/rename", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.rename(body(renameSchema, req).name);
    res.json({ title: chat.title });
  });

  app.post("/api/chats/:id/compact", (req, res) => {
    const chat = manager.get(req.params.id);
    const { instructions } = body(compactSchema, req);
    if (chat.status !== "idle") throw new ChatError(409, "busy", "Compact only while idle");
    chat.compact(instructions).catch((error: unknown) => log(`compact failed: ${errorMessage(error)}`));
    res.status(202).json({ accepted: true });
  });

  /**
   * Carry a chat on after a usage limit resets. The timer is the server's, so it
   * fires with every browser closed; the route is bounded a little under
   * setTimeout's own ceiling (24.8 days), which is longer than any limit window.
   */
  app.post("/api/chats/:id/continue-at", (req, res) => {
    const chat = manager.get(req.params.id);
    const { at } = body(continueAtSchema, req);
    if (at !== null && at > Date.now() + 24 * 86_400_000) throw new ChatError(400, "bad_continue", "That is further away than a month");
    chat.scheduleContinue(at);
    res.json({ ok: true, continueAt: chat.continueAt });
  });
  app.post("/api/chats/:id/run", async (req, res) => {
    const chat = manager.get(req.params.id);
    const { command, shell } = body(runCommandSchema, req);
    log(`run: a ${shell} command in ${chat.workspace.name}`);
    await prepareSpawnEnv(chat.workspace.path);
    res.json(await runCommand(command, shell, chat.workspace.path));
  });

  // The project's git status (the composer's git row) and a listed file's diff.
  app.get("/api/chats/:id/git", async (req, res) => {
    const chat = manager.get(req.params.id);
    res.json({ status: await gitStatus(chat.workspace.path).catch(() => null), direnv: direnvState(chat.workspace.path) });
  });
  app.get("/api/chats/:id/git/diff", async (req, res) => {
    const chat = manager.get(req.params.id);
    const file = typeof req.query.path === "string" ? req.query.path : "";
    if (!file || file.length > 4096) throw new ChatError(400, "bad_path", "Name a changed file");
    const side = req.query.side === "staged" || req.query.side === "untracked" ? req.query.side : "unstaged";
    const diff = await gitFileDiff(chat.workspace.path, file, side).catch((error: unknown) => {
      throw new ChatError(422, "git_failed", errorMessage(error));
    });
    if (!diff) throw new ChatError(404, "not_changed", "That file has no changes now");
    res.json(diff);
  });

  const gitWrite = async (req: Request<{ id: string }>, run: (cwd: string) => Promise<GitStatus>) => {
    const chat = manager.get(req.params.id);
    try {
      return await run(chat.workspace.path);
    } catch (error) {
      if (error instanceof GitActionError) throw new ChatError(error.status, error.code, error.message);
      throw error;
    }
  };
  /** Stage, unstage, or commit from the git panel: every write this app makes to a repository, by hand. */
  app.post("/api/chats/:id/git/stage", async (req, res) => {
    const { paths } = body(gitPathsSchema, req);
    res.json({ status: await gitWrite(req, (cwd) => stageFiles(cwd, paths)) });
  });
  app.post("/api/chats/:id/git/unstage", async (req, res) => {
    const { paths } = body(gitPathsSchema, req);
    res.json({ status: await gitWrite(req, (cwd) => unstageFiles(cwd, paths)) });
  });
  app.post("/api/chats/:id/git/commit", async (req, res) => {
    const { message } = body(gitCommitSchema, req);
    res.json({ status: await gitWrite(req, (cwd) => commitStaged(cwd, message)) });
  });

  // File checkpoints: what restoring a turn would do, doing it, and putting the files back again.
  const checkpointsOf = (chat: Chat, write: boolean) => {
    if (!chat.checkpoints) throw new ChatError(404, "no_checkpoints", "This chat keeps no file checkpoints");
    if (write && chat.status !== "idle" && chat.status !== "error") throw new ChatError(409, "busy", "Wait until the agent is idle");
    return chat.checkpoints;
  };
  const turnOf = (raw: string) => {
    const turn = Number(raw);
    if (!Number.isInteger(turn) || turn < 1) throw new ChatError(400, "bad_turn", "Not a turn");
    return turn;
  };
  const checkpointFailure = (error: unknown): never => {
    throw error instanceof ChatError ? error : new ChatError(422, "checkpoint_failed", errorMessage(error));
  };
  // The file timeline: each prompt's checkpoint, and what changed between any two of them (or now).
  app.get("/api/chats/:id/checkpoints", async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), false);
    await cp.start();
    res.json({ points: cp.points() });
  });
  app.get("/api/chats/:id/checkpoints/compare", async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), false);
    const { from, to } = checkpointCompareSchema.parse(req.query);
    res.json((await cp.compare(from, to).catch(checkpointFailure)) satisfies CheckpointComparison);
  });
  app.get("/api/chats/:id/checkpoints/:turn", async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), false);
    const { files } = await cp.preview(turnOf(req.params.turn)).catch(checkpointFailure);
    res.json({ files } satisfies CheckpointPreview);
  });
  app.post("/api/chats/:id/checkpoints/:turn/restore", async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), true);
    const { paths } = body(restoreSchema, req);
    res.json((await cp.restore(turnOf(req.params.turn), paths).catch(checkpointFailure)) satisfies CheckpointRestored);
  });
  app.post("/api/chats/:id/checkpoints/put-back", async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), true);
    const { tree, paths } = body(putBackSchema, req);
    const all = paths ?? (await cp.previewTree(tree).catch(checkpointFailure)).files.map((f) => f.path);
    if (all.length === 0) {
      res.json({ files: [], undo: tree } satisfies CheckpointRestored);
      return;
    }
    res.json((await cp.restore(null, all, tree).catch(checkpointFailure)) satisfies CheckpointRestored);
  });

  app.post("/api/chats/:id/fork", async (req, res) => {
    const { through } = body(forkChatSchema, req);
    const chat = manager.get(req.params.id);
    if (!chat.adapter.capabilities.supportsFork) throw new ChatError(400, "unsupported", `${chat.adapter.displayName} sessions cannot be forked`);
    if (!chat.nativeId) throw new ChatError(409, "not_started", "This chat has no session to fork yet");
    const forked = await chat.adapter.forkSession({ cwd: chat.workspace.path, nativeId: chat.nativeId, throughTurns: through });
    res.status(201).json((await manager.resume(chat.adapter, chat.workspace, forked.nativeId)).snapshot());
  });

  /** Continue `chat` in `harness`: a copy of its turns where the harness keeps them, else a fresh chat briefed with a summary. */
  const handoffChat = async (chat: Chat, harness: string, { through, prompt }: { through?: number; prompt?: string } = {}): Promise<Chat> => {
    const target = await availableAdapter(harness);
    if (target.id === chat.adapter.id) throw new ChatError(400, "same_harness", "That chat is already in this harness");
    if (!chat.nativeId) throw new ChatError(409, "not_started", "This chat has no session to hand off yet");
    // Busy chats stop first (stop-here-continue-there); the source stays open
    // in aborted state so nothing is lost if seeding fails.
    if (chat.status === "running" || chat.status === "compacting" || chat.status === "stopping") await chat.abort();
    const snap = chat.snapshot();
    const seed = toSeed(snap.items, { title: snap.title, todos: snap.todos, throughTurns: through });
    const draft = prompt?.trim() ? prompt : null;
    if (isEmptySeed(seed) && !draft) throw new ChatError(400, "empty_handoff", "There is nothing to hand off yet");
    if (!target.capabilities.supportsHandoff) {
      // No store of past turns to write into: a fresh chat whose first prompt is the briefing.
      let moved: Chat;
      try {
        moved = await manager.create(target, chat.workspace);
      } catch (error) {
        throw new ChatError(502, "handoff_failed", `${target.displayName} could not take this session: ${errorMessage(error)}`);
      }
      const brief = briefPrompt(seed, { from: chat.adapter.displayName, project: chat.workspace.name, draft });
      await moved.send(brief, "normal").catch(() => undefined);
      // After the send: some harnesses only have a session to name once the first prompt is in.
      if (seed.title && target.capabilities.supportsRename) await moved.rename(seed.title).catch(() => undefined);
      return moved;
    }
    let live;
    try {
      live = await target.seedChat({ cwd: chat.workspace.path, seed });
    } catch (error) {
      throw new ChatError(502, "handoff_failed", `${target.displayName} could not take this session: ${errorMessage(error)}`);
    }
    const moved = await manager.seedOpen(target, chat.workspace, live);
    // The draft is the target's first real turn: sent, not just recorded.
    // A rejected send leaves its notice in the new chat, which still opens.
    if (draft) await moved.send(draft, "normal").catch(() => undefined);
    return moved;
  };
  app.post("/api/chats/:id/handoff", async (req, res) => {
    const { harness, through, prompt } = body(handoffSchema, req);
    res.status(201).json((await handoffChat(manager.get(req.params.id), harness, { ...(through ? { through } : {}), ...(prompt ? { prompt } : {}) })).snapshot());
  });

  // The chain: what a chat runs after its run settles, kept here so it goes on with no browser open.
  manager.onChainHandoff = async (chat, step, rest) => {
    const moved = await handoffChat(chat, step.harness, step.prompt ? { prompt: step.prompt } : {});
    if (rest.length > 0) moved.setChain(rest, true);
  };
  app.put("/api/chats/:id/chain", async (req, res) => {
    const { steps, resume } = body(chainSchema, req);
    const chat = manager.get(req.params.id);
    for (const step of steps) {
      if (step.kind !== "handoff") continue;
      await availableAdapter(step.harness);
      if (step.harness === chat.adapter.id) throw new ChatError(400, "same_harness", "A handoff goes to another harness");
    }
    chat.setChain(
      steps.map((s) => ({ ...s, id: randomUUID() })),
      resume ?? false,
    );
    const snap = chat.snapshot();
    res.json({ chain: snap.chain, paused: snap.chainPaused });
  });

  app.post("/api/chats/:id/requests/:requestId", async (req, res) => {
    const chat = manager.get(req.params.id);
    const { answer } = body(answerSchema, req);
    const outcome = chat.answer(req.params.requestId, answer);
    res.json({ outcome });
  });

  app.post("/api/chats/:id/dispose", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.dispose("Closed by user");
    res.json({ disposed: true });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found", code: "not_found" });
  });

  const embedded = embeddedWeb();
  if (embedded) {
    // The binary carries the web bundle: serve it from memory, same caching rules as on disk.
    app.get(/^\/(?!api\/).*/, (req, res) => {
      const urlPath = req.path === "/" ? "/index.html" : req.path;
      const file = embedded.get(urlPath) ?? embedded.get("/index.html");
      if (!file) {
        res.status(404).end();
        return;
      }
      // index.html and the worker are how a deploy reaches a page; the rest is content-hashed.
      const fresh = urlPath.endsWith(".html") || urlPath === "/index.html" || urlPath === "/sw.js";
      res.setHeader("Cache-Control", fresh ? "no-store" : "public, max-age=3600");
      res.setHeader("Content-Type", file.contentType);
      res.send(file.text);
    });
  } else if (deps.webDir && existsSync(path.join(deps.webDir, "index.html"))) {
    const webDir = deps.webDir;
    app.use(express.static(webDir, { index: "index.html", maxAge: "1h", setHeaders: noStoreHtml }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof ChatError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request", code: "invalid_request" });
      return;
    }
    const status = (error as { status?: number; type?: string }).status;
    if (status === 413 || status === 400) {
      res.status(status).json({ error: status === 413 ? "Request too large" : "Malformed request", code: "bad_request" });
      return;
    }
    log(`internal error: ${errorMessage(error)}`);
    res.status(500).json({ error: "Internal error", code: "internal" });
  });

  return app;
}

/** The served index.html, whose asset names name the build; null when there is none. */
function readIndexHtml(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, "index.html"), "utf8");
  } catch {
    return null;
  }
}

function noStoreHtml(res: Response, filePath: string): void {
  if (filePath.endsWith(".html") || path.basename(filePath) === "sw.js") res.setHeader("Cache-Control", "no-store");
}
