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
  workerPlanSaveSchema,
  workerPlanConfirmSchema,
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
  orchCallSchema,
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
  acpTestSchema,
  inviteCreateSchema,
  invitePatchSchema,
  settingsPatchSchema,
  terminalCreateSchema,
  terminalWriteSchema,
  htmlRenderPreviewSchema,
  renderActionSchema,
  worktreeCreateSchema,
  prTourRequestSchema,
  prRepairSchema,
  accountSelectionSchema,
  prCheckoutSchema,
  prWatchSchema,
  prUnwatchSchema,
  prStackCreateSchema,
  prStackMergeSchema,
  projectConfigTrustSchema,
  compareStartSchema,
  raceCleanupSchema,
  raceDiffQuery,
  raceWinnerSchema,
  taskReviewDecisionSchema,
  gitHubPrSchema,
  resumeChatSchema,
  herdrFocusSchema,
  rewindSchema,
  runCommandSchema,
  gitPathsSchema,
  gitCommitSchema,
  savedPromptSchema,
  sessionMarkSchema,
  routineSchema,
  routineRunsQuerySchema,
  sessionBulkMarkSchema,
  sessionOrderSchema,
  pushSubscriptionSchema,
  pushTestSchema,
  presenceSchema,
  createThreadSchema,
  replySchema,
  threadStatusSchema,
  type AttributionSnapshot,
  reanchorSchema,
  secondOpinionSchema,
  sideThreadSchema,
  type SecondOpinionResult,
  type SideThreadResult,
  sendThreadsSchema,
  type ReviewSendResult,
  type RotateResult,
  type ReviewThread,
  putBackSchema,
  type AcpAgentProbe,
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
  type HandoverReclaim,
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
import { storedImage, rememberImage } from "./image-store.js";
import { isHtmlRenderId, readHtmlRender, saveHtmlRender } from "./html-render.js";
import { Idempotency } from "./idempotency.js";
import type { ChatManager } from "./chats/manager.js";
import type { HarnessRegistry } from "./harness/registry.js";
import type { HarnessAdapter, NativeSessionSummary } from "./harness/types.js";
import { briefPrompt, isEmptySeed, sideThreadPrompt, toSeed, turnBrief } from "./harness/handoff.js";
import { sniffImage } from "./images.js";
import { deletePaste, resolvePaste, storePaste } from "./paste-store.js";
import { projectFiles, searchFiles } from "./project-files.js";
import { searchProject } from "./project-search.js";
import type { Security } from "./security.js";
import { makeRequireGrant, InviteStore, invitesFileOf, isGrant, GRANTS, type Grant, type GrantsOf as GrantsOfFn } from "./grants.js";
import type { ThemeStore } from "./theme.js";
import { readSettings, savedAcpAgent, writeSettings, type Requester, type SettingsContext } from "./settings.js";
import { AcpAdapter } from "./harness/acp.js";
import { readAwuiConfig, writeAwuiConfig } from "./awui-settings.js";
import { breakdownRules, readUserConfig, uiSettings } from "./user-config.js";
import { agentProfiles } from "./config.js";
import { HerdrError, type Herdr } from "./herdr.js";
import type { DeviceHost } from "./device-host.js";
import { SessionMarks } from "./session-marks.js";
import { Handovers } from "./handover.js";
import { AgentStatuses } from "./agent-status.js";
import { SessionOrder } from "./session-order.js";
import { checkoutOf } from "./checkouts.js";
import { SavedPrompts } from "./saved-prompts.js";
import { Routines } from "./routines.js";
import { Heartbeats, viewOf as heartbeatViewOf } from "./heartbeats.js";
import { RoutineRuns } from "./routine-runs.js";
import { RESUME_TEXT, ResumeIntents } from "./resume-intent.js";
import { routineNote, runRoutine } from "./routine-runner.js";
import { cadenceProblem } from "../shared/routine-schedule.js";
import { deliveryKey, GITHUB_SIGNATURE_HEADER, HookGate, hookMatches, hookPrompt, MAX_HOOK_BODY, MAX_HOOKS_PER_HOUR, SIGNATURE_HEADER, signatureMatches } from "./routine-webhook.js";
import { ReviewProblem, ReviewThreads } from "./review-threads.js";
import { SecondOpinions, reportExcerpt } from "./second-opinions.js";
import { attributionSnapshot } from "./attribution.js";
import { batchPrompt } from "../shared/review.js";
import { Limits } from "./limits.js";
import { Notifier, pushEndpointProblem } from "./notify.js";
import { PresenceTable } from "./presence.js";
import { ChatSearcher, type SearchTarget } from "./chat-search.js";
import { readMedia, viewFile } from "./file-view.js";
import { writeProjectFile } from "./project-upload.js";
import { UsageReader, type UsageTarget } from "./usage-report.js";
import { Checkpoints } from "./checkpoints.js";
import { gitFileDiff, gitStatus } from "./git-status.js";
import { git } from "./git.js";
import { commitStaged, GitActionError, stageFiles, unstageFiles } from "./git-actions.js";
import { runCommand, runShellCommand } from "./run-command.js";
import { PrWatches, readPrSnapshot, repairPrompt, clipRepairLog } from "./pr-watches.js";
import type { RunResult, WorktreeInfo } from "../shared/protocol.js";

/** A setup command's limits: a real install can take minutes, and its output is read in a dialog. */
const SETUP_TIMEOUT_MS = 5 * 60_000;
const SETUP_MAX_OUTPUT = 32_000;
import { shellLine } from "./shell-line.js";
import type { Workspaces } from "./workspaces.js";
import { allowEnvrc, direnvState, prepareSpawnEnv } from "./direnv.js";
import { ModelCatalog } from "./model-catalog.js";
import { notePressure, overviewEvents } from "./overview-events.js";
import { PressureMonitor } from "./pressure.js";
import type { TerminalManager } from "./terminal.js";
import { ManagedWorktrees, worktreeProblem } from "./worktrees.js";
import { PROJECT_CONFIG_FILE, projectConfigStatus, ProjectConfigTrust, readProjectConfig } from "./project-config.js";
import { Races, raceChatsFor, type RaceRecord } from "./races.js";
import { githubStatus, pushBranch, createPullRequest, pullRequestChecks, currentPullRequest, pullRequestDetail, mergePullRequest, runGh } from "./github.js";
import { closeRenderPage } from "./render-browser.js";
import { PrStacks } from "./stacks.js";
import { readTour } from "./pr-tour.js";
import { previewHtmlRender, PreviewError } from "./render-preview.js";
import { performRenderAction } from "./render-browser.js";
import { GuestStore } from "./guests.js";
import { Orchestrator } from "./orchestration/orchestrator.js";
import { IntegrationReview, type IntegrationRecord, type ReviewProject } from "./orchestration/review.js";
import { ORCH_TOOLS } from "./orchestration/tools.js";
import { DEFAULT_ORCHESTRATION_LIMITS, type OrchestrationLimits } from "./orchestration/limits.js";
import { orchestrationSkills } from "./orchestration/skills.js";
import { answerMcp, isToolCall } from "./orchestration/mcp.js";
import { denial, type OrchDenialCode } from "./orchestration/types.js";


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
  /** Interactive PTYs share server lifetime; tests intentionally have none unless requested. */
  terminals?: TerminalManager;
  /** Where config.yml lives; its browser settings are re-read on every page load. */
  configDir?: string | null;
  /** The Settings dialog's view of config.yml; without it the settings routes answer 404. */
  settings?: SettingsContext;
  /** The server state folder, where agent-rendered pages and invites live. */
  stateDir?: string | null;
  /** Limited-session invitations (grants.ts); in memory when absent. */
  invites?: InviteStore;
  /** Expiring single-chat guest invitations and owner-reviewed queue; separate from native transcripts. */
  guests?: GuestStore;
  heartbeatMs?: number;
  /** Pinned and archived sessions; in memory when absent. */
  marks?: SessionMarks;
  /** Review threads (comments on diff lines); in memory when absent. */
  reviewThreads?: ReviewThreads;
  /** Turns sent to another harness for a second opinion; in memory when absent. */
  secondOpinions?: SecondOpinions;
  /** Comparisons of one prompt in several worktree chats; in memory when absent. */
  races?: Races;
  /** Stacked pull requests per project (stacks.ts); in memory when absent (tests). */
  prStacks?: PrStacks;
  /** Hand-made session orders; in memory when absent. */
  order?: SessionOrder;
  /** Saved prompts, for every device; in memory when absent (tests). */
  prompts?: SavedPrompts;
  /** Scheduled runs; in memory when absent. */
  routines?: Routines;
  /** Agent-scoped heartbeats (heartbeats.ts); in memory when absent. */
  heartbeats?: Heartbeats;
  /** The opt-in PR watchers, persistent per native session (pr-watches.ts); absent files are memory only. */
  prWatches?: PrWatches;
  /** Routines' run history (a run's verdict, and the sessions it opened); in memory when absent. */
  routineRuns?: RoutineRuns;
  /** Sessions that were running when the last process stopped; in memory when absent (nothing to resume). */
  resumeIntents?: ResumeIntents;
  /** Sessions handed off to a terminal (the exact resume line, a lock against a second writer); in memory when absent. */
  handovers?: Handovers;
  /** Subscription limits; in memory when absent. */
  limits?: Limits;
  /** Notes and Web Push for devices that turned notifications on; in memory when absent. */
  notifier?: Notifier;
  /** Which connected client visibly focuses which chat or room, so its notifications are not sent; in memory when absent. */
  presence?: PresenceTable;
  /** Where file checkpoints live (shadow repositories, and each session's list of them); none when absent. */
  checkpointsDir?: string | null;
  /** The start screen's model answers per harness and project; saved in the state folder when absent and one is set. */
  modelCatalog?: ModelCatalog;
  /** Herdr's panes, to mark the sessions they run; none when absent (tests that do not ask for it). */
  herdr?: Herdr;
  /** Device hosts (emulators/simulators, device-host.ts); none when absent — the route answers 404. */
  deviceHosts?: DeviceHost[];
  /** Board rooms; without one the board routes answer 404 and ownership filtering is a no-op. */
  boards?: BoardManager;
  /** Agent-set status lines (agent-status.ts); in memory when absent (tests). */
  agentStatuses?: AgentStatuses;
  /** Which projects' `awui.yml` versions a person trusted (project-config.ts); in memory when absent (tests). */
  projectConfigTrust?: ProjectConfigTrust;
  /** The orchestration surface's bounds, read at each use; config.yml's `orchestration:` (none: the defaults). */
  orchestrationLimits?: () => OrchestrationLimits;
  /**
   * Hibernation for idle finished chats, as config.yml's `hibernate_after_minutes` states it
   * (epoch ms; none or 0: off). The manager parks a chat that has stayed hidden — unviewed and
   * unread — past this, and the mark route below records why its live chat is gone.
   */
  hibernateAfterMs?: number;
  /** The server's own resource-pressure monitor; a fresh one, sampled on a cadence, when absent. A test passes its own quiet one. */
  pressure?: PressureMonitor;
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
 * One file of a worker's worktree, against its fork point: the same bounded diff a race
 * member's route answers. The record carries the worktree path it revalidated; the project
 * is the one the caller just got through workspaces.get(), so a tree that has left it is
 * refused before any read.
 */
function reviewFileDiff(record: IntegrationRecord, file: string, project: ReviewProject): Promise<{ path: string; diff: string }> {
  const READ = { timeoutMs: 20_000 };
  return git(["--literal-pathspecs", "diff", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", record.fork, "--", file], {
    cwd: record.workspacePath,
    ...READ,
    okExit: [1],
  }).then(
    (text) => ({ path: file, diff: text }),
    (error: unknown) => {
      throw new ChatError(422, "git_failed", errorMessage(error));
    },
  );
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

export async function createApp(deps: AppDeps) {
  const { registry, manager, workspaces, security, theme } = deps;
  const marks = deps.marks ?? SessionMarks.inMemory();
  const agentStatuses = deps.agentStatuses ?? AgentStatuses.inMemory();
  const projectTrust = deps.projectConfigTrust ?? ProjectConfigTrust.inMemory();
  const reviewThreads = deps.reviewThreads ?? ReviewThreads.inMemory();
  const secondOpinions = deps.secondOpinions ?? SecondOpinions.inMemory();
  const races = deps.races ?? Races.inMemory(raceChatsFor(manager));
  const order = deps.order ?? SessionOrder.inMemory();
  const prompts = deps.prompts ?? SavedPrompts.inMemory();
  const routines = deps.routines ?? Routines.inMemory();
  const heartbeats = deps.heartbeats ?? Heartbeats.inMemory();
  const routineRuns = deps.routineRuns ?? RoutineRuns.inMemory();
  const resumeIntents = deps.resumeIntents ?? ResumeIntents.inMemory();
  const handovers = deps.handovers ?? Handovers.inMemory();
  // The manager's own resume refuses a handed session (H2): every side path — a PR
  // watch's wake, a guest's history poll, a released guest message — goes through
  // `manager.resume`, so the lock cannot be sidestepped by a route that forgot it.
  manager.handedOver = (sessionId) => handovers.get(sessionId);
  /**
   * Whether a session was opened by a routine: not the user's chat, so the session lists
   * leave it out (Usage still counts it) and only a run with something to say is a note.
   */
  const routineSession = (harnessId: string, nativeId: string): boolean => routineRuns.ownsSession(`${harnessId}:${nativeId}`);
  const limits = deps.limits ?? Limits.inMemory(registry);
  manager.onLimits = (account) => limits.report(account);
  manager.limitedSources = async (source) => [...await limits.limitedSources(source)];
  const notifier = deps.notifier ?? Notifier.inMemory();
  const presence = deps.presence ?? PresenceTable.inMemory();
  // The server's own machine, sampled on a cadence: a warning or a recovery is one quiet
  // overview event (the client toasts it), and /api/health carries the state for the doctor.
  // A test passes its own monitor, so nothing samples then.
  const pressure = deps.pressure ?? new PressureMonitor();
  const pressureTimer = deps.pressure
    ? null
    : setInterval(() => {
        const verdict = pressure.push(PressureMonitor.read(), Date.now());
        if (verdict) notePressure(verdict === "warn" ? "warn" : "ok");
      }, 15_000);
  pressureTimer?.unref();
  const modelCatalog = deps.modelCatalog ?? new ModelCatalog(deps.stateDir ? path.join(deps.stateDir, "model-catalog.json") : null);
  const chatSearcher = new ChatSearcher();
  const usageReader = new UsageReader();
  if (deps.checkpointsDir) manager.checkpoints = { service: new Checkpoints(deps.checkpointsDir), sessionsDir: path.join(deps.checkpointsDir, "sessions") };
  manager.onNews = (chat, kind, text, request) => {
    // A board-owned chat's runs are the room's business: the room sends its own notes. A side
    // thread's too: it is a question asked beside its parent, not a run that needs a phone.
    if (chat.owner || chat.side) return;
    // A delegated child's finished or failed run is the parent agent's news, not the phone's: the
    // orchestrator wakes the parent with it. An ask (a question or an approval) still reaches the
    // user, who is the only one who can answer it.
    if (chat.lineage !== undefined && kind !== "ask") return;
    // A routine's run is the routine's news: one note when the run ends with something to
    // say (routine-runner.ts posts it), not one per finished turn of a chat nobody opened.
    if (chat.sessionId && routineRuns.ownsSession(chat.sessionId) && kind !== "ask") return;
    // The user already watches this chat on some connected client, visibly focused: the note would reach for a screen it is on.
    if (presence.viewed({ chatId: chat.chatId })) return;
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
  // A run starting brings a settled session back to the list (that is what settled meant), but
  // not a snoozed one: a snooze that keeps working stays quiet until it fails or asks for
  // something, when the note above wakes it. A run also takes a parked chat back: its mark
  // said the live chat was gone, and a chat that works is not parked any more.
  manager.onRunStart = (chat) => {
    if (chat.owner || chat.side) return;
    if (chat.sessionId) {
      marks.unsettle(chat.sessionId);
      void marks.set(chat.sessionId, { parked: false }).catch(() => undefined);
    }
  };
  // Hibernation: the manager parks (disposes) an idle chat that has stayed hidden — unviewed
  // and unread — past config.yml's `hibernate_after_minutes`, and this records why the live
  // chat is gone. The session id is the mark's key, so the same chat reopens as the same
  // native session; the mark goes when a run starts (above) or the session is read.
  if ((deps.hibernateAfterMs ?? 0) > 0) {
    manager.hibernate = {
      afterMs: deps.hibernateAfterMs as number,
      onParked: (chat) => {
        if (chat.owner || chat.side || !chat.sessionId) return;
        void marks.set(chat.sessionId, { parked: true }).catch(() => undefined);
      },
    };
  }
  const log = deps.log ?? ((m: string) => console.error(m));
  const prWatchesPromise = deps.prWatches ?? Promise.resolve(PrWatches.open(deps.stateDir ?? null, async (watch, report) => {
    const ws = await workspaces.get(watch.workspaceId);
    const nativeId = watch.nativeId.startsWith(`${watch.harnessId}:`) ? watch.nativeId.slice(watch.harnessId.length + 1) : watch.nativeId;
    // A reaped chat's stable native session is the one owner. No peer in the same project is a substitute.
    let chat = manager.liveChatFor(watch.harnessId, nativeId) ?? null;
    const adapter = await availableAdapter(watch.harnessId);
    chat ??= await manager.resume(adapter, ws, nativeId);
    if (!chat) throw new ChatError(404, "session_not_found", "This watched session is no longer available");
    const mode = chat.status === "running" ? chat.snapshot().capabilities.supportsSteer ? "steer" : chat.snapshot().capabilities.supportsFollowUp ? "followUp" : null : "normal";
    if (mode === null) throw new ChatError(409, "chat_busy", "The owner chat has no queue: retain the activity for a later poll");
    await chat.send(report, mode, [], { origin: "agent" });
  }, (id) => workspaces.get(id)));
  // A broken config.yml keeps the defaults here; the server logged why at startup.
  const userConfig = () => {
    try {
      return readUserConfig(deps.configDir ?? null)?.config;
    } catch {
      return undefined;
    }
  };
  // Limited-session invitations (grants.ts): in the state folder when one exists, in
  // memory when absent (tests). The per-route gate resolves the session's list at each
  // use, so a revocation or an edit applies without a restart; only the secret's hash
  // is kept, and a failed save is logged rather than left to reject unattended.
  const invites = deps.invites ?? new InviteStore(deps.stateDir ? invitesFileOf(deps.stateDir) : null, log);
  const guests = deps.guests ?? new GuestStore(deps.stateDir ? `${deps.stateDir}/guest-sessions.json` : null);
  // The store reads its file once, at construction; the first request awaits that read
  // (express 5 runs async middlewares), so no gate resolves before the list is loaded.
  const grantsOf: GrantsOfFn = async (req, res) => {
    // A guest link's cookie is never a session: it has no grants at all, and requireAuth
    // refuses it on every owner route (even on a local server without a password).
    if (security.guestBrowserKey(req, res.locals.authority as string) !== null) return [];
    // A limited session names one invitation; anything else is the owner's full session.
    // An id that no longer exists — revoked, or from before invitations had a secret —
    // resolves to an empty list, so every gate refuses with 403 missing_grant.
    const invite = security.inviteId(req, res.locals.authority as string);
    return invite === null ? null : (await invites.getAfterLoad(invite))?.grants ?? [];
  };
  const requireGrant = makeRequireGrant(grantsOf);
  // Delegated tasks: one record store in the state folder, shared by every chat in this process.
  // The limits come from config.yml, read at each use, so a changed number needs no restart.
  const orchestrationLimits = deps.orchestrationLimits ?? (() => DEFAULT_ORCHESTRATION_LIMITS);
  // Review-gated integration (review.ts): finished isolated workers are recorded here for a
  // person's review; the apply is races.ts's own head-checked patch. Created before the
  // orchestrator, which hands it the finished isolated workers and reads the decisions back.
  const projectTrees = deps.stateDir ? new ManagedWorktrees() : undefined;
  const integrationLedger = await IntegrationReview.open(deps.stateDir, reviewFileDiff).catch((error: unknown) => {
    log(`orchestration: could not open the review ledger: ${errorMessage(error)}`);
    return undefined;
  });
  const orchestration = new Orchestrator({
    chats: manager,
    registry,
    workspaces,
    ...(deps.boards ? { boards: deps.boards } : {}),
    ...(projectTrees ? { trees: projectTrees } : {}),
    ...(integrationLedger ? { review: integrationLedger } : {}),
    file: deps.stateDir ? path.join(deps.stateDir, "orchestration", "tasks.json") : null,
    decisionsFile: deps.stateDir ? path.join(deps.stateDir, "orchestration", "decisions.json") : null,
    statuses: agentStatuses,
    // The shared agent profiles come from config.yml, read at each use, so a Settings
    // change lists them (and applies to a delegation) without a restart.
    profiles: deps.configDir === undefined ? undefined : () => agentProfiles(userConfig()),
    limits: orchestrationLimits,
    heartbeats,
    log,
  });
  // Chats read their lineage and their tasks from the records, so a resumed chat still knows
  // what it is; the load starts here and marks what the last process left running.
  manager.lineageFor = (chat) => orchestration.lineageOf(chat);
  manager.delegatedSession = (harnessId, nativeId) => orchestration.isDelegatedSession(harnessId, nativeId);
  manager.tasksFor = (chat) => orchestration.tasksFor(chat);
  manager.planFor = (chat) => orchestration.planFor(chat);
  // A parent that was closed when a report was written (or when the last process died) gets it here.
  manager.onRegistered = (chat) => {
    void orchestration.registered(chat).catch((error: unknown) => log(`orchestration: could not deliver a report: ${errorMessage(error)}`));
  };
  manager.onDenied = (chat, request, reason) => orchestration.denied(chat, request, reason);
  void orchestration.start().catch((error: unknown) => log(`orchestration: could not load task records: ${errorMessage(error)}`));
  // What this process serves as the web bundle: a page compares it with the build
  // it loaded to notice a deploy (the binary embeds the bundle; a source run has
  // dist/web). "dev" when neither exists, which the client then ignores.
  const build = buildIdOf(embeddedWeb()?.get("/index.html")?.text ?? (deps.webDir ? readIndexHtml(deps.webDir) : null));
  // Retried mutating requests: one answer per Idempotency-Key, kept for ten minutes in this
  // process only. A key belongs to the session that sent it (local use is its own session).
  const idempotency = new Idempotency({
    who: (req, res) => (res.locals.local === true ? "local" : (security.sessionId(req, res.locals.authority as string) ?? "remote")),
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  // The render-doc page serves its own CSP header (see the route below); the global
  // helmet CSP would add a *second* one and the browser enforces the stricter, which
  // would forbid that page's own framing from the same origin. So helmet skips it.
  app.use((req, res, next) => {
    if ((req.path.startsWith("/api/render/") && req.path.endsWith("/doc")) || req.path === "/terminal-shell.html") return next();
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
    // The pressure state rides here (no auth needed, nothing secret): `awui doctor` reads
    // it while probing the port, as the machine's own view of the running server.
    res.json({ ok: true, build, pressure: pressure.status() });
  });

  // Sign-in for other devices; reachable without a session. A password sign-in is
  // full access, as it always was. A limited session never uses that password: it
  // presents one invitation's own secret (grants.ts), shown once at creation and kept
  // only as a hash, and the cookie then carries that invitation's id — every request
  // resolves the id's allow list, so a revocation or an edit applies at once and a
  // revoked invitation has no secret left to sign in with.
  app.post("/api/login", express.json({ limit: "8kb" }), async (req, res, next) => {
    const invite = typeof req.body?.invite === "string" ? req.body.invite.slice(0, 64) : "";
    const secret = typeof req.body?.inviteSecret === "string" ? req.body.inviteSecret.slice(0, 128) : "";
    if (secret === "") return next();
    if (invite === "") throw new ChatError(400, "invite_incomplete", "An invitation sign-in names the invitation and its secret");
    if (!(await invites.verifySecret(invite, secret))) throw new ChatError(401, "bad_invite", "That invitation's secret is wrong, or the invitation has been revoked");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Set-Cookie", security.issueCookie(res.locals.authority as string, res.locals.hostKind === "remote", invite));
    res.json({ ok: true, limited: true });
  }, security.login);
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

  // Per-page agent actions use the render HTML tool's own chat-scoped token,
  // not the orchestrator's task namespace. Every action serves locally stored
  // HTML for an id the authenticated chat itself produces, never an arbitrary URL.
  app.post("/api/render/action", express.json({ limit: "16kb" }), async (req, res) => {
    const stateDir = deps.stateDir;
    if (!stateDir) throw new ChatError(404, "render_off", "The page driver is not wired on this server");
    const token = req.get("x-awui-render-token") ?? "";
    const chat = token !== "" ? manager.chatForRenderToken(token) : undefined;
    if (!chat || chat.owner) throw new ChatError(403, "bad_render_token", "Not this chat's render token");
    const result = await performRenderAction(stateDir, chat, renderActionSchema.parse(req.body));
    const response: { renderId: string; action: string; elements: unknown[]; console: string[]; image?: { id: string; url: string } } = {
      renderId: result.renderId,
      action: result.action,
      elements: result.elements,
      console: result.console,
    };
    const image = result.image?.length ? rememberImage("image/png", result.image.toString("base64")) : undefined;
    if (image) response.image = { id: image.id, url: `/api/images/${image.id}` };
    res.json(response);
  });

  // The orchestration tools in a chat's harness child call back here to delegate, watch, or  // read another chat. Like /api/render these routes sit before requireAuth and
  // authenticate with the random token the child was spawned with (`AWUI_ORCH_TOKEN`,
  // a header) rather than a cookie: the token names the one chat the call speaks for, so a
  // signed-in device elsewhere cannot mint one or reach another chat's tasks through it.
  /**
   * The surface answers only when it is wired and config.yml has not turned it off. The switch is
   * read now, not at startup: the Settings dialog's checkbox takes effect within a couple of seconds.
   */
  const orchOn = (): void => {
    if (!manager.orchestration) throw denial(404, "orch_off", "Orchestration is not wired on this server");
    if (!orchestrationLimits().enabled) throw denial(404, "orch_off", "Orchestration is turned off in config.yml (orchestration.enabled)");
  };
  const orchCaller = (req: Request): Chat => {
    orchOn();
    const token = req.get("x-awui-orch-token") ?? "";
    const chat = token !== "" ? manager.chatForOrchToken(token) : undefined;
    if (!chat) throw denial(401, "bad_orch_token", "Not a live chat's orchestration token");
    // Board-owned chats never get a token, and must not borrow one through this route either.
    if (chat.owner) throw denial(401, "bad_orch_token", "Not a live chat's orchestration token");
    // A token is good for 12 hours; a chat restart (a resume) mints a fresh one.
    if ((chat.orchestration?.expiresAt ?? 0) <= Date.now()) throw denial(401, "orch_token_expired", "This chat's tool token expired; restart the chat to get a new one");
    return chat;
  };

  /**
   * The bridges read `{ ok: false, code, message }`, not the server's `{ error, code }`, so
   * both routes answer a ChatError in their own shape: same status and code, one field
   * named for the model that will read it. Anything else goes to the server's mapping.
   */
  const orchFailed = (res: Response, error: unknown): boolean => {
    if (!(error instanceof ChatError)) return false;
    res.status(error.status).json({ ok: false, code: error.code, message: error.message });
    return true;
  };

  /** The tool catalogue, fetched once by each bridge: one description, one parameter schema. */
  app.get("/api/orchestration/tools", async (req, res) => {
    try {
      // The catalogue is the same for every chat and a starting child asks for it before its chat
      // exists, so a token minted for a child that is still starting is enough here (calls are not).
      const token = req.get("x-awui-orch-token") ?? "";
      orchOn();
      if (token === "" || !manager.knowsOrchToken(token)) throw denial(401, "bad_orch_token", "Not a live chat's orchestration token");
      res.json({ tools: ORCH_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })) });
    } catch (error) {
      if (!orchFailed(res, error)) throw error;
    }
  });
  /**
   * The orchestration skills as MCP prompts (council, advisor, handoff). The words come from
   * skills/<name>/SKILL.md — read by orchestration/skills.ts, from the repo or the binary's
   * embedded copy — so the file an agent can read and the prompt a client offers cannot drift.
   * Same token rule as the catalogue: a starting child may read them before its chat exists.
   */
  app.get("/api/orchestration/prompts", async (req, res) => {
    try {
      const token = req.get("x-awui-orch-token") ?? "";
      orchOn();
      if (token === "" || !manager.knowsOrchToken(token)) throw denial(401, "bad_orch_token", "Not a live chat's orchestration token");
      const skills = await orchestrationSkills();
      res.json({ prompts: skills.map(({ name, description, text }) => ({ name, description, text })) });
    } catch (error) {
      if (!orchFailed(res, error)) throw error;
    }
  });

  app.post("/api/orchestration/call", express.json({ limit: "512kb" }), async (req, res) => {
    try {
      const chat = orchCaller(req);
      const input = body(orchCallSchema, req);
      const out = await orchestration.run(input.tool, input.args ?? {}, chat);
      res.json({ ok: true, text: out.text, data: out.data });
    } catch (error) {
      if (!orchFailed(res, error)) throw error;
    }
  });
  /**
   * The same tools as an MCP server over streamable HTTP: what a harness that can mount an HTTP
   * MCP server connects to per chat, so no Node child is spawned for it. Stateless — every POST is
   * one JSON-RPC message and one answer, and a notification is answered 202 — so it needs no
   * session bookkeeping and a reconnecting client starts clean. The chat token travels in
   * `Authorization: Bearer` (what MCP clients send, and the one header a harness can point at an
   * environment variable), and is never echoed in a message, a header, or a log.
   */
  const orchMcpToken = (req: Request): string => {
    const match = /^Bearer\s+(\S+)$/.exec((req.get("authorization") ?? "").trim());
    return match?.[1] ?? "";
  };
  /**
   * The chat this message speaks for. A tool call needs the live chat itself; a handshake, the
   * catalogue, and the skills need only a token this server minted, because a starting child asks
   * for them before its chat is stamped onto the token (the same rule as the GET routes here).
   */
  const orchMcpCaller = (req: Request, needsChat: boolean): Chat | undefined => {
    orchOn();
    const token = orchMcpToken(req);
    if (token === "") throw denial(401, "bad_orch_token", "Not a live chat's orchestration token");
    const chat = manager.chatForOrchToken(token);
    if (chat) {
      if (chat.owner) throw denial(401, "bad_orch_token", "Not a live chat's orchestration token");
      if ((chat.orchestration?.expiresAt ?? 0) <= Date.now()) throw denial(401, "orch_token_expired", "This chat's tool token expired; restart the chat to get a new one");
      return chat;
    }
    if (manager.knowsOrchToken(token) && !needsChat) return undefined;
    throw denial(401, "bad_orch_token", "Not a live chat's orchestration token");
  };
  /**
   * A body no JSON parser can read, answered as JSON-RPC's parse error rather than the route map's
   * generic envelope: an MCP client reads one or the other, and only this one tells it the message
   * was not a message. Any other body failure (too large) stays the map's.
   */
  const mcpBody = (req: Request, res: Response, next: NextFunction): void => {
    express.json({ limit: "512kb" })(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      if ((error as { type?: unknown }).type !== "entity.parse.failed") {
        next(error);
        return;
      }
      res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    });
  };
  app.post("/api/orchestration/mcp", mcpBody, async (req, res) => {
    try {
      const chat = orchMcpCaller(req, isToolCall(req.body));
      const answered = await answerMcp(req.body, {
        tools: () => ORCH_TOOLS,
        prompts: orchestrationSkills,
        call: async (name, args) => {
          // The chat was checked above for a call; this only satisfies the type when it was not.
          if (!chat) throw denial(401, "bad_orch_token", "Not a live chat's orchestration token");
          try {
            const out = await orchestration.run(name, args, chat);
            return { text: out.text };
          } catch (error) {
            // A refused call is a result the model reads, worded as the stdio bridge words it,
            // with the typed denial code carried beside the sentence.
            if (error instanceof ChatError) return { text: `${error.code}: ${error.message}`, failed: true, code: error.code as OrchDenialCode, message: error.message };
            // The tool's own schema refused the arguments: the same code the REST route answers, with
            // the issue the model has to fix instead of the route map's generic line.
            if (error instanceof ZodError) return { text: `invalid_request: ${error.issues[0]?.message ?? "Invalid request"}`, failed: true, code: "invalid_request", message: error.issues[0]?.message ?? "Invalid request" };
            throw error;
          }
        },
      });
      if (answered.body === null) {
        res.status(answered.status).end();
        return;
      }
      res.status(answered.status).json(answered.body);
    } catch (error) {
      if (!orchFailed(res, error)) throw error;
    }
  });
  // Streamable HTTP lets a server offer a GET stream back to the client. awui never sends a request
  // of its own, so it declines the way the spec asks — `405` with `Allow` — instead of a 404 that a
  // client reads as a broken endpoint and retries.
  const mcpNoStream = (_req: Request, res: Response): void => {
    res.setHeader("Allow", "POST");
    res.status(405).end();
  };
  app.get("/api/orchestration/mcp", mcpNoStream);
  app.delete("/api/orchestration/mcp", mcpNoStream);

  /**
   * A routine's webhook (routine-webhook.ts). The one /api route with no browser session:
   * a sender holds the routine's own secret and signs the body with it (HMAC-SHA256, as
   * GitHub does). It sits before requireAuth for that reason, answers 404 for a routine
   * that has no hook (so a scan learns nothing), is rate limited per routine, bounded to
   * one event's JSON, and only runs a routine whose filters the delivery passes.
   */
  const hookGate = new HookGate();
  app.post("/api/hooks/:id", express.json({ limit: MAX_HOOK_BODY, verify: (req, _res, buf) => void ((req as Request & { rawBody?: string }).rawBody = buf.toString("utf8")) }), async (req, res) => {
    const routine = routines.get(req.params.id);
    const hook = routine?.hook ?? null;
    if (!routine || !hook) throw new ChatError(404, "no_hook", "No such webhook");
    const raw = (req as Request & { rawBody?: string }).rawBody ?? "";
    const signature = req.get(SIGNATURE_HEADER) ?? req.get(GITHUB_SIGNATURE_HEADER);
    if (!signatureMatches(hook.secret, raw, signature)) throw new ChatError(401, "bad_signature", "The signature does not match this body and secret");
    if (!hookGate.allow(routine.id)) throw new ChatError(429, "hook_flood", `At most ${MAX_HOOKS_PER_HOUR} deliveries an hour for one routine`);
    const header = (name: string) => req.get(name);
    if (!hookMatches(hook, header, req.body)) {
      res.status(204).end();
      return;
    }
    if (!hookGate.first(routine.id, deliveryKey(hook, header, req.body))) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    const adapter = await availableAdapter(routine.harnessId);
    const workspace = await workspaces.get(routine.workspaceId);
    const prompted = { ...routine, prompt: hookPrompt(routine.prompt, req.body) };
    const ran = await runRoutine(prompted, workspace, adapter, manager, {
      runs: routineRuns,
      markOutcome: (id, outcome, detail) => routines.markOutcome(id, outcome, detail),
      post: (r, chat, text) => routineNote(notifier, r, chat, text),
    });
    if (!ran.chat) throw new ChatError(409, "routine_skipped", ran.detail ?? "The precheck skipped this run");
    res.status(202).json({ ok: true, chatId: ran.chat.chatId, runId: ran.run?.id ?? null });
  });

  // Guest links are not logins. A redeemed token becomes one browser-scoped,
  // signed invitation whose chat is immutable and whose history is text-only.
  // Owner-only operations still require semantic grants elsewhere, so visitors can't make
  // themselves owners by knowing a URL or a shared invitation id. These routes sit above the
  // `/api` auth gate (the visitor's own routes below must), so the owner ones (list, create, send,
  // dismiss, revoke: everything under /api/guests but redeem) are signed in here: a request with
  // no cookie at all resolves to "full access" in grantsOf and would otherwise pass.
  app.use("/api/guests", (req, res, next) => (req.path === "/redeem" ? next() : security.requireAuth(req, res, next)));

  app.get("/api/guests/:harnessId/:nativeId", requireGrant("chat.read"), async (req, res) => {
    res.json({ guests: await guests.list(req.params.harnessId, req.params.nativeId) });
  });
  app.post("/api/guests/:harnessId/:nativeId", requireGrant("chat.write"), express.json({ limit: "8kb" }), async (req, res) => {
    const source = req.body as Record<string, unknown> | undefined;
    if (typeof source?.workspaceId !== "string") throw new ChatError(400, "invalid_target", "The selected chat's project is required");
    const nativeId = Array.isArray(req.params.nativeId) ? req.params.nativeId[0] : req.params.nativeId;
    if (nativeId.length < 1 || nativeId.length > 512) throw new ChatError(400, "invalid_target", "This is not a signed-in native session");
    const harnessId = typeof req.params.harnessId === "string" ? req.params.harnessId : "";
    const adapter = registry.get(harnessId);
    if (!adapter) throw new ChatError(404, "unknown_harness", "The selected harness is not available");
    const workspace = await workspaces.get(source.workspaceId);
    const chat = manager.peek(`${harnessId}:${nativeId}`) ?? manager.list().find((candidate) => candidate.harnessId === harnessId && candidate.nativeId === nativeId) ?? await manager.resume(adapter, workspace, nativeId);
    if (chat.owner || chat.side) throw new ChatError(403, "board_owned", "Board or side chats cannot be shared externally");
    const out = await guests.create({ harnessId, nativeId, workspace, title: chat.title });
    res.json({ guest: out.record, url: `/guest/${out.token}` });
  });
  app.post("/api/guests/redeem", express.json({ limit: "8kb" }), async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const activeCookie = security.guestBrowserKey(req, res.locals.authority as string) ?? undefined;
    const active = await guests.redeem(token, activeCookie ?? undefined);
    const sessionKey = active.browserKey;
    res.setHeader("Set-Cookie", security.issueGuestCookie(res.locals.authority as string, res.locals.hostKind === "remote", sessionKey));
    res.json({ guest: active.view });
  });
  app.get("/api/guest", async (req, res) => {
    const id = security.guestBrowserKey(req, res.locals.authority as string);
    if (!id) throw new ChatError(401, "guest_required", "No active guest session admitted");
    const guest = await guests.session(id);
    res.json(guest);
  });
  app.get("/api/guest/history", async (req, res) => {
    const id = security.guestBrowserKey(req, res.locals.authority as string);
    if (!id) throw new ChatError(401, "guest_required", "No active guest session admitted");
    const guest = await guests.session(id);
    const info = await guests.target(guest.id);
    const adapter = registry.get(info.harnessId);
    if (!adapter) throw new ChatError(404, "unknown_harness", "No such harness");
    const workspace = await workspaces.get(info.workspace.id);
    const live = manager.liveChatFor(info.harnessId, info.nativeId);
    // A poll never starts a harness. A session handed to a terminal CLI has no live chat
    // here, and resuming it would be the second writer the handover lock forbids; the
    // stored transcript is all a text-only projection needs.
    const transcript = !live && adapter.readTranscript ? await adapter.readTranscript({ cwd: workspace.path, nativeId: info.nativeId }).catch(() => null) : null;
    const items = live ? live.snapshot().items : transcript?.items ?? [];
    res.json({ title: info.title, harnessId: info.harnessId, workspaceName: info.workspace.name, history: GuestStore.history(items), expiresAt: guest.expiresAt });
  });
  app.post("/api/guest/messages", express.json({ limit: "16kb" }), async (req, res) => {
    const id = security.guestBrowserKey(req, res.locals.authority as string);
    if (!id) throw new ChatError(401, "guest_required", "No active guest session admitted");
    if (typeof req.body?.text !== "string" || typeof req.body.requestId !== "string") throw new ChatError(400, "invalid_request", "Guest needs bounded text and a retry id");
    await guests.offer(id, req.body.requestId, req.body.text);
    res.status(202).json({ accepted: "owner_review" });
  });
  app.post("/api/guests/:id/messages/:messageId/send", requireGrant("chat.write"), async (req, res) => {
    const text = await guests.claim(req.params.id, req.params.messageId);
    if (text === null) throw new ChatError(404, "guest_message_missing", "No queued guest message to release");
    const ref = await guests.target(req.params.id);
    await workspaces.get(ref.workspace.id);
    try {
      // A handed-over session is refused inside the resume, and the message goes back to
      // the queue like any other refusal: the owner can release it after reclaiming.
      const chat = await manager.resume(registry.get(ref.harnessId)!, ref.workspace, ref.nativeId);
      await chat.send(text, "normal", [], { origin: "guest" });
      await guests.markSent(req.params.id, req.params.messageId);
      res.json({ ok: true });
    } catch (error) {
      await guests.requeue(req.params.id, req.params.messageId);
      throw error;
    }
  });
  app.post("/api/guests/:id/messages/:messageId/dismiss", requireGrant("chat.write"), async (req, res) => {
    const result = await guests.dismiss(req.params.id, req.params.messageId);
    if (!result) throw new ChatError(404, "guest_message_missing", "No queued guest message to dismiss");
    res.json({ ok: true });
  });
  app.delete("/api/guests/:id", requireGrant("chat.write"), async (req, res) => {
    if (!(await guests.revoke(req.params.id))) throw new ChatError(404, "guest_not_found", "No active guest invitation is available to revoke");
    res.json({ ok: true });
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

  // A retried request whose answer was lost (a phone on a train) must not run twice: an
  // `Idempotency-Key` on a mutating call replays the first answer (idempotency.ts). It comes
  // after the body parsers, since the body it hashes is the parsed one, and it belongs to the
  // device whose session sent the key rather than to the whole server.
  app.use("/api", idempotency.handle);

  const browserSettings = () => uiSettings(userConfig());

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
      grants: await grantsOf(req, res),
      harnesses: registry.status(),
      roots: workspaces.rootList,
      home: deps.home,
      theme: { active: t.name ?? "built-in", ...(t.problem ? { problem: t.problem } : {}) },
      ui: browserSettings(),
      breakdown: breakdownRules(userConfig()),
      agentProfiles: agentProfiles(userConfig()),
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
  /**
   * Plain reads are open to a signed-in device elsewhere; changing this machine's git
   * checkout — staging, committing, pushing, merging a stack, checking out a PR, or
   * applying a reviewed worker into the lead checkout — is not. Tailscale Serve arrives
   * via loopback but is still a remote device, so it needs the machine itself too.
   */
  const requireThisMachine = (req: Request, res: Response): void => {
    if (!requester(req, res).local || res.locals.hostKind === "remote" || req.headers["tailscale-user-login"]) throw new ChatError(403, "local_only", "Changing this machine's git checkout or pull requests needs the machine itself");
  };
  app.get("/api/settings", requireGrant("settings.manage"), (_req, res) => {
    res.json(readSettings(settingsCtx(), true));
  });
  app.put("/api/settings", requireGrant("settings.manage"), (req, res) => {
    const ctx = settingsCtx();
    res.json(writeSettings(ctx, body(settingsPatchSchema, req), requester(req, res)));
  });

  // The awui harness's own providers (its isolated agent dir's models.json).
  // Server-side only edits; an apiKey is never returned (redacted to a flag).
  app.get("/api/awui/settings", requireGrant("settings.manage"), async (_req, res) => {
    res.json(await readAwuiConfig(registry));
  });
  app.put("/api/awui/settings", requireGrant("settings.manage"), async (req, res) => {
    res.json(await writeAwuiConfig(registry, req.body));
  });
  // The Settings dialog's Test for a saved ACP agent: one `initialize` handshake, no
  // model call, no session. Its stored environment is used server-side only.
  app.post("/api/settings/acp/test", requireGrant("settings.manage"), async (req, res) => {
    const ctx = settingsCtx();
    const { id } = body(acpTestSchema, req);
    const agent = savedAcpAgent(ctx, id);
    if (!agent) throw new ChatError(404, "unknown_acp_agent", `config.yml has no ACP agent "${id}"`);
    const adapter = new AcpAdapter(agent, { home: ctx.home, stateDir: deps.stateDir ?? ctx.home });
    try {
      const { probe, warnings } = await adapter.probeAgent(ctx.home);
      // What it advertises, in awui's words: no path, no token, no stderr.
      res.json({
        agentName: probe.agentName,
        version: probe.version,
        resume: probe.loadSession || probe.resumeSession,
        replay: probe.loadSession,
        images: probe.image,
        mcpHttp: probe.mcpHttp,
        authMethods: probe.authMethods,
        warnings,
      } satisfies AcpAgentProbe);
    } catch (error) {
      // The reason is the agent's own words or how its child ended: probeAgent never repeats a stderr
      // tail, and shutdown is not called here — that would stop the live chats of the agent it tested.
      throw new ChatError(502, "acp_handshake_failed", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/settings/restart", requireGrant("settings.manage"), (_req, res) => {
    const ctx = settingsCtx();
    if (!ctx.canRestart) throw new ChatError(409, "no_supervisor", "Nothing would start the server again: restart it yourself");
    res.status(202).json({ restarting: true });
    // The same graceful stop as a SIGTERM from systemd, which then starts it again (Restart=always).
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);
  });

  // ---- Limited-session invitations (grants.ts): who may hold one, and what it allows ----
  // Managing them needs settings.manage: a limited session must not mint itself a wider
  // invitation, and existing full password accounts keep managing them as they always did.
  // The list answers no secrets: a name, its grants, and the id a signed-in client sends
  // with the invitation's own secret. The secret comes back once, at creation, and is
  // never readable again.
  app.get("/api/invites", requireGrant("settings.manage"), (req, res) => {
    res.json({ invites: invites.list(), all: [...GRANTS] });
  });
  app.post("/api/invites", requireGrant("settings.manage"), async (req, res) => {
    const input = body(inviteCreateSchema, req);
    const made = await invites.create(input.name, input.grants);
    res.status(201).json({ invite: made.invite, secret: made.secret, url: `/login?invite=${encodeURIComponent(made.invite.id)}&key=${encodeURIComponent(made.secret)}` });
  });
  app.patch("/api/invites/:id", requireGrant("settings.manage"), (req, res) => {
    const input = body(invitePatchSchema, req);
    const invite = invites.update(req.params.id, input.name ?? null, input.grants ?? null);
    if (!invite) throw new ChatError(404, "no_invite", "No such invitation");
    res.json({ invite });
  });
  app.delete("/api/invites/:id", requireGrant("settings.manage"), async (req, res) => {
    // Revocation is immediate: the next request whose cookie names this invitation
    // resolves to an empty allow list and is refused with 403 `missing_grant` — never
    // a silent fall back to full access. The holder signs in again only with the secret
    // it was created with, which a revoked invitation no longer has.
    if (!(await invites.remove(req.params.id))) throw new ChatError(404, "no_invite", "No such invitation");
    res.json({ ok: true });
  });

  app.get("/api/theme", async (_req, res) => {
    res.json(await theme.get());
  });

  app.get("/api/workspaces/browse", requireGrant("workspaces.manage"), async (req, res) => {
    const p = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json(await workspaces.browse(p));
  });

  app.post("/api/workspaces/open", requireGrant("workspaces.manage"), async (req, res) => {
    const { path: p } = body(openWorkspaceSchema, req);
    res.json(await workspaces.open(p));
  });

  // Approve a project's .envrc (direnv allow): the composer/start screen offer this when the
  // workspace's tree has a blocked one. Goes to someone signed in from anywhere — it writes to
  // the user's direnv state (~/.local/share/direnv/allow), the same consent `direnv allow` asks
  // for in a terminal, and the user just read what they are allowing in the prompt's file link.
  app.post("/api/workspaces/:id/direnv-allow", requireGrant("workspaces.manage"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    if (!direnvState(ws.path).blocked) throw new ChatError(409, "not_blocked", "No blocked .envrc here");
    if (!allowEnvrc(ws.path)) throw new ChatError(500, "direnv_failed", "direnv allow did not run");
    res.json(await workspaces.get(ws.id));
  });

  // A project's files for a client's @mention picker, relative to the project.
  // Read-only and confined to an opened workspace (by id, never a path).
  app.get("/api/workspaces/:id/files", requireGrant("chat.read"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { q } = fileSearchSchema.parse(req.query);
    res.json({ files: searchFiles(await projectFiles(ws.path), q) });
  });

  // A file dropped into the project: new files only, one name, bounded by the body.
  app.post("/api/workspaces/:id/upload", requireGrant("chat.write"), express.raw({ type: () => true, limit: "8mb" }), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { name } = fileUploadSchema.parse(req.query);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (bytes.length === 0) throw new ChatError(400, "empty_file", "That file is empty");
    res.status(201).json(await writeProjectFile(ws.path, name, bytes));
  });

  // The trusted terminal renderer is deliberately its own document. xterm writes
  // inline grid styles, which cannot satisfy the main page's nonce-free 'self' style.
  // Keep it away from agent output; production never adds unsafe-inline to the app.
  app.get("/terminal-shell.html", (_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; sandbox allow-scripts allow-same-origin");
    next();
  });

  // Workspace tools: every operation goes through Workspaces.get(), which
  // revalidates a project that may have been renamed or replaced by a symlink.
  const trees = new ManagedWorktrees();

  // Stacked pull requests (stacks.ts): the ordered stack per project, kept in the
  // state folder so a stack outlives its open panels. Without state wiring the
  // store is in memory, like the races store beside it.
  const prStacks = deps.prStacks ?? PrStacks.inMemory(workspaces);

  // A project's own `awui.yml` (project-config.ts) is untrusted input from the repository: its
  // hash is recorded here only when a person trusts that exact version, and its setup command
  // runs only on an explicit request after that. Reading it names no paths.
  app.get("/api/workspaces/:id/project-config", requireGrant("chat.read"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    res.json({ config: await projectConfigStatus(ws.path, projectTrust) });
  });
  // A project's prompt skills (awui.yml `skills:`): text only, served only once this exact
  // file version is trusted — an untrusted file's prompts are never shown as runnable.
  app.get("/api/workspaces/:id/project-skills", requireGrant("chat.read"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const read = await readProjectConfig(ws.path);
    if (!read) throw new ChatError(404, "no_config", `This project has no ${PROJECT_CONFIG_FILE}`);
    if (read.problem) throw new ChatError(422, "config_invalid", read.problem);
    if (!projectTrust.isTrusted(ws.path, read.hash)) throw new ChatError(409, "config_untrusted", `This version of ${PROJECT_CONFIG_FILE} has not been trusted yet`);
    const skills = read.config.skills ?? {};
    res.json({ hash: read.hash, skills });
  });
  app.post("/api/workspaces/:id/project-config/trust", requireGrant("workspaces.manage"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { hash } = body(projectConfigTrustSchema, req);
    const read = await readProjectConfig(ws.path);
    if (!read) throw new ChatError(404, "no_config", `This project has no ${PROJECT_CONFIG_FILE}`);
    if (read.hash !== hash) throw new ChatError(409, "config_changed", "That file changed since it was shown; read it again before trusting it");
    if (read.problem) throw new ChatError(422, "bad_config", read.problem);
    await projectTrust.trust(ws.path, hash);
    res.json({ trusted: true, hash });
  });

  /** The one setup command a trusted `awui.yml` names, run in one of this project's own worktrees. */
  const runSetup = async (ws: WorkspaceInfo, treeId: string): Promise<RunResult> => {
    const read = await readProjectConfig(ws.path);
    if (read?.problem) throw new ChatError(422, "bad_config", read.problem);
    if (!read?.config.setup) throw new ChatError(404, "no_setup", `This project's ${PROJECT_CONFIG_FILE} has no setup command`);
    if (!projectTrust.isTrusted(ws.path, read.hash)) throw new ChatError(409, "untrusted", `Trust this ${PROJECT_CONFIG_FILE} before running its setup command`);
    // The tree comes from the project's own records, never from a path the client sends.
    const tree = (await trees.list(ws)).find((t) => t.id === treeId);
    if (!tree) throw new ChatError(404, "unknown_id", "That managed worktree is not in this project");
    return runShellCommand(read.config.setup, tree.path, { timeoutMs: SETUP_TIMEOUT_MS, maxOutput: SETUP_MAX_OUTPUT });
  };

  app.get("/api/workspaces/:id/worktrees", requireGrant("chat.read"), async (req, res) => {
    res.json({ worktrees: await trees.list(await workspaces.get(req.params.id)) });
  });
  app.post("/api/workspaces/:id/worktrees", requireGrant("workspaces.manage"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const input = body(worktreeCreateSchema, req);
    // The config's shared entries seed the tree; its setup command needs both the trust and
    // this request's own consent, checked before anything is created.
    const read = await readProjectConfig(ws.path);
    const config = read && !read.problem ? read.config : {};
    if (input.setup === true && (!read?.config.setup || read.problem || !projectTrust.isTrusted(ws.path, read.hash))) {
      throw new ChatError(409, "untrusted", `Trust this ${PROJECT_CONFIG_FILE} before running its setup command`);
    }
    try {
      const info = await trees.create(ws, input.name, input.base, { shared: config.shared ?? [] });
      const setup = input.setup === true ? await runSetup(ws, info.id) : undefined;
      res.status(201).json({ ...info, workspace: await workspaces.open(info.path), ...(setup ? { setup } : {}) });
    } catch (error) {
      throw worktreeProblem(error) ?? error;
    }
  });
  app.post("/api/workspaces/:id/worktrees/:treeId/setup", requireGrant("workspaces.manage"), async (req, res) => {
    res.json(await runSetup(await workspaces.get(req.params.id), req.params.treeId));
  });
  app.delete("/api/workspaces/:id/worktrees/:treeId", requireGrant("workspaces.manage"), async (req, res) => {
    await trees.prune(await workspaces.get(req.params.id), req.params.treeId).catch((error: unknown) => {
      throw worktreeProblem(error) ?? error;
    });
    res.json({ ok: true });
  });

  // A managed isolated checkout of an existing pull request (a checkout-pr tree):
  // the head branch is looked up server-side with gh, so the client names only the
  // number and a task name, and the tree runs through the ordinary workspace flow.
  app.post("/api/workspaces/:id/worktrees/checkout-pr", requireGrant("workspaces.manage"), async (req, res) => {
    requireThisMachine(req, res);
    const ws = await workspaces.get(req.params.id);
    const input = body(prCheckoutSchema, req);
    const read = await readProjectConfig(ws.path);
    const config = read && !read.problem ? read.config : {};
    const detail = await pullRequestDetail(ws, input.pr);
    if (!detail) throw new ChatError(404, "bad_pr", `GitHub has no pull request #${input.pr} in this repository`);
    try {
      const info = await trees.checkoutPr(ws, input.name, input.pr, detail.headRefOid, { shared: config.shared ?? [] });
      res.status(201).json({ ...info, workspace: await workspaces.open(info.path) });
    } catch (error) {
      throw worktreeProblem(error) ?? error;
    }
  });

  // Archive one checkout-pr tree whose pull request merged: the worktree refuses a
  // dirty or moved-off tree itself, and the refusal is the actionable error.
  app.post("/api/workspaces/:id/worktrees/:treeId/archive", requireGrant("workspaces.manage"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const detail = await pullRequestDetail(ws, Number(req.query.pr ?? NaN));
    if (!detail) throw new ChatError(404, "bad_pr", `GitHub has no pull request like that in this repository`);
    if (detail.state !== "MERGED") throw new ChatError(409, "not_merged", `#${req.query.pr ?? ""} is ${detail.state}, not MERGED; archive only runs on a merged pull request`);
    await trees.archiveMerged(ws, req.params.treeId, Number(req.query.pr)).catch((error: unknown) => {
      throw worktreeProblem(error) ?? error;
    });
    res.json({ ok: true });
  });

  // Stacked pull requests (stacks.ts): one ordered stack per project, per-layer
  // status from the same bounded gh calls the panel reads, merges bottom-up.
  app.get("/api/workspaces/:id/pr-stack", requireGrant("chat.read"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const stacks = prStacks.list(ws.id);
    res.json({ stacks: await Promise.all(stacks.map((stack) => prStacks.view(stack))) });
  });
  app.post("/api/workspaces/:id/pr-stack", requireGrant("workspaces.manage"), async (req, res) => {
    // A stack layer may push its branch and open a pull request: not a remote device's call.
    requireThisMachine(req, res);
    const ws = await workspaces.get(req.params.id);
    const input = body(prStackCreateSchema, req);
    const stack = prStacks.list(ws.id)[0] ?? (await prStacks.create(ws.id, ws.name, input.base ?? "main"));
    const result = input.above !== undefined
      ? await prStacks.stackAbove(stack.id, input.above, input.title, input.body, input.push)
      : await prStacks.start(stack.id, input.base ?? "main", input.title, input.body, input.push);
    res.status(201).json({ stack: await prStacks.view(result.stack), layer: result.layer });
  });
  app.post("/api/workspaces/:id/pr-stack/:stackId/merge", requireGrant("workspaces.manage"), async (req, res) => {
    requireThisMachine(req, res);
    const ws = await workspaces.get(req.params.id);
    const input = body(prStackMergeSchema, req);
    prStacks.required(req.params.stackId);
    const result = await prStacks.merge(req.params.stackId, input.archive
      ? async (treeWs, pr, worktreeId) => {
          if (!worktreeId) return;
          await trees.archiveMerged(treeWs, worktreeId, pr);
        }
      : undefined);
    res.json({ stack: await prStacks.view(result.stack), mergedThrough: result.mergedThrough ?? null, refusal: result.refusal ?? null, archiveRefusals: result.archiveRefusals });
  });
  app.delete("/api/workspaces/:id/pr-stack/:stackId", requireGrant("workspaces.manage"), async (req, res) => {
    await workspaces.get(req.params.id);
    prStacks.required(req.params.stackId);
    await prStacks.forget(req.params.stackId);
    res.json({ ok: true });
  });

  // Races (races.ts): the group a comparison starts, what git says about each member,
  // and the two things it may do — copy the winner's changes in, or remove a loser
  // git agrees to drop. Every route re-validates the project through workspaces.get().
  const raceOf = (id: string): RaceRecord => {
    const race = races.get(id);
    if (!race) throw new ChatError(404, "no_race", "No such comparison; it may have been pruned");
    return race;
  };
  const raceProject = async (race: RaceRecord) => {
    const ws = await workspaces.get(race.workspaceId);
    return { root: ws.path, ws, trees };
  };
  app.get("/api/races", requireGrant("chat.read"), async (_req, res) => {
    // The record and each member's live status: no git per row, so fifty of them stay one cheap call.
    res.json({ races: await Promise.all(races.list().map((race) => races.view(race))) });
  });
  app.get("/api/races/:id", requireGrant("chat.read"), async (req, res) => {
    const race = raceOf(req.params.id);
    // A project that was closed or moved is not this race's to read: the record's bare view still answers.
    const project = await workspaces.get(race.workspaceId).then((ws) => ({ root: ws.path, ws, trees })).catch(() => undefined);
    res.json(await races.view(race, project));
  });
  app.get("/api/races/:id/members/:chatId/diff", requireGrant("chat.read"), async (req, res) => {
    const race = raceOf(req.params.id);
    const { path: file } = raceDiffQuery.parse(req.query);
    // The project is revalidated here too, so a member's tree must still sit inside it.
    res.json(await races.diff(race, req.params.chatId, file, await raceProject(race)));
  });
  app.post("/api/races/:id/winner", requireGrant("chat.write"), async (req, res) => {
    const input = body(raceWinnerSchema, req);
    // Only `apply` writes: it puts the winner's changes into the checkout, so it is the
    // git panel's write class, not a remote device's call.
    if (input.mode === "apply") requireThisMachine(req, res);
    const race = raceOf(req.params.id);
    res.json(await races.pickWinner(race, input.chatId, input.mode, await raceProject(race)));
  });
  app.post("/api/races/:id/cleanup", requireGrant("chat.write"), async (req, res) => {
    const race = raceOf(req.params.id);
    const input = body(raceCleanupSchema, req);
    res.json(await races.cleanup(race, input.discard, await raceProject(race)));
  });

  // Backend previews are requested by a signed-in contributor of an owning chat.
  // No free-form URL is accepted and external network is blocked in the renderer.
  app.post("/api/chats/:id/html-render/:renderId/preview", requireGrant("chat.read"), async (req, res) => {
    if (!deps.stateDir) throw new ChatError(404, "render_off", "HTML preview is not wired on this server");
    const chat = manager.get(req.params.id);
    const id = req.params.renderId;
    if (!isHtmlRenderId(id) || !chat.ownsHtmlRender(id)) throw new ChatError(404, "render_missing", "That page is not in this chat");
    const html = await readHtmlRender(deps.stateDir, id);
    if (!html) throw new ChatError(404, "render_missing", "That page is no longer in the render store");
    const theme = body(htmlRenderPreviewSchema, req);
    const preview = await previewHtmlRender(html, theme.theme, theme.appearance).catch((error: unknown) => {
      if (error instanceof PreviewError) throw new ChatError(error.code === "browser_missing" ? 503 : 422, error.code, error.message);
      throw error;
    });
    const stored = rememberImage("image/png", preview.image.toString("base64"));
    if (!stored) throw new ChatError(422, "preview_failed", "The browser produced no image for this page");
    res.json({ id: stored.id, url: `/api/images/${stored.id}`, console: preview.console, width: preview.width, height: preview.height });
  });

  // A signed-in project's interactive terminal. The input route has no command
  // parameter at all: a PTY is not a shell-exec API, and every create spawns the
  // user's own interactive shell in their validated project.
  app.post("/api/workspaces/:id/terminal", requireGrant("workspaces.manage"), async (req, res) => {
    if (!deps.terminals) throw new ChatError(404, "terminal_off", "The interactive terminal is not wired on this server");
    const ws = await workspaces.get(req.params.id);
    const input = body(terminalCreateSchema, req);
    const session = await deps.terminals.create(ws, input.cols, input.rows);
    res.status(201).json(session);
  });
  for (const action of ["write", "resize"] as const) {
    app.post(`/api/workspaces/:id/terminal/:termId/${action}`, requireGrant("workspaces.manage"), async (req, res) => {
      if (!deps.terminals) throw new ChatError(404, "terminal_off", "The interactive terminal is not wired");
      const ws = await workspaces.get(req.params.id);
      if (action === "write") {
        const input = body(terminalWriteSchema, req);
        deps.terminals.write(ws, req.params.termId, input.data);
      } else {
        const input = body(terminalCreateSchema, req);
        deps.terminals.resize(ws, req.params.termId, input.cols, input.rows);
      }
      res.json({ ok: true });
    });
  }
  app.get("/api/workspaces/:id/terminal/:termId/events", requireGrant("workspaces.manage"), async (req, res) => {
    const terminals = deps.terminals;
    if (!terminals) throw new ChatError(404, "terminal_off", "The interactive terminal is not wired");
    let closed = false;
    res.on("close", () => void (closed = true));
    const ws = await workspaces.get(req.params.id);
    if (closed) return;
    // Headers go out with the first frame, not before: an unknown or evicted terminal
    // must answer a plain 404 (EventSource then stops), not an empty stream it retries forever.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 2000\n\n");
    };
    let heartbeat: NodeJS.Timeout | undefined;
    const unsubscribe = terminals.subscribe(ws, req.params.termId, {
      onOutput: (text) => {
        if (closed) return;
        start();
        res.write(`event: terminal\ndata: ${JSON.stringify({ text })}\n\n`);
      },
      onExit: (code, signal) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        start();
        res.write(`event: exit\ndata: ${JSON.stringify({ code, signal })}\n\n`);
        res.end();
      },
    });
    const stop = () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    if (closed) {
      stop();
      return;
    }
    start();
    heartbeat = setInterval(() => { if (!closed) res.write("event: heartbeat\ndata: {}\n\n"); }, deps.heartbeatMs ?? 20_000);
    res.on("close", stop);
  });
  app.delete("/api/workspaces/:id/terminal/:termId", requireGrant("workspaces.manage"), async (req, res) => {
    if (!deps.terminals) throw new ChatError(404, "terminal_off", "The interactive terminal is not wired");
    deps.terminals.close(await workspaces.get(req.params.id), req.params.termId);
    res.json({ ok: true });
  });

  // GitHub status plus an opt-in PR activity surface: a chat is an owner, not arbitrary object returned by another session.
  const prWatches = await prWatchesPromise;
  app.locals.prWatchStore = prWatches;
  app.get("/api/chats/:id/pr-watches", requireGrant("chat.read"), (req, res) => {
    const chat = manager.get(req.params.id);
    const nativeId = chat.sessionId;
    res.json({ watches: nativeId ? prWatches.list(nativeId) : [] });
  });
  app.post("/api/chats/:id/pr-watch", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    const input = body(prWatchSchema, req);
    const snapshot = await readPrSnapshot(chat.workspace, input.url);
    const watch = await prWatches.add(chat, snapshot);
    res.status(201).json({ watch });
  });
  app.delete("/api/chats/:id/pr-watch", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    if (!chat.sessionId) throw new ChatError(404, "no_watch", "This chat has no session bound to a watch");
    const { url } = body(prUnwatchSchema, req);
    res.json({ removed: await prWatches.remove(chat.sessionId, url) });
  });


  // A failing CI run offers an explicit bounded repair conversation. The full log lives in
  // the harness session (not the wire) and the chat is marked as repair work, not an ordinary user message.
  app.post("/api/workspaces/:id/pr-repair", requireGrant("chat.write"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const input = body(prRepairSchema, req);
    const snapshot = await readPrSnapshot(ws, input.url);
    const failed = snapshot.checks.filter((check) => /fail|error|cancel|timeout/i.test(check.state));
    if (failed.length === 0) throw new ChatError(409, "no_repair", "This PR has no reported failing checks right now");
    if (!input.harnessId) throw new ChatError(400, "unsupported", "A repair chat must name its owning chat's harness");
    const harness = await availableAdapter(input.harnessId);
    const chat = await manager.create(harness, ws);
    const logs: string[] = [];
    for (const check of failed) {
      const runId = snapshot.failingRuns.find((run) => run.name === check.name)?.runId ?? null;
      if (runId !== null) {
        const log = await runGh(["run", "view", runId, "--log-failed"], ws.path);
        logs.push(`${check.name}\n${clipRepairLog(log)}`);
      }
    }
    const prompt = repairPrompt(snapshot.title, snapshot.url, failed, logs.length > 0 ? logs.join("\n\n") : (snapshot.reviewExcerpts.length > 0 ? snapshot.reviewExcerpts.join("\n") : "No log was available for these failing checks."));
    await chat.send(prompt, "normal", [], { origin: "agent" });
    if (snapshot.failingRuns.length > 0) await prWatches.recordRepair(chat.sessionId as string, chat.chatId, snapshot.url);
    res.status(201).json({ chat: chat.snapshot() });
  });

  app.get("/api/workspaces/:id/github", requireGrant("chat.read"), async (req, res) => {
    res.json(await githubStatus(await workspaces.get(req.params.id)));
  });

  app.post("/api/workspaces/:id/github/push", requireGrant("chat.write"), async (req, res) => {
    requireThisMachine(req, res);
    res.json(await pushBranch(await workspaces.get(req.params.id)));
  });
  app.post("/api/workspaces/:id/github/pr", requireGrant("chat.write"), async (req, res) => {
    requireThisMachine(req, res);
    const ws = await workspaces.get(req.params.id);
    const input = body(gitHubPrSchema, req);
    res.status(201).json(await createPullRequest(ws, input.base, input.title, input.body));
  });
  app.get("/api/workspaces/:id/github", requireGrant("chat.read"), async (req, res) => {
    res.json(await githubStatus(await workspaces.get(req.params.id)));
  });
  app.get("/api/workspaces/:id/pr-tour", requireGrant("chat.read"), async (req, res) => {
    const input = prTourRequestSchema.parse(req.query);
    res.json(await readTour(await workspaces.get(req.params.id), input.pr, input.regenerate));
  });

  app.get("/api/workspaces/:id/github/pr", requireGrant("chat.read"), async (req, res) => {
    res.json({ pr: await currentPullRequest(await workspaces.get(req.params.id)) });
  });
  app.get("/api/workspaces/:id/github/checks", requireGrant("chat.read"), async (req, res) => {
    res.json({ checks: await pullRequestChecks(await workspaces.get(req.params.id)) });
  });

  app.post("/api/compare", requireGrant("chat.write"), async (req, res) => {
    const input = body(compareStartSchema, req);
    const parent = await workspaces.get(input.workspaceId);
    const availableChoices = input.choices.filter((choice) => registry.isAvailable(choice.harnessId));
    if (availableChoices.length !== input.choices.length) throw new ChatError(422, "harness_unavailable", "Every chosen harness must be available before a comparison starts");
    // Everything that can be checked up front is, so a bad request starts nothing.
    // Past that, a partial fan-out is a useful result: each failure is reported
    // beside the chats that did start, never as a 500 that orphans them.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.name)) throw new ChatError(400, "bad_name", "The task prefix takes lowercase letters, digits, and hyphens");
    const harnessIds = input.choices.map((choice) => choice.harnessId);
    if (new Set(harnessIds).size !== harnessIds.length) throw new ChatError(400, "duplicate_harness", "Each harness can run once in a comparison");
    const planned = input.choices.map((choice) => {
      const adapter = registry.get(choice.harnessId);
      if (!adapter) throw new ChatError(404, "unknown_harness", "Unknown harness");
      const suffix = choice.harnessId.replace(/[^a-z0-9-]/g, "-");
      return { choice, adapter, slug: `${input.name.slice(0, Math.max(1, 63 - suffix.length))}-${suffix}`.slice(0, 64) };
    });
    const results: Array<{ harnessId: string; tree: WorktreeInfo | null; workspace: WorkspaceInfo | null; chat?: Chat; error?: string }> = [];
    /** The started members, in the order they started: what the comparison's record keeps. */
    const members: RaceRecord["members"] = [];
    for (const { choice, adapter, slug } of planned) {
      let tree: WorktreeInfo | null = null;
      let ws: WorkspaceInfo | null = null;
      try {
        tree = await trees.create(parent, slug, input.base).catch((error: unknown) => {
          throw worktreeProblem(error) ?? error;
        });
        // The fork point is the base as a commit, resolved in the project: the ref every
        // member of one comparison shares, so counts and an apply have one exact point.
        const fork = await git(["rev-parse", "--verify", "--end-of-options", `${tree.base}^{commit}`], { cwd: parent.path }).then((sha) => sha.trim()).catch(() => "");
        ws = await workspaces.open(tree.path);
        const chat = await manager.create(adapter, ws);
        if (choice.model) await chat.setConfig({ model: choice.model });
        await chat.send(input.prompt, "normal");
        results.push({ harnessId: choice.harnessId, tree, workspace: ws, chat });
        members.push({ chatId: chat.chatId, worktreeId: tree.id, worktree: path.basename(tree.path), path: tree.path, branch: tree.branch, harnessId: choice.harnessId, startedAt: Date.now(), ...(choice.model ? { model: choice.model } : {}), fork });
      } catch (error) {
        results.push({ harnessId: choice.harnessId, tree, workspace: ws, error: errorMessage(error) });
      }
    }
    // The record is best-effort: the started chats are the answer, so a state-folder
    // failure must not turn a useful fan-out into an error that orphans them.
    const raceId = members.length > 0
      ? await races.create({ workspaceId: parent.id, workspacePath: parent.path, workspaceName: parent.name, prompt: input.prompt, base: input.base, members }).then((race) => race.id).catch((error: unknown) => {
          log(`race: could not record the comparison: ${errorMessage(error)}`);
          return null;
        })
      : null;
    res.status(201).json({ raceId, results: results.map(({ harnessId, tree, workspace, chat, error }) => ({ harnessId, tree, workspace, snapshot: chat?.snapshot() ?? null, error })) });
  });

  // Usage across sessions (usage-report.ts): the sidebar's sessions' calls, read from the harnesses' files.
  app.get("/api/usage", requireGrant("chat.read"), async (req, res) => {
    const { days, tz, refresh } = usageReportSchema.parse(req.query);
    const overview = await listSessions(null, true);
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
    res.json(await usageReader.report(targets, { days, tz, workspaces: overview.workspaces, unreadable: [...unreadable], refresh: refresh === "1" }));
  });

  // Saved prompts (saved-prompts.ts): every device and atui share them.
  app.get("/api/prompts", requireGrant("chat.read"), (_req, res) => {
    res.json({ prompts: prompts.list() });
  });
  app.post("/api/prompts", requireGrant("chat.write"), async (req, res) => {
    res.json(await prompts.save(body(savedPromptSchema, req)));
  });
  app.delete("/api/prompts/:id", requireGrant("chat.write"), async (req, res) => {
    await prompts.remove(req.params.id);
    res.json({ ok: true });
  });

  // The file viewer: one of the project's own files, read-only and bounded (file-view.ts).
  // An image's bytes for the viewer's preview: same confinement as the text view,
  // typed by magic bytes, with nosniff so the browser takes the type we send.
  app.get("/api/workspaces/:id/media", requireGrant("chat.read"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { path: wanted } = fileViewSchema.parse(req.query);
    const { bytes, mimeType } = await readMedia(ws.path, wanted);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(bytes);
  });
  app.get("/api/workspaces/:id/file", requireGrant("chat.read"), async (req, res) => {
    const ws = await workspaces.get(req.params.id);
    const { path: wanted } = fileViewSchema.parse(req.query);
    res.json(await viewFile(ws.path, wanted));
  });

  // Search in project: lines holding a fixed string (never a pattern), bounded
  // (project-search.ts). Only inside an opened workspace, as the file list is.
  app.get("/api/workspaces/:id/search", requireGrant("chat.read"), async (req, res) => {
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
  app.get("/api/harnesses/:id/status", requireGrant("chat.read"), async (req, res) => {
    const adapter = adapterOr404(req.params.id);
    const status = await registry.recheck(adapter.id);
    if (!status) throw new ChatError(404, "unknown_harness", "Unknown harness");
    res.json(status);
  });

  app.get("/api/harnesses/:id/sessions", requireGrant("chat.read"), async (req, res) => {
    const adapter = await availableAdapter(req.params.id);
    const ws = await workspaces.get(String(req.query.workspaceId ?? ""));
    const problem = adapter.workspaceProblem(ws.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    // Rooms' and side threads' sessions are theirs: neither belongs in a picker of ordinary chats.
    const native = (await adapter.listSessions(ws.path)).filter((s) => !deps.boards?.ownsNativeSession(adapter.id, s.nativeId) && !manager.liveChatFor(adapter.id, s.nativeId)?.side && !routineSession(adapter.id, s.nativeId));
    const seen = new Set<string>();
    const sessions: SessionSummary[] = native.map((s) => {
      seen.add(s.nativeId);
      // No workspaceId: this route is already project-scoped.
      return toSession(adapter, s, null, manager.liveChatFor(adapter.id, s.nativeId));
    });
    // Live chats whose session the harness has not persisted yet.
    for (const chat of manager.list()) {
      if (chat.owner || chat.side || chat.harnessId !== adapter.id || chat.workspace.id !== ws.id || chat.status === "disposed") continue;
      if (routineRuns.ownsChat(chat.chatId)) continue;
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
  app.get("/api/harnesses/:id/models", requireGrant("chat.read"), async (req, res) => {
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
  app.get("/api/sessions/preview", requireGrant("chat.read"), async (req, res) => {
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
  app.get("/api/sessions/resume-command", requireGrant("chat.read"), async (req, res) => {
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
    const command = shellLine(ws.path, argv);
  // Copy resume command is read-only: only the explicit hand-over action closes a live writer.
    const live = manager.liveChatFor(adapter.id, nativeId) !== undefined;
    const body: ResumeCommand = { command, live, ...(handovers.has(input.sessionId) ? { held: true as const } : {}) };
    res.json(body);
  });

  /** Explicitly hand a session to its native CLI: stop awui's live writer before recording the lock. */
  app.post("/api/sessions/handover", requireGrant("chat.write"), async (req, res) => {
    const input = sessionPreviewSchema.parse(req.body ?? {});
    const adapter = adapterOr404(input.harnessId);
    if (!adapter.capabilities.supportsResumeCommand || !adapter.resumeCommand) throw new ChatError(400, "unsupported", "This harness cannot hand a session to its own CLI");
    const prefix = `${adapter.id}:`;
    if (!input.sessionId.startsWith(prefix)) throw new ChatError(400, "wrong_harness", "Session belongs to another harness");
    const nativeId = input.sessionId.slice(prefix.length);
    const ws = await workspaces.get(input.workspaceId);
    const command = shellLine(ws.path, (await adapter.resumeCommand({ cwd: ws.path, nativeId })) ?? []);
    const live = manager.liveChatFor(adapter.id, nativeId);
    if (live && live.status !== "idle" && live.status !== "error") throw new ChatError(409, "busy", "Stop the run before handing this session to the terminal");
    if (live) await live.dispose("Handed to the harness CLI");
    await handovers.set(input.sessionId, command);
    res.json({ command, live: false });
  });

  // Reclaiming a handed-off session: the lock goes, and the client learns the line
  // the handover held (to paste again, or to see what took the session over). The
  // reclaim is one click and never runs anything.
  app.post("/api/sessions/reclaim", requireGrant("workspaces.manage"), async (req, res) => {
    const input = sessionPreviewSchema.parse(req.body ?? {});
    const adapter = adapterOr404(input.harnessId);
    const prefix = `${adapter.id}:`;
    if (!input.sessionId.startsWith(prefix)) throw new ChatError(400, "wrong_harness", "Session belongs to another harness");
    const live = manager.liveChatFor(adapter.id, input.sessionId.slice(prefix.length)) !== undefined;
    const body: HandoverReclaim = { command: await handovers.take(input.sessionId), live };
    res.json(body);
  });

  // The sidebar's list: each harness's newest sessions across projects, every
  // session of the current project (`?path=`), and live chats not saved yet.
  // Projects outside WORKSPACE_ROOTS, or that a harness cannot open, are left out.
  // `includeRoutine` is for Usage, which counts the tokens a routine's run spent; the
  // sidebar asks without it, because a routine's session is not the user's chat.
  const listSessions = async (path: string | null, includeRoutine = false): Promise<SessionsOverview> => {
    /** A routine's own session: hidden from the user's list, still counted in usage. */
    const routineOwned = (harnessId: string, nativeId: string) => !includeRoutine && routineRuns.ownsSession(`${harnessId}:${nativeId}`);
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
      const live = manager.liveChatFor(adapter.id, s.nativeId);
      // A side thread's session is the harness's, saved like any other; the list leaves it
      // out while this server holds it, the same way a room's sessions never appear here.
      if (live?.side) return;
      projects.set(ws.id, ws);
      sessions.set(id, toSession(adapter, s, ws, live));
    };
    const errors: string[] = [];
    const adapters = registry.list().filter((a) => registry.isAvailable(a.id));
    await Promise.all(
      adapters.map(async (adapter) => {
        try {
          const here = current && !adapter.workspaceProblem(current.path) ? await adapter.listSessions(current.path) : [];
          if (current) for (const s of here) if (!deps.boards?.ownsNativeSession(adapter.id, s.nativeId) && !routineOwned(adapter.id, s.nativeId)) add(adapter, s, current);
          for (const s of await adapter.listRecentSessions(RECENT_SESSIONS_PER_HARNESS)) {
            if (deps.boards?.ownsNativeSession(adapter.id, s.nativeId) || routineOwned(adapter.id, s.nativeId)) continue;
            const ws = await workspaceFor(s.cwd);
            if (ws && !adapter.workspaceProblem(ws.path)) add(adapter, s, ws);
          }
        } catch (error) {
          errors.push(`${adapter.displayName}: ${errorMessage(error)}`);
        }
      }),
    );
    for (const chat of manager.list()) {
      if (chat.owner || chat.side || chat.status === "disposed") continue;
      if (routineRuns.ownsChat(chat.chatId)) continue;
      if (chat.nativeId && routineOwned(chat.harnessId, chat.nativeId)) continue;
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
        ...(chat.lineage ? { lineage: chat.lineage } : {}),
      });
    }
    const inHerdr = deps.herdr ? await deps.herdr.bySession() : null;
    for (const [id, s] of sessions) {
      const mark = marks.get(id);
      const pane = inHerdr?.get(id);
      const handed = handovers.has(id) && s.liveChatId === undefined;
      // A routine's origin is the mark; a delegated child's is in the orchestrator's records,
      // so it survives a reap. Either one is metadata only: the sidebar hides by it.
      const origin = mark?.origin ?? (manager.delegatedSession?.(s.harnessId, s.id.slice(s.harnessId.length + 1)) ? "agent" : undefined);
      // The line its own agent set (the orchestration tool surface's set_status).
      const agentStatus = agentStatuses.get(id);
      if (mark || pane || origin || agentStatus || handed) sessions.set(id, { ...s, ...mark, ...(origin ? { origin } : {}), ...(agentStatus ? { agentStatus } : {}), ...(pane ? { herdr: { paneId: pane.paneId, status: pane.status } } : {}), ...(handed ? { handover: true as const, handoverCommand: handovers.get(id) ?? undefined } : {}) });
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
  app.get("/api/sessions", requireGrant("chat.read"), async (req, res) => {
    res.json(await listSessions(typeof req.query.path === "string" && req.query.path ? req.query.path : null));
  });

  // Only live metadata: titles/status/pending count and the room summary.
  // A replay gap sends one snapshot marker; the client then takes the ordinary
  // full lists. No transcripts or board records are fused into this stream.
  app.get("/api/overview/events", requireGrant("chat.read"), (req, res) => {
    const last = parseLastEventId(req.headers["last-event-id"] ?? req.query.lastEventId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    let closed = false;
    const unsubscribe = overviewEvents.subscribe({
      send: (id, event) => {
        if (!closed) res.write(`id: ${id}\nevent: chat\ndata: ${JSON.stringify(event)}\n\n`);
      },
      close: () => {
        if (!closed) {
          closed = true;
          res.end();
        }
      },
    }, last);
    const heartbeat = setInterval(() => {
      if (!closed) res.write("event: heartbeat\ndata: {}\n\n");
    }, deps.heartbeatMs ?? 20_000);
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Search every chat (chat-search.ts): the sidebar's sessions, newest first,
  // read from the live chat or the harness's own file; never starts a harness.
  app.get("/api/sessions/search", requireGrant("chat.read"), async (req, res) => {
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
  app.get("/api/push/key", requireGrant("chat.read"), (_req, res) => {
    res.json({ key: notifier.applicationServerKey });
  });
  app.post("/api/push/subscribe", requireGrant("chat.write"), async (req, res) => {
    const { endpoint } = body(pushSubscriptionSchema, req);
    const problem = pushEndpointProblem(endpoint);
    if (problem) throw new ChatError(422, "bad_push_endpoint", problem);
    await notifier.subscribe(endpoint);
    res.json({ ok: true });
  });
  app.post("/api/push/unsubscribe", requireGrant("chat.write"), async (req, res) => {
    await notifier.unsubscribe(body(pushSubscriptionSchema, req).endpoint);
    res.json({ ok: true });
  });
  app.post("/api/push/test", requireGrant("chat.write"), (req, res) => {
    const { endpoint } = body(pushTestSchema, req);
    res.json(notifier.notify({ kind: "done", chatId: "", sessionId: null, title: "awui", body: "Notifications work on this device" }, endpoint));
  });
  /** Notes after `since` (epoch ms, as `now` last said); without it, the last two minutes. */
  app.get("/api/notifications", requireGrant("chat.read"), (req, res) => {
    const raw = typeof req.query.since === "string" && /^\d{1,15}$/.test(req.query.since) ? Number(req.query.since) : null;
    const now = Date.now();
    res.json({ notes: notifier.since(raw ?? now - 120_000), now });
  });
  // Presence: which chat or room each connected client visibly focuses, so a note for
  // a target the user already watches is not sent (presence.ts). Ids and flags only.
  app.post("/api/presence", requireGrant("chat.read"), (req, res) => {
    const report = body(presenceSchema, req);
    presence.report(report.clientId, { chatId: report.chatId ?? null, roomId: report.roomId ?? null }, report.visible, report.focused);
    res.json({ ok: true });
  });

  app.get("/api/limits", requireGrant("chat.read"), async (req, res) => {
    res.json(await limits.get(req.query.refresh === "1"));
  });

  app.post("/api/sessions/marks", requireGrant("chat.write"), async (req, res) => {
    const { sessionId, ...change } = body(sessionMarkSchema, req);
    if (change.snoozedUntil !== undefined && change.snoozedUntil !== null && change.snoozedUntil <= Date.now()) throw new ChatError(400, "bad_snooze", "Snooze until a time to come");
    res.json(await marks.set(sessionId, change));
  });
  /** The same change for several sessions at once: one write, and one undo for the selection. */
  app.post("/api/sessions/marks/bulk", requireGrant("chat.write"), async (req, res) => {
    const { ids, ...change } = body(sessionBulkMarkSchema, req);
    if (change.snoozedUntil !== undefined && change.snoozedUntil !== null && change.snoozedUntil <= Date.now()) throw new ChatError(400, "bad_snooze", "Snooze until a time to come");
    res.json({ marks: await marks.setMany(ids, change) });
  });

  // Routines: a prompt on a cadence, in a project, on a harness. The timer that
  // starts them is index.ts's; these are the dialog's reads and writes.
  app.get("/api/routines", requireGrant("chat.read"), (_req, res) => {
    res.json({ routines: routines.all() });
  });
  // A routine's run history, newest first: what each run came to, and the chat it opened
  // while this process still has it (the session it opened is not in the session lists).
  app.get("/api/routines/runs", requireGrant("chat.read"), (req, res) => {
    const { routineId, limit } = routineRunsQuerySchema.parse(req.query);
    const runs = routineRuns.list(routineId, limit).map((run) => ({
      ...run,
      chatId: run.chatId && manager.peek(run.chatId) ? run.chatId : null,
    }));
    res.json({ runs });
  });
  app.put("/api/routines", requireGrant("routines.manage"), async (req, res) => {
    const input = body(routineSchema, req);
    // A schedule that cannot run is a bad request, said in the dialog's words (the shape
    // cannot check a cron expression's meaning, only its length).
    const problem = cadenceProblem(input.cadence ?? { kind: "daily", hour: 9, minute: 0 }, Date.now(), input.timezone ?? "");
    if (problem) throw new ChatError(400, "bad_cadence", problem);
    if (input.until != null && input.until <= Date.now()) throw new ChatError(400, "bad_expiry", "The expiry has already passed");
    await workspaces.get(input.workspaceId);
    await availableAdapter(input.harnessId);
    try {
      res.json(await routines.save(input));
    } catch (error) {
      const text = errorMessage(error);
      if (/^At most /.test(text)) throw new ChatError(409, "too_many_routines", text);
      throw new ChatError(400, "bad_routine", text);
    }
  });
  /**
   * Run a routine now, outside its cadence: the same run the next tick would make, and
   * (like a scheduled one) it does not move the routine's own next slot. What it came to
   * is in the run history; a precheck that says "nothing to do" answers 409 with its why.
   */
  app.post("/api/routines/:id/run", requireGrant("routines.manage"), async (req, res) => {
    const routine = routines.get(req.params.id);
    if (!routine) throw new ChatError(404, "no_routine", "No such routine");
    const adapter = await availableAdapter(routine.harnessId);
    const workspace = await workspaces.get(routine.workspaceId);
    const ran = await runRoutine(routine, workspace, adapter, manager, {
      runs: routineRuns,
      markOutcome: (id, outcome, detail) => routines.markOutcome(id, outcome, detail),
      post: (r, chat, text) => routineNote(notifier, r, chat, text),
    });
    if (!ran.chat) throw new ChatError(409, "routine_skipped", ran.detail ?? "The precheck skipped this run");
    res.status(202).json({ chatId: ran.chat.chatId, routineId: routine.id });
  });
  app.delete("/api/routines/:id", requireGrant("routines.manage"), async (req, res) => {
    if (!(await routines.remove(req.params.id))) throw new ChatError(404, "no_routine", "No such routine");
    await routineRuns.forget(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/heartbeats", requireGrant("routines.manage"), (_req, res) => {
    res.json({ heartbeats: heartbeats.all().map(heartbeatViewOf) });
  });
  app.delete("/api/heartbeats/:id", requireGrant("routines.manage"), async (req, res) => {
    const heartbeat = heartbeats.get(req.params.id);
    if (!heartbeat) throw new ChatError(404, "no_heartbeat", "No such heartbeat");
    await heartbeats.cancel(req.params.id, heartbeat.ownerHarnessId, heartbeat.ownerNativeId);
    res.json({ cancelled: true });
  });

  app.post("/api/sessions/order", requireGrant("chat.write"), async (req, res) => {
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

  app.get("/api/bots", requireGrant("chat.read"), async (_req, res) => {
    res.json(await board().listBots());
  });
  app.post("/api/bots", requireGrant("boards.manage"), async (req, res) => {
    res.status(201).json(await board().createBot(body(botCreateSchema, req)));
  });
  app.patch("/api/bots/:id", requireGrant("boards.manage"), async (req, res) => {
    res.json(await board().patchBot(req.params.id, body(botPatchSchema, req)));
  });
  app.delete("/api/bots/:id", requireGrant("boards.manage"), async (req, res) => {
    await board().deleteBot(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/rooms", requireGrant("chat.read"), async (_req, res) => {
    res.json(await board().listRooms());
  });
  app.post("/api/rooms", requireGrant("boards.manage"), async (req, res) => {
    const info = await board().createRoom(body(roomCreateSchema, req));
    // The snapshot opens the room immediately, instead of a refetch from the client.
    res.status(201).json(await board().roomSnapshot(info.id));
  });
  app.get("/api/rooms/:id", requireGrant("chat.read"), async (req, res) => {
    res.json(await board().roomSnapshot(req.params.id));
  });
  app.patch("/api/rooms/:id", requireGrant("boards.manage"), async (req, res) => {
    res.json(await board().patchRoom(req.params.id, body(roomPatchSchema, req)));
  });
  app.post("/api/rooms/:id/members", requireGrant("boards.manage"), async (req, res) => {
    res.json(await board().addMember(req.params.id, body(memberAddSchema, req)));
  });
  app.patch("/api/rooms/:id/members/:memberId", requireGrant("boards.manage"), async (req, res) => {
    res.json(await board().patchMember(req.params.id, req.params.memberId, body(memberPatchSchema, req)));
  });
  app.delete("/api/rooms/:id/members/:memberId", requireGrant("boards.manage"), async (req, res) => {
    res.json(await board().removeMember(req.params.id, req.params.memberId));
  });
  app.post("/api/rooms/:id/members/:memberId/reset", requireGrant("boards.manage"), async (req, res) => {
    res.json(await board().resetMemberSession(req.params.id, req.params.memberId));
  });

  // Persist and queue: the turn runs on its own, with no request holding it open.
  app.post("/api/rooms/:id/messages", requireGrant("boards.manage"), async (req, res) => {
    res.status(202).json(await board().postMessage(req.params.id, body(roomMessageSchema, req)));
  });
  app.post("/api/rooms/:id/stop", requireGrant("boards.manage"), async (req, res) => {
    await board().stop(req.params.id);
    res.json({ ok: true });
  });
  app.delete("/api/rooms/:id/queue/:turnId", requireGrant("boards.manage"), async (req, res) => {
    res.json({ queued: await board().cancelQueued(req.params.id, req.params.turnId) });
  });
  app.post("/api/rooms/:id/requests/:requestId/answer", requireGrant("chat.approve"), async (req, res) => {
    const { answer, denialReason } = body(roomAnswerSchema, req);
    await board().answerRequest(req.params.id, req.params.requestId, answer, denialReason);
    res.json({ ok: true });
  });
  app.get("/api/rooms/:id/history", requireGrant("chat.read"), async (req, res) => {
    const query = roomHistoryQuery.parse(req.query);
    res.json({ records: await board().roomHistory(req.params.id, query) });
  });
  app.get("/api/rooms/:id/usage", requireGrant("chat.read"), async (req, res) => {
    res.json(await board().roomUsage(req.params.id));
  });
  app.get("/api/rooms/:id/export", requireGrant("chat.read"), async (req, res) => {
    const markdown = await board().exportRoom(req.params.id);
    const info = await board().roomSnapshot(req.params.id);
    const slug = info.room.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}-${new Date().toISOString().slice(0, 10)}.md"`);
    res.send(markdown);
  });

  // The room stream: same snapshot/replay semantics as a chat's.
  app.get("/api/rooms/:id/events", requireGrant("chat.read"), async (req, res) => {
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

  // ---- Review threads: comments pinned to a chat's diff lines ---------------------
  // A thread keys on the chat id alone, so a review outlives the chat being open (its
  // comments are the record it happened) and only the send needs a live chat. The
  // anchors carry the line's text and hash, so no route reads a diff.
  const review = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ReviewProblem) throw new ChatError(error.status, error.code, error.message);
      throw error;
    }
  };

  /**
   * Where a chat's edited lines stand now: each edited file's present lines as hashes,
   * bounded, for the diff gutter's attribution marks. The lines themselves came from the
   * chat's own tool diffs, which a client already has; this only says which of them are
   * still in the file.
   */
  app.get("/api/chats/:id/attribution", requireGrant("chat.read"), async (req, res) => {
    res.json((await attributionSnapshot(manager.get(req.params.id))) satisfies AttributionSnapshot);
  });

  app.get("/api/chats/:id/review-threads", requireGrant("chat.read"), (req, res) => {
    res.json({ threads: reviewThreads.list(req.params.id) });
  });
  app.post("/api/chats/:id/review-threads", requireGrant("chat.write"), async (req, res) => {
    const { anchor, text } = body(createThreadSchema, req);
    res.status(201).json(await review(() => reviewThreads.create(req.params.id, anchor, text)));
  });
  /** Line moves one client's reconciliation pass found: the pin's hash matched at another line. */
  app.post("/api/chats/:id/review-threads/reanchor", requireGrant("chat.write"), async (req, res) => {
    const { moves } = body(reanchorSchema, req);
    res.json({ moved: await reviewThreads.move(req.params.id, moves) });
  });
  /**
   * Every open thread of this chat as one prompt, to this chat, another chat of the
   * same project, or a new one. While the target runs, the prompt queues as a
   * follow-up where the harness has them; otherwise the send waits for an idle chat.
   */
  app.post("/api/chats/:id/review-threads/send", requireGrant("chat.write"), async (req, res) => {
    const source = manager.get(req.params.id);
    const input = body(sendThreadsSchema, req);
    const threads = reviewThreads.list(source.chatId);
    const open = threads.filter((t) => t.status === "open");
    if (open.length === 0) throw new ChatError(400, "nothing_to_send", "There are no open comments to send");
    const prompt = batchPrompt(threads, new Set(input.stale));
    if (prompt.length > MAX_MESSAGE_CHARS) throw new ChatError(413, "prompt_too_long", `Those comments are ${prompt.length.toLocaleString("en-US")} characters; the limit is ${MAX_MESSAGE_CHARS.toLocaleString("en-US")}`);
    let target: Chat;
    let mode: "normal" | "followUp" = "normal";
    if (input.target.kind === "chat") {
      target = manager.get(input.target.chatId);
      const busy = target.status !== "idle" && target.status !== "error";
      // A follow-up only exists inside a run, so a stopping or compacting chat is still a wait.
      if (busy) {
        if (input.mode === "normal" || target.status !== "running" || !target.adapter.capabilities.supportsFollowUp) throw new ChatError(409, "chat_busy", "Wait until the agent is idle");
        mode = "followUp";
      }
    } else {
      const adapter = await availableAdapter(input.target.harnessId);
      target = await manager.create(adapter, await workspaces.get(source.workspace.id));
    }
    await target.send(prompt, mode);
    await reviewThreads.markSent(source.chatId, open.map((t) => t.id), Date.now());
    res.status(202).json({ accepted: true, targetChatId: target.chatId, sent: open.length } satisfies ReviewSendResult);
  });
  app.post("/api/chats/:id/review-threads/:threadId/notes", requireGrant("chat.write"), async (req, res) => {
    const { text } = body(replySchema, req);
    res.status(201).json(await review(() => reviewThreads.addNote(req.params.id, req.params.threadId, text)));
  });
  app.post("/api/chats/:id/review-threads/:threadId/status", requireGrant("chat.write"), async (req, res) => {
    const { status } = body(threadStatusSchema, req);
    res.json(await review(() => reviewThreads.setStatus(req.params.id, req.params.threadId, status)));
  });
  app.delete("/api/chats/:id/review-threads/:threadId", requireGrant("chat.write"), async (req, res) => {
    if (!(await reviewThreads.remove(req.params.id, req.params.threadId))) throw new ChatError(404, "no_thread", "No such comment thread");
    res.json({ ok: true });
  });

  app.post("/api/chats", requireGrant("chat.write"), async (req, res) => {
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

  app.post("/api/chats/resume", requireGrant("chat.write"), async (req, res) => {
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
    if (!manager.liveChatFor(adapter.id, nativeId) && handovers.has(input.sessionId) && !input.reclaim) {
      throw new ChatError(409, "session_handed", `This session was handed to a terminal (${handovers.get(input.sessionId) ?? "its command is no longer retained"}); reclaim it before resuming it here`);
    }
    // Reclaim may happen only when a native lease no longer holds the session; otherwise keep the lock and never start a second writer.
    if (!manager.liveChatFor(adapter.id, nativeId) && (await adapter.heldElsewhere?.(nativeId))) {
      throw new ChatError(409, "session_held", `This session is open in another ${adapter.displayName}: close that one first, or opening it here would run a second ${adapter.displayName} on the same session`);
    }
    if (input.reclaim && handovers.has(input.sessionId)) await handovers.take(input.sessionId);
    const chat = await manager.resume(adapter, ws, nativeId, undefined, { reclaim: input.reclaim === true });
    // Opening it read the session: a parked chat's mark said the live chat was gone, and this
    // one is back — the same native session, a new chat id, no second writer.
    void marks.set(`${adapter.id}:${nativeId}`, { parked: false }).catch(() => undefined);
    // A run was going when the last process stopped: its child died with it, so this
    // session carries the intent to carry on. One prompt, once, on the first open after
    // the restart — a chat nobody reopens starts nothing.
    if (chat.sessionId && (await resumeIntents.take(chat.sessionId))) {
      void chat.send(RESUME_TEXT, "normal").catch((error: unknown) => log(`resume working: ${errorMessage(error)}`));
    }
    res.json(chat.snapshot());
  });

  /**
   * Restart a chat's harness on the same session: the settings, tools, skills, and
   * extensions it loads are read again while the conversation stays. The old chat is
   * disposed and a new one resumes the session, so the answer carries the new chat id.
   */
  app.post("/api/chats/:id/restart", requireGrant("chat.write"), async (req, res) => {
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

  // Device hosts (G13's interface, device-host.ts): what emulator/simulator farms hold,
  // read-only. No host is configured without one; nothing here starts or stops a device,
  // and a real adb/xcrun integration is documented as outstanding.
  app.get("/api/devices", requireGrant("chat.read"), async (_req, res) => {
    if (!deps.deviceHosts || deps.deviceHosts.length === 0) throw new ChatError(404, "no_device_hosts", "No device hosts are configured");
    const lists = await Promise.all(deps.deviceHosts.map(async (host) => ({ host: host.id, ...(await host.list()) })));
    res.json({ hosts: lists });
  });

  // An image under a prompt (see image-store): the id is the hash of its bytes, so it never changes.
  app.get("/api/images/:id", requireGrant("chat.read"), (req, res) => {
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
  app.get("/api/chats/:id/html-render/:renderId", requireGrant("chat.read"), async (req, res) => {
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

  // A deep link's key (chat-stream.ts): a live chat's id, or the stable namespaced session id
  // (`pi:<native>`), which survives the reopen that mints a new chat id. Answers what opens it;
  // a key nothing knows is a 404 the client renders inert (the hash cleared, no error).
  app.get("/api/chats/link/:key", requireGrant("chat.read"), async (req, res) => {
    const key = String(req.params.key);
    if (!/^[\w.:+-]{1,160}$/.test(key)) throw new ChatError(400, "bad_link", "Not a chat link key");
    const direct = manager.peek(key);
    if (direct && direct.status !== "disposed") return void res.json({ chatId: key });
    const at = key.indexOf(":");
    if (at > 0) {
      const live = manager.liveChatFor(key.slice(0, at), key.slice(at + 1));
      if (live && live.status !== "disposed") return void res.json({ chatId: live.chatId });
    }
    const session = (await listSessions(null)).sessions.find((s) => s.id === key);
    if (session) return void res.json({ session: { id: session.id, harnessId: session.harnessId, workspaceId: session.workspaceId, title: session.title, liveChatId: session.liveChatId ?? null } });
    throw new ChatError(404, "unknown_chat", "No chat or session answers to that link");
  });

  app.get("/api/chats/:id", requireGrant("chat.read"), (req, res) => {
    res.json(manager.get(req.params.id).snapshot());
  });

  app.get("/api/chats/:id/events", requireGrant("chat.read"), (req, res) => {
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

  app.post("/api/chats/:id/pastes", requireGrant("chat.write"), express.json({ limit: "1100kb" }), async (req, res) => {
    const chat = manager.get(req.params.id);
    const { text } = body(uploadPasteSchema, req);
    res.status(201).json(await storePaste(chat.chatId, text));
  });
  app.delete("/api/chats/:id/pastes/:pasteId", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    await deletePaste(chat.chatId, req.params.pasteId);
    res.json({ ok: true });
  });

  app.post("/api/chats/:id/messages", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    const { text, images, mode, compactFirst, attachments } = body(sendMessageSchema, req);
    for (const image of images) {
      if (sniffImage(image.data) !== image.mimeType) throw new ChatError(400, "bad_image", "An attachment is not the image type it claims to be");
    }
    // The session was handed to a terminal (its resume line copied) and not reclaimed: writing
    // here alongside the pasted line would be a second writer, so the send waits until the
    // chat is closed (completing the handover) or reclaimed in the session list.
    if (mode === "normal" && chat.sessionId && handovers.has(chat.sessionId)) {
      throw new ChatError(409, "session_handed", `This session was handed to a terminal: reclaim it in the session list, or close the chat here first, so only one process writes it`);
    }
    const pastes = attachments.length > 0 ? await Promise.all(attachments.map((a) => resolvePaste(chat.chatId, a.id))) : [];
    const header = pastes
      .map((p) => `[Pasted content is saved as ${p.path} (${p.lines.toLocaleString("en-US")} lines). Read that file with your tools rather than asking me to resend it.]`)
      .join("\n");
    await chat.send(header ? `${header}\n\n${text}` : text, mode, images, compactFirst ? { compactFirst } : {});
    res.status(202).json({ accepted: true, mode });
  });

  app.post("/api/chats/:id/rewind", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    const { turn, text, images } = body(rewindSchema, req);
    for (const image of images) {
      if (sniffImage(image.data) !== image.mimeType) throw new ChatError(400, "bad_image", "An attachment is not the image type it claims to be");
    }
    await chat.rewind(turn, text, images);
    res.status(202).json({ accepted: true });
  });

  app.post("/api/chats/:id/abort", requireGrant("chat.write"), (req, res) => {
    const chat = manager.get(req.params.id);
    chat.abort().catch((error: unknown) => log(`abort failed: ${errorMessage(error)}`));
    res.status(202).json({ accepted: true });
  });

  app.get("/api/chats/:id/accounts", requireGrant("chat.read"), async (req, res) => {
    res.json({ accounts: await manager.get(req.params.id).accounts() });
  });
  app.post("/api/chats/:id/account", requireGrant("chat.write"), async (req, res) => {
    const { id } = body(accountSelectionSchema, req);
    await manager.get(req.params.id).pinAccount(id);
    res.json({ ok: true });
  });

  app.patch("/api/chats/:id/config", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.setConfig(body(patchConfigSchema, req));
    res.json(chat.snapshot().config);
  });

  // A subagent's own transcript, for the viewer: read from the file its harness wrote.
  app.get("/api/chats/:id/tools/:toolId/agents/:runId", requireGrant("chat.read"), async (req, res) => {
    res.json(await manager.get(req.params.id).subagentTranscript(req.params.toolId, req.params.runId));
  });

  app.get("/api/chats/:id/commands", requireGrant("chat.read"), async (req, res) => {
    res.json({ commands: await manager.get(req.params.id).commands() });
  });

  // A chat's delegated tasks, for the panel above its composer: the same bounded rows its
  // snapshot carries (`task` events keep them current), read fresh for a panel opened late.
  app.get("/api/chats/:id/tasks", requireGrant("chat.read"), (req, res) => {
    res.json({ tasks: orchestration.tasksFor(manager.get(req.params.id)) });
  });

  /** Editable worker proposals are owned by this chat; a different browser chat cannot confirm them. */
  app.get("/api/chats/:id/plans", requireGrant("chat.read"), (req, res) => {
    const snap = manager.get(req.params.id).snapshot();
    res.json({ plan: snap.plan ?? null });
  });
  app.post("/api/chats/:id/plans", requireGrant("chat.write"), async (req, res) => {
    const input = body(workerPlanSaveSchema, req);
    const args = { ...input, action: "save" as const };
    res.status(201).json(await orchestration.editPlanFor(manager.get(req.params.id), args));
  });
  app.post("/api/chats/:id/plans/:action", requireGrant("chat.write"), async (req, res) => {
    const input = body(workerPlanConfirmSchema, req);
    const action = req.params.action;
    if (action !== "confirm" && action !== "cancel") throw new ChatError(404, "not_found", "No such plan action");
    res.json(await orchestration.editPlanFor(manager.get(req.params.id), { planId: input.planId, action }));
  });

  // The user stopping a child its chat's agent started. The tool's own cancel answers the model;
  // this one answers the panel, so a child that is slow to settle still comes back cancelled
  // rather than as a 504. Refusals are the tool's: unknown_task, not_your_task.
  app.post("/api/chats/:id/tasks/:taskId/cancel", requireGrant("chat.write"), async (req, res) => {
    res.json({ task: await orchestration.cancelFor(manager.get(req.params.id), req.params.taskId) });
  });

  // A finished isolated worker is only reviewed by the person's explicit decision; apply never
  // races a moved lead or worker head. Cleanup still refuses unreviewed changes.
  const integrationOf = (chatId: string, id: string): IntegrationRecord => {
    // Every browser action passes through the existing parent ownership check first.
    void orchestration.taskFor(manager.get(chatId), id);
    const record = integrationLedger?.get(id);
    if (!record) throw new ChatError(404, "no_integration", `No review record for task ${id}`);
    return record;
  };
  app.get("/api/chats/:id/tasks/:taskId/review", requireGrant("chat.read"), async (req, res) => {
    const record = integrationOf(req.params.id, req.params.taskId);
    const ws = await workspaces.get(record.workspaceId);
    const heads = integrationLedger
      ? await integrationLedger.headsMatch(record, { root: ws.path, ws, trees: projectTrees as never }).catch(() => null)
      : null;
    res.json({ record, headsMatch: heads?.match ?? null, reason: heads?.reason ?? null });
  });
  app.post("/api/chats/:id/tasks/:taskId/review", requireGrant("workspaces.manage"), async (req, res) => {
    // An apply writes the reviewed worker's changes into the lead checkout: the same
    // bound as the git panel's own writes, checked before the record or the project.
    requireThisMachine(req, res);
    if (!integrationLedger) throw new ChatError(501, "review_off", "Reviews are not wired on this server");
    const input = body(taskReviewDecisionSchema, req);
    const ws = await workspaces.get(input.workspaceId);
    const by = requester(req, res);
    const who = by.local ? "local" : by.authority || by.kind;
    const result = await integrationLedger.reviewTask(req.params.taskId, input.decision, input.note, who, {
      root: ws.path,
      ws,
      trees: projectTrees as never,
    });
    res.json(result);
  });
  app.post("/api/chats/:id/tasks/:taskId/unreview", requireGrant("workspaces.manage"), async (req, res) => {
    if (!integrationLedger) throw new ChatError(501, "review_off", "Reviews are not wired on this server");
    // The inverse needs the project: an applied patch is reversed in the lead checkout there.
    const record = integrationOf(req.params.id, req.params.taskId);
    const ws = await workspaces.get(record.workspaceId);
    res.json({ record: await integrationLedger.unreview(req.params.taskId, { root: ws.path, ws, trees: projectTrees as never }) });
  });
  app.get("/api/chats/:id/tasks/:taskId/review/diff", requireGrant("chat.read"), async (req, res) => {
    if (!integrationLedger) throw new ChatError(501, "review_off", "Reviews are not wired on this server");
    const record = integrationOf(req.params.id, req.params.taskId);
    const { path: file } = raceDiffQuery.parse(req.query);
    const ws = await workspaces.get(record.workspaceId);
    res.json(await integrationLedger.diff(req.params.taskId, file, { root: ws.path, ws, trees: projectTrees as never }));
  });
  app.post("/api/chats/:id/tasks/:taskId/review/cleanup", requireGrant("workspaces.manage"), async (req, res) => {
    if (!integrationLedger) throw new ChatError(501, "review_off", "Reviews are not wired on this server");
    const record = integrationOf(req.params.id, req.params.taskId);
    const ws = await workspaces.get(record.workspaceId);
    res.json(await integrationLedger.cleanup(req.params.taskId, { root: ws.path, ws, trees: projectTrees as never }));
  });

  app.post("/api/chats/:id/models/refresh", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.refreshModels();
    res.json(chat.snapshot().config);
  });

  // An edited or removed queued message: the whole queue, as it should now be.
  app.put("/api/chats/:id/queue", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.replaceQueue(body(queueSchema, req));
    res.json({ accepted: true });
  });

  app.post("/api/chats/:id/rename", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.rename(body(renameSchema, req).name);
    res.json({ title: chat.title });
  });

  app.post("/api/chats/:id/compact", requireGrant("chat.write"), (req, res) => {
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
  app.post("/api/chats/:id/continue-at", requireGrant("chat.write"), (req, res) => {
    const chat = manager.get(req.params.id);
    const { at } = body(continueAtSchema, req);
    if (at !== null && at > Date.now() + 24 * 86_400_000) throw new ChatError(400, "bad_continue", "That is further away than a month");
    chat.scheduleContinue(at);
    res.json({ ok: true, continueAt: chat.continueAt });
  });
  app.post("/api/chats/:id/run", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    const { command, shell } = body(runCommandSchema, req);
    log(`run: a ${shell} command in ${chat.workspace.name}`);
    await prepareSpawnEnv(chat.workspace.path);
    res.json(await runCommand(command, shell, chat.workspace.path));
  });

  // The project's git status (the composer's git row) and a listed file's diff.
  app.get("/api/chats/:id/git", requireGrant("chat.read"), async (req, res) => {
    const chat = manager.get(req.params.id);
    res.json({ status: await gitStatus(chat.workspace.path).catch(() => null), direnv: direnvState(chat.workspace.path) });
  });
  app.get("/api/chats/:id/git/diff", requireGrant("chat.read"), async (req, res) => {
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

  const gitWrite = async (req: Request<{ id: string }>, res: Response, run: (cwd: string) => Promise<GitStatus>) => {
    const chat = manager.get(req.params.id);
    // A remote device may read the project's git status but cannot change it; even a
    // full session has this bound (the same check gates every other checkout write).
    requireThisMachine(req, res);
    try {
      return await run(chat.workspace.path);
    } catch (error) {
      if (error instanceof GitActionError) throw new ChatError(error.status, error.code, error.message);
      throw error;
    }
  };
  /** Stage, unstage, or commit from the git panel: every write this app makes to a repository, by hand. */
  app.post("/api/chats/:id/git/stage", requireGrant("chat.write"), async (req, res) => {
    const { paths } = body(gitPathsSchema, req);
    res.json({ status: await gitWrite(req, res, (cwd) => stageFiles(cwd, paths)) });
  });
  app.post("/api/chats/:id/git/unstage", requireGrant("chat.write"), async (req, res) => {
    const { paths } = body(gitPathsSchema, req);
    res.json({ status: await gitWrite(req, res, (cwd) => unstageFiles(cwd, paths)) });
  });
  app.post("/api/chats/:id/git/commit", requireGrant("chat.write"), async (req, res) => {
    const { message } = body(gitCommitSchema, req);
    res.json({ status: await gitWrite(req, res, (cwd) => commitStaged(cwd, message)) });
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
  app.get("/api/chats/:id/checkpoints", requireGrant("chat.read"), async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), false);
    await cp.start();
    res.json({ points: cp.points() });
  });
  app.get("/api/chats/:id/checkpoints/compare", requireGrant("chat.read"), async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), false);
    const { from, to } = checkpointCompareSchema.parse(req.query);
    res.json((await cp.compare(from, to).catch(checkpointFailure)) satisfies CheckpointComparison);
  });
  app.get("/api/chats/:id/checkpoints/:turn", requireGrant("chat.read"), async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), false);
    const { files } = await cp.preview(turnOf(req.params.turn)).catch(checkpointFailure);
    res.json({ files } satisfies CheckpointPreview);
  });
  app.post("/api/chats/:id/checkpoints/:turn/restore", requireGrant("chat.write"), async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), true);
    const { paths } = body(restoreSchema, req);
    res.json((await cp.restore(turnOf(req.params.turn), paths).catch(checkpointFailure)) satisfies CheckpointRestored);
  });
  app.post("/api/chats/:id/checkpoints/put-back", requireGrant("chat.write"), async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), true);
    const { tree, paths } = body(putBackSchema, req);
    const all = paths ?? (await cp.previewTree(tree).catch(checkpointFailure)).files.map((f) => f.path);
    if (all.length === 0) {
      res.json({ files: [], undo: tree } satisfies CheckpointRestored);
      return;
    }
    res.json((await cp.restore(null, all, tree).catch(checkpointFailure)) satisfies CheckpointRestored);
  });

  app.post("/api/chats/:id/fork", requireGrant("chat.write"), async (req, res) => {
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
      await moved.send(brief, "normal", [], { origin: "agent" }).catch(() => undefined);
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
  app.post("/api/chats/:id/handoff", requireGrant("chat.write"), async (req, res) => {
    const { harness, through, prompt } = body(handoffSchema, req);
    res.status(201).json((await handoffChat(manager.get(req.params.id), harness, { ...(through ? { through } : {}), ...(prompt ? { prompt } : {}) })).snapshot());
  });


  /**
   * Free context rotation: a fresh session in the same harness, seeded from this
   * chat's own transcript (the newest turns verbatim, one line per older one).
   * The seed is a file the harness writes, so nothing is summed by a model, nothing
   * is paid for, and this chat's session file is only read.
   */
  app.post("/api/chats/:id/rotate", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    if (!chat.adapter.capabilities.supportsHandoff) {
      throw new ChatError(400, "unsupported", `${chat.adapter.displayName} cannot start a session from a transcript: compact instead`);
    }
    if (chat.status !== "idle" && chat.status !== "error") throw new ChatError(409, "busy", "Wait until the agent is idle");
    if (!chat.nativeId) throw new ChatError(409, "not_started", "This chat has no session to carry over yet");
    const snap = chat.snapshot();
    const seed = toSeed(snap.items, { title: snap.title, todos: snap.todos });
    if (isEmptySeed(seed)) throw new ChatError(400, "empty_seed", "There is nothing to carry over yet");
    let live;
    try {
      live = await chat.adapter.seedChat({ cwd: chat.workspace.path, seed });
    } catch (error) {
      throw new ChatError(502, "rotate_failed", `${chat.adapter.displayName} could not start a session from this transcript: ${errorMessage(error)}`);
    }
    const fresh = await manager.seedOpen(chat.adapter, chat.workspace, live);
    // The fresh chat carries on as the same model and thinking level where the harness takes both.
    const config: { model?: string; thinkingLevel?: string } = {};
    if (chat.adapter.capabilities.supportsModelSelection && snap.config.model) config.model = snap.config.model;
    if (chat.adapter.capabilities.supportsThinkingLevel && snap.config.thinkingLevel) config.thinkingLevel = snap.config.thinkingLevel;
    if (Object.keys(config).length > 0) await fresh.setConfig(config).catch(() => undefined);
    res.status(201).json({ snapshot: fresh.snapshot() } satisfies RotateResult);
  });

  /**
   * A second opinion on one turn: the turn and a question go to another harness as
   * the first prompt of an ordinary chat in this project. Nothing is written into
   * either session file by awui: the other agent's reply is that chat's own
   * transcript, and the cards in this transcript are records in the state folder.
   */
  app.post("/api/chats/:id/second-opinion", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    const { turn, harness, ask } = body(secondOpinionSchema, req);
    const target = await availableAdapter(harness);
    if (target.id === chat.adapter.id) throw new ChatError(400, "same_harness", "Pick another harness for a second opinion");
    const turns = chat.userTurns();
    if (turn > turns.length) throw new ChatError(400, "no_turn", `This chat has ${turns.length} turn${turns.length === 1 ? "" : "s"}`);
    const snap = chat.snapshot();
    const seed = toSeed(snap.items, { throughTurns: turn });
    const picked = seed.turns[seed.turns.length - 1];
    if (!picked) throw new ChatError(400, "no_turn", "That turn has nothing to send");
    const brief = turnBrief(picked, { from: chat.adapter.displayName, project: chat.workspace.name, ask: ask?.trim() ? ask.trim() : null });
    if (brief.length > MAX_MESSAGE_CHARS) throw new ChatError(413, "prompt_too_long", "That turn is too long to send");
    const moved = await manager.create(target, chat.workspace);
    try {
      await moved.send(brief, "normal");
    } catch (error) {
      await moved.dispose("the second opinion could not start").catch(() => undefined);
      throw new ChatError(502, "opinion_failed", `${target.displayName} could not take this turn: ${errorMessage(error)}`);
    }
    if (target.capabilities.supportsRename) await moved.rename(`Second opinion from ${chat.adapter.displayName}`).catch(() => undefined);
    const opinion = await secondOpinions.add(chat.chatId, { turn, from: chat.adapter.id, to: target.id, chatId: moved.chatId, ask: ask?.trim() ?? "" });
    res.status(201).json({ opinion, snapshot: moved.snapshot() } satisfies SecondOpinionResult);
  });

  /** A chat's second opinions, newest first, each with what the other agent has said so far. */
  app.get("/api/chats/:id/second-opinion", requireGrant("chat.read"), (req, res) => {
    const opinions = secondOpinions.list(req.params.id).map((opinion) => {
      const target = manager.peek(opinion.chatId);
      const answer = target ? reportExcerpt(target.snapshot().items) : null;
      return secondOpinions.setReport(req.params.id, opinion.id, answer) ?? opinion;
    });
    res.json({ opinions });
  });

  /**
   * A side thread: a question about one block of this chat's transcript, asked in a
   * chat of its own so the main one is never touched. Read-only where awui's own
   * harness is installed (it has no write or exec tools); otherwise a fork of this
   * chat at that turn, which is as capable as the chat it came from and says so.
   * Either way it is hidden from every session list: it is a look, not a session.
   */
  app.post("/api/chats/:id/side", requireGrant("chat.write"), async (req, res) => {
    const chat = manager.get(req.params.id);
    const { turn, question } = body(sideThreadSchema, req);
    const turns = chat.userTurns();
    if (turn > turns.length) throw new ChatError(400, "no_turn", `This chat has ${turns.length} turn${turns.length === 1 ? "" : "s"}`);
    const snap = chat.snapshot();
    const seed = toSeed(snap.items, { throughTurns: turn });
    const picked = seed.turns[seed.turns.length - 1];
    if (!picked) throw new ChatError(400, "no_turn", "That turn has nothing to ask about");
    const prompt = sideThreadPrompt(picked, { from: chat.adapter.displayName, project: chat.workspace.name, question });
    const awui = registry.get("awui");
    let side: Chat;
    let readOnly = false;
    if (awui && registry.isAvailable(awui.id)) {
      // awui's own harness reads, searches, and computes; it can neither edit nor run anything.
      readOnly = true;
      side = await manager.create(awui, chat.workspace);
      await side.send(prompt, "normal").catch(() => undefined);
    } else if (chat.adapter.capabilities.supportsFork && chat.nativeId) {
      if (chat.status === "idle" || chat.status === "error") {
        // A fork copies the turns up to this one: the question is its first new turn, and this chat keeps its own.
        const forked = await chat.adapter.forkSession({ cwd: chat.workspace.path, nativeId: chat.nativeId, throughTurns: turn });
        side = await manager.resume(chat.adapter, chat.workspace, forked.nativeId);
        await side.send(question, "normal").catch(() => undefined);
      } else {
        throw new ChatError(409, "chat_busy", "Wait until the agent is idle, or install the Awui harness for a side thread while it works");
      }
    } else {
      throw new ChatError(400, "no_side_thread", "A side thread needs awui's own harness (read-only), or a harness that can fork a session");
    }
    side.side = chat.chatId;
    if (side.adapter.capabilities.supportsRename) await side.rename(`Side thread · ${chat.title || chat.workspace.name}`).catch(() => undefined);
    res.status(201).json({ snapshot: side.snapshot(), readOnly } satisfies SideThreadResult);
  });
  // The chain: what a chat runs after its run settles, kept here so it goes on with no browser open.
  manager.onChainHandoff = async (chat, step, rest) => {
    const moved = await handoffChat(chat, step.harness, step.prompt ? { prompt: step.prompt } : {});
    if (rest.length > 0) moved.setChain(rest, true);
  };
  app.put("/api/chats/:id/chain", requireGrant("chat.write"), async (req, res) => {
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

  app.post("/api/chats/:id/requests/:requestId", requireGrant("chat.approve"), async (req, res) => {
    const chat = manager.get(req.params.id);
    const { answer, denialReason } = body(answerSchema, req);
    const outcome = chat.answer(req.params.requestId, answer, denialReason);
    res.json({ outcome });
  });

  app.post("/api/chats/:id/dispose", requireGrant("chat.write"), async (req, res) => {
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
