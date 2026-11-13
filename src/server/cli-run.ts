// The headless CLI: `awui run`, `awui send`, `awui wait`, and `awui chats`
// drive a server that is already running, from a script, a cron job, or an
// editor hook. It is a thin client on purpose: the same JSON API the browser
// and atui use, no second way to run a harness, and nothing written to the
// state folder. The server is found the way the desktop shell finds it (the
// state folder's server.json, else $AWUI_URL, else the default port) and
// answers `awui`'s own /api/health, so another program on the port is never
// driven. The answer is read from the chat's own ChatItems: the last reply the
// agent wrote, exactly what the web UI draws.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_PORT, ENDPOINT_FILE, parseEndpoint } from "../shared/desktop.js";
import { IDEMPOTENCY_KEY_HEADER, type Bootstrap, type ChatItem, type ChatSnapshot, type ChatStatus, type SessionUsage, type SessionsOverview, type WorkspaceInfo } from "../shared/protocol.js";
import { loadConfig } from "./config.js";

/** A run settled on its own (idle), then nothing; 1 the run failed or the CLI could not do what it was asked. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
/** The command line itself was wrong; nothing was sent. */
export const EXIT_USAGE = 2;
/** The run had not settled when the CLI stopped waiting (the run itself keeps going on the server). */
export const EXIT_TIMEOUT = 3;

/** How long `--wait` and `wait` wait without a --timeout: long enough for a real task, short enough to fail a stuck one. */
export const DEFAULT_WAIT_SECONDS = 3600;
/** How often the CLI asks for the chat while it waits. */
const POLL_MS = 400;
/** A health probe's timeout: a stale endpoint file must not hang the command. */
const PROBE_MS = 1500;

export const CLI_USAGE = `awui run/send/wait/chats/inspect/attach/logs: drive the running awui server, for scripts

Usage:
  awui run [--harness <id>] [--project <path>] [--model <id>] [--wait] [--json] "<prompt>"
  awui send <chatId> "<prompt>"
  awui wait <chatId> [--timeout <seconds>]
  awui chats [--json]
  awui inspect <chatId> [--json]
  awui logs <chatId> [--tail <n>] [--json]
  awui attach <sessionId> --harness <id> --project <path> [--reclaim] [--ignore-herdr] [--json]

run starts a chat and prints its id; with --wait it waits until the run settles
and prints the answer (the id goes to stderr, so stdout is the answer alone).
send adds a prompt to a chat that is open on the server. wait waits for that
chat's run and prints the answer. chats lists the chats open there, newest first.
inspect prints one chat's state (status, title, counts, the last answer).
logs prints its transcript, one item per line (kind, then the text).
attach resumes one session from the sidebar's list as a live chat here.

--json prints one object: {"chatId", "status", "answer", "error"?, "usage"?}.

The server is found at $AWUI_URL, else the port in <state folder>/server.json,
else http://127.0.0.1:4783. It is never started by this command.

Exit codes: 0 settled ok, 1 failed or error, 2 usage error, 3 timeout.`;

export type Command =
  | { kind: "run"; prompt: string; harness: string | null; project: string | null; model: string | null; wait: boolean; json: boolean }
  | { kind: "send"; chatId: string; prompt: string }
  | { kind: "wait"; chatId: string; timeoutSeconds: number }
  | { kind: "chats"; json: boolean }
  | { kind: "inspect"; chatId: string; json: boolean }
  | { kind: "logs"; chatId: string; tail: number | null; json: boolean }
  | { kind: "attach"; sessionId: string; harness: string; project: string | null; reclaim: boolean; ignoreHerdr: boolean; json: boolean }
  | { kind: "help" };

/** What the CLI reads and writes; a test hands in its own collectors instead of the process's streams. */
export interface CliIo {
  env: NodeJS.ProcessEnv;
  /** One line to stdout: the answer, the chat id, or one JSON object. */
  out(line: string): void;
  /** One line to stderr: problems, and the chat a waiting run belongs to. */
  err(line: string): void;
}

/** The word after an option at `at`, or null when the option is the last one. */
function valueAfter(args: string[], at: number): string | null {
  const value = args[at + 1];
  return value === undefined ? null : value;
}

/** `run`'s options, then its prompt (one word after quoting, or several unquoted ones joined). */
function parseRun(args: string[]): Command | { error: string } {
  const words: string[] = [];
  let harness: string | null = null;
  let project: string | null = null;
  let model: string | null = null;
  let wait = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--harness" || arg === "--project" || arg === "--model") {
      const value = valueAfter(args, i);
      if (value === null || value === "") return { error: `${arg} needs a value` };
      i += 1;
      if (arg === "--harness") harness = value;
      else if (arg === "--project") project = value;
      else model = value;
    } else if (arg === "--wait") wait = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    else words.push(arg);
  }
  const prompt = words.join(" ").trim();
  if (prompt === "") return { error: "a prompt is needed (quote it: awui run \"add a test\")" };
  return { kind: "run", prompt, harness, project, model, wait, json };
}

/** The chat id and the prompt, and no options: `send` addresses a chat that already exists. */
function parseSend(args: string[]): Command | { error: string } {
  const flag = args.find((a) => a.startsWith("--"));
  if (flag !== undefined) return { error: `send takes no options (${flag})` };
  const [chatId, ...rest] = args;
  if (!chatId) return { error: "a chat id is needed (see `awui chats`)" };
  const prompt = rest.join(" ").trim();
  if (prompt === "") return { error: "a prompt is needed (quote it: awui send <chatId> \"carry on\")" };
  return { kind: "send", chatId, prompt };
}

function parseWait(args: string[]): Command | { error: string } {
  let chatId: string | null = null;
  let timeoutSeconds = DEFAULT_WAIT_SECONDS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--timeout") {
      const value = valueAfter(args, i);
      i += 1;
      const seconds = Number(value);
      if (!value || !Number.isFinite(seconds) || seconds <= 0) return { error: "--timeout takes a number of seconds" };
      timeoutSeconds = seconds;
    } else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    else if (chatId !== null) return { error: `unexpected word ${arg}` };
    else chatId = arg;
  }
  if (!chatId) return { error: "a chat id is needed (see `awui chats`)" };
  return { kind: "wait", chatId, timeoutSeconds };
}

function parseChats(args: string[]): Command | { error: string } {
  for (const arg of args) if (arg !== "--json") return { error: `unknown option ${arg}` };
  return { kind: "chats", json: args.includes("--json") };
}

/** One chat id and no options: `inspect` reads a chat the server already holds. */
function parseInspect(args: string[]): Command | { error: string } {
  let chatId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") continue;
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    if (chatId !== null) return { error: `unexpected word ${arg}` };
    chatId = arg;
  }
  if (!chatId) return { error: "a chat id is needed (see `awui chats`)" };
  return { kind: "inspect", chatId, json: args.includes("--json") };
}

/** A chat id and an optional --tail: `logs` prints the transcript as it is on the server. */
function parseLogs(args: string[]): Command | { error: string } {
  let chatId: string | null = null;
  let tail: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--tail") {
      const value = valueAfter(args, i);
      i += 1;
      const n = Number(value);
      if (!value || !Number.isInteger(n) || n <= 0) return { error: "--tail takes a number of items" };
      tail = n;
    } else if (arg === "--json") continue;
    else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    else if (chatId !== null) return { error: `unexpected word ${arg}` };
    else chatId = arg;
  }
  if (!chatId) return { error: "a chat id is needed (see `awui chats`)" };
  return { kind: "logs", chatId, tail, json: args.includes("--json") };
}

/** A namespaced session id plus its harness: `attach` resumes it through the same resume the web uses. */
function parseAttach(args: string[]): Command | { error: string } {
  let sessionId: string | null = null;
  let harness: string | null = null;
  let project: string | null = null;
  let reclaim = false;
  let ignoreHerdr = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--harness" || arg === "--project") {
      const value = valueAfter(args, i);
      if (value === null || value === "") return { error: `${arg} needs a value` };
      i += 1;
      if (arg === "--harness") harness = value;
      else project = value;
    } else if (arg === "--reclaim") reclaim = true;
    else if (arg === "--ignore-herdr") ignoreHerdr = true;
    else if (arg === "--json") continue;
    else if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    else if (sessionId !== null) return { error: `unexpected word ${arg}` };
    else sessionId = arg;
  }
  if (!sessionId) return { error: "a session id is needed (see `awui chats --json` or the sidebar)" };
  if (!harness) return { error: "--harness is needed (the session's harness, e.g. fake, omp, claude)" };
  return { kind: "attach", sessionId, harness, project, reclaim, ignoreHerdr, json: args.includes("--json") };
}

/**
 * The command line as one command, or what is wrong with it. Pure: parsing
 * decides which of the four commands and nothing about the server.
 */
export function parseCommand(args: string[]): Command | { error: string } {
  const [name, ...rest] = args;
  if (name === undefined) return { error: "expected a command: run, send, wait, chats, inspect, attach, or logs" };
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };
  switch (name) {
    case "run":
      return parseRun(rest);
    case "send":
      return parseSend(rest);
    case "wait":
      return parseWait(rest);
    case "chats":
      return parseChats(rest);
    case "inspect":
      return parseInspect(rest);
    case "logs":
      return parseLogs(rest);
    case "attach":
      return parseAttach(rest);
    default:
      return { error: `unknown command ${name} (run, send, wait, chats, inspect, attach, or logs)` };
  }
}

/** A chat's state as the CLI reads it: the snapshot, or enough of it. */
export type ChatReading = Pick<ChatSnapshot, "status" | "items">;

export interface Outcome {
  /** The run ended on its own or was stopped: nothing more will arrive until the next prompt. */
  settled: boolean;
  /** It settled well (idle), not failed, closed, or in an error state. */
  ok: boolean;
  /** The agent's last reply in the chat, trimmed; "" when it wrote none. */
  answer: string;
  /** The run's own error notice, when the harness or the server reported one. */
  error: string | null;
}

/** Some letter or digit: the rule web/turns.ts uses for a reply worth showing (the server build cannot import it). */
const hasText = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/**
 * How a chat reads at this moment: settled or still running, its answer, and
 * its error. The answer is the last assistant text in the chat, which is what
 * a reader wants after a run and what atui's turn fold calls the answer. A
 * failed model call rides on that item's own `error` (the harness's error turn
 * settles, so the chat is idle); a status of "error" means the harness itself
 * died, which the server noticed and recorded as a notice.
 */
export function outcomeOf(reading: ChatReading): Outcome {
  const settled = reading.status === "idle" || reading.status === "error" || reading.status === "disposed";
  let answer = "";
  let error: string | null = null;
  for (let i = reading.items.length - 1; i >= 0; i--) {
    const item = reading.items[i] as ChatItem;
    if (item.kind === "assistant" && (hasText(item.text) || item.error)) {
      answer = hasText(item.text) ? item.text.trim() : "";
      if (item.error) error = item.error;
      break;
    }
  }
  // Only this turn's notices: an old error from an earlier turn is not this run's failure.
  for (let i = reading.items.length - 1; i >= 0 && error === null; i--) {
    const item = reading.items[i] as ChatItem;
    if (item.kind === "user") break;
    if (item.kind === "notice" && item.level === "error") error = item.text;
  }
  return { settled, ok: settled && reading.status === "idle" && error === null, answer, error };
}

/** Whether /api/health's body is awui's: ok true and a build field (a string, or null with no built UI). */
export function isHealth(body: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null) return false;
  const { ok, build } = value as { ok?: unknown; build?: unknown };
  return ok === true && "build" in value && build !== undefined;
}

/** One row of `awui chats`: a chat a `send` or `wait` can address. */
export interface ChatRow {
  chatId: string;
  status: ChatStatus;
  harnessId: string;
  title: string;
  /** The project's folder. */
  project: string;
}

/**
 * The sessions the server holds a live chat for, with that chat's id, status,
 * and project. A session only listed (its harness file, no chat here) is left
 * out: nothing can be sent to it without opening it first.
 */
export function liveChats(overview: SessionsOverview): ChatRow[] {
  const folders = new Map(overview.workspaces.map((w) => [w.id, w.path]));
  const rows: ChatRow[] = [];
  for (const session of overview.sessions) {
    if (!session.liveChatId || !session.status) continue;
    rows.push({ chatId: session.liveChatId, status: session.status, harnessId: session.harnessId, title: session.title, project: folders.get(session.workspaceId) ?? "" });
  }
  return rows;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const chatRoute = (chatId: string, suffix = ""): string => `/api/chats/${encodeURIComponent(chatId)}${suffix}`;

/** The methods that have an effect: only these carry an idempotency key. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * One key per request for this invocation: a call retried within it (its answer lost) is the same
 * request and reuses its key, while another route or another body gets its own — the server
 * refuses one key on two requests (idempotency.ts). A new invocation starts fresh, so nothing is
 * shared between two runs of `awui send`.
 */
const callKeys = new Map<string, string>();
function callKey(method: string, route: string, body: unknown): string {
  const id = `${method} ${route} ${createHash("sha256").update(body === undefined ? "" : JSON.stringify(body)).digest("base64url")}`;
  const known = callKeys.get(id);
  if (known !== undefined) return known;
  const key = randomUUID();
  callKeys.set(id, key);
  return key;
}

async function api<T>(base: string, route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const key = MUTATING.has(method) ? callKey(method, route, init.body) : null;
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (key !== null) headers[IDEMPOTENCY_KEY_HEADER] = key;
  let res: Response;
  try {
    res = await fetch(base + route, {
      method,
      headers,
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
  } catch {
    throw new Error(`cannot reach the awui server at ${base}`);
  }
  if (!res.ok) {
    // The server's own words (a ChatError's message) are the useful part of a refusal.
    const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof data?.error === "string" ? data.error : `the server answered HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The state folder's recorded port as a base URL, when a server wrote one there. */
async function endpointUrl(env: NodeJS.ProcessEnv): Promise<string | null> {
  let stateDir: string;
  try {
    stateDir = loadConfig(env).stateDir;
  } catch {
    return null; // A broken config.yml is the server's problem to report; the default port still gets a try.
  }
  try {
    const endpoint = parseEndpoint(await fs.readFile(path.join(stateDir, ENDPOINT_FILE), "utf8"));
    return endpoint === null ? null : `http://127.0.0.1:${endpoint.port}`;
  } catch {
    return null; // No file: this machine has not run a server since the state folder was made.
  }
}

async function isAwui(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(PROBE_MS) });
    return res.ok && isHealth(await res.text());
  } catch {
    return false;
  }
}

/**
 * The running server: $AWUI_URL when set, else the state folder's server.json,
 * else the default port. It must answer awui's own health, so a stranger on the
 * port is refused rather than driven. Never starts one: a second server over the
 * same state folder would open the same session files.
 */
export async function findServer(env: NodeJS.ProcessEnv): Promise<string> {
  const candidates: string[] = [];
  for (const url of [env.AWUI_URL?.trim().replace(/\/+$/, ""), await endpointUrl(env), `http://127.0.0.1:${DEFAULT_PORT}`]) {
    if (url && !candidates.includes(url)) candidates.push(url);
  }
  for (const base of candidates) if (await isAwui(base)) return base;
  throw new Error(`no awui server answered on ${candidates.join(", ")}: start it with \`awui\`, or set AWUI_URL`);
}

/** The harness for `run` with no --harness: the first available one, the web-only Awui chat surface last. */
async function defaultHarness(base: string): Promise<string> {
  const boot = await api<Bootstrap>(base, "/api/bootstrap");
  const available = boot.harnesses.filter((h) => h.available);
  const pick = available.find((h) => h.id !== "awui") ?? available[0];
  if (!pick) throw new Error("no harness is available on that server (run `awui doctor` there)");
  return pick.id;
}

/** Ask the chat until its run settles; null when the deadline passes first (the run goes on regardless). */
async function waitForSettle(base: string, chatId: string, timeoutSeconds: number): Promise<ChatSnapshot | null> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const snapshot = await api<ChatSnapshot>(base, chatRoute(chatId));
    if (outcomeOf(snapshot).settled) return snapshot;
    if (Date.now() >= deadline) return null;
    await delay(POLL_MS);
  }
}

function jsonOf(snapshot: ChatSnapshot, outcome: Outcome): string {
  const usage: SessionUsage | null = snapshot.usage ?? null;
  return JSON.stringify({
    chatId: snapshot.chatId,
    status: snapshot.status,
    answer: outcome.answer,
    ...(outcome.error === null ? {} : { error: outcome.error }),
    ...(usage === null ? {} : { usage }),
  });
}

/** A settled chat as the command's answer: the reply on stdout, a failure's reason on stderr, the exit code. */
function report(snapshot: ChatSnapshot, json: boolean, io: CliIo): number {
  const outcome = outcomeOf(snapshot);
  if (json) io.out(jsonOf(snapshot, outcome));
  else {
    if (outcome.answer !== "") io.out(outcome.answer);
    if (!outcome.ok) io.err(`awui: ${outcome.error ?? `the run ended (${snapshot.status})`}`);
  }
  return outcome.ok ? EXIT_OK : EXIT_FAILED;
}

async function runChat(command: Extract<Command, { kind: "run" }>, io: CliIo): Promise<number> {
  const base = await findServer(io.env);
  // The server confines a path to its WORKSPACE_ROOTS and opens the project for this chat.
  const workspace = await api<WorkspaceInfo>(base, "/api/workspaces/open", { method: "POST", body: { path: path.resolve(command.project ?? process.cwd()) } });
  const harnessId = command.harness ?? (await defaultHarness(base));
  const created = await api<ChatSnapshot>(base, "/api/chats", { method: "POST", body: { harnessId, workspaceId: workspace.id, ...(command.model ? { model: command.model } : {}) } });
  await api(base, chatRoute(created.chatId, "/messages"), { method: "POST", body: { text: command.prompt } });
  if (!command.wait) {
    // Without --wait there is no answer yet: the id is the whole answer, for `awui wait` or `awui send` next.
    if (command.json) io.out(JSON.stringify({ chatId: created.chatId, status: created.status, answer: "" }));
    else io.out(created.chatId);
    return EXIT_OK;
  }
  // With --wait stdout is the answer alone, so a script can take it whole; the chat id goes to stderr.
  if (!command.json) io.err(`awui: chat ${created.chatId}`);
  const settled = await waitForSettle(base, created.chatId, DEFAULT_WAIT_SECONDS);
  if (settled === null) {
    io.err(`awui: chat ${created.chatId} did not settle within ${DEFAULT_WAIT_SECONDS}s; it is still running there`);
    return EXIT_TIMEOUT;
  }
  return report(settled, command.json, io);
}

async function sendToChat(command: Extract<Command, { kind: "send" }>, io: CliIo): Promise<number> {
  const base = await findServer(io.env);
  await api(base, chatRoute(command.chatId, "/messages"), { method: "POST", body: { text: command.prompt } });
  return EXIT_OK;
}

async function waitOnChat(command: Extract<Command, { kind: "wait" }>, io: CliIo): Promise<number> {
  const base = await findServer(io.env);
  const settled = await waitForSettle(base, command.chatId, command.timeoutSeconds);
  if (settled === null) {
    io.err(`awui: chat ${command.chatId} did not settle within ${command.timeoutSeconds}s; it is still running there`);
    return EXIT_TIMEOUT;
  }
  return report(settled, false, io);
}

async function listChats(command: Extract<Command, { kind: "chats" }>, io: CliIo): Promise<number> {
  const base = await findServer(io.env);
  const rows = liveChats(await api<SessionsOverview>(base, "/api/sessions"));
  if (command.json) io.out(JSON.stringify(rows));
  else if (rows.length === 0) io.err("awui: no chats are open on that server (`awui run` starts one)");
  else for (const row of rows) io.out([row.chatId, row.status, row.harnessId, row.title].join("\t"));
  return EXIT_OK;
}

/** One chat's state as `inspect` prints it, without the whole transcript. */
function inspectOf(snapshot: ChatSnapshot, outcome: Outcome): string {
  return JSON.stringify({
    chatId: snapshot.chatId,
    status: snapshot.status,
    title: snapshot.title,
    harnessId: snapshot.harnessId,
    workspace: snapshot.workspace.path,
    items: snapshot.items.length,
    pending: snapshot.pending.length,
    queue: snapshot.queue.steering.length + snapshot.queue.followUp.length,
    answer: outcome.answer,
    ...(outcome.error === null ? {} : { error: outcome.error }),
    ...(snapshot.usage === null ? {} : { usage: snapshot.usage }),
  });
}

async function inspectChat(command: Extract<Command, { kind: "inspect" }>, io: CliIo): Promise<number> {
  const base = await findServer(io.env);
  const snapshot = await api<ChatSnapshot>(base, chatRoute(command.chatId));
  const outcome = outcomeOf(snapshot);
  if (command.json) io.out(inspectOf(snapshot, outcome));
  else {
    io.out([snapshot.chatId, snapshot.status, snapshot.harnessId, snapshot.title].join("\t"));
    io.out(`items ${snapshot.items.length} · pending ${snapshot.pending.length} · queue ${snapshot.queue.steering.length + snapshot.queue.followUp.length} · ${snapshot.workspace.path}`);
    if (outcome.answer !== "") io.out(outcome.answer);
    if (outcome.error !== null) io.err(`awui: ${outcome.error}`);
  }
  return outcome.error === null ? EXIT_OK : EXIT_FAILED;
}

/** One transcript item as `logs` prints it: kind, then the text (a tool call names its target). */
function logLine(item: ChatItem): string {
  if (item.kind === "tool") return `tool\t${item.name}\t${item.summary}`;
  if (item.kind === "notice") return `notice\t${item.level}\t${item.text}`;
  if (item.kind === "request") return `request\t${item.request.title}${item.request.message ? ` — ${item.request.message}` : ""}`;
  return `${item.kind}\t${item.text}`;
}

async function logsOfChat(command: Extract<Command, { kind: "logs" }>, io: CliIo): Promise<number> {
  const base = await findServer(io.env);
  const snapshot = await api<ChatSnapshot>(base, chatRoute(command.chatId));
  const items = command.tail === null ? snapshot.items : snapshot.items.slice(-command.tail);
  if (command.json) io.out(JSON.stringify(items));
  else if (items.length === 0) io.err("awui: the chat has no transcript yet");
  else for (const item of items) io.out(logLine(item));
  return EXIT_OK;
}

async function attachSession(command: Extract<Command, { kind: "attach" }>, io: CliIo): Promise<number> {
  const base = await findServer(io.env);
  // The workspace is resolved from the session list, never guessed: the server refuses a
  // session that is not in the workspace it names (resume throws session_not_found).
  const overview = await api<SessionsOverview>(base, "/api/sessions");
  const session = overview.sessions.find((row) => row.id === command.sessionId);
  if (!session) {
    io.err(`awui: no session ${command.sessionId} on that server (see \`awui chats --json\`, whose live rows name their sessions)`);
    return EXIT_FAILED;
  }
  const created = await api<ChatSnapshot>(base, "/api/chats/resume", {
    method: "POST",
    body: { harnessId: command.harness, workspaceId: session.workspaceId, sessionId: command.sessionId, ...(command.reclaim ? { reclaim: true } : {}), ...(command.ignoreHerdr ? { ignoreHerdr: true } : {}) },
  });
  if (command.json) io.out(JSON.stringify({ chatId: created.chatId, status: created.status, title: created.title }));
  else io.out(created.chatId);
  return EXIT_OK;
}

/** `awui run|send|wait|chats`: the exit code, after printing what the command found. */
export async function runHeadlessCli(args: string[], io: CliIo): Promise<number> {
  const command = parseCommand(args);
  if ("error" in command) {
    io.err(`awui: ${command.error}`);
    io.err(CLI_USAGE);
    return EXIT_USAGE;
  }
  if (command.kind === "help") {
    io.out(CLI_USAGE);
    return EXIT_OK;
  }
  try {
    switch (command.kind) {
      case "run":
        return await runChat(command, io);
      case "send":
        return await sendToChat(command, io);
      case "wait":
        return await waitOnChat(command, io);
      case "chats":
        return await listChats(command, io);
      case "inspect":
        return await inspectChat(command, io);
      case "logs":
        return await logsOfChat(command, io);
      case "attach":
        return await attachSession(command, io);
    }
  } catch (error) {
    io.err(`awui: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
}
