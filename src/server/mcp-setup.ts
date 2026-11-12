// What each harness needs before awui's own tools (`render_html` and the
// orchestration tools) reach its chats, and the one harness whose step is not
// automatic. Most adapters hand a chat its server themselves — a command-line
// flag, a session parameter, an `-e` extension, a runtime registration — so the
// user configures nothing. Hermes mounts MCP servers only from its own config, so
// it needs one entry, added with Hermes's own CLI: awui prints that command and,
// with `--apply`, runs it after asking. Nothing here edits a harness's config.
//
// `awui setup mcp` is the whole surface: the builder and renderer are pure
// (unit-tested against fake probes), the probing is bounded and calls no model,
// and the CLI in index.ts only parses flags and prints.
import { embeddedVersion } from "./embedded.js";
import { execHarness } from "./platform-win.js";
import { nodeForMcpServers } from "./harness/render-extension.js";
import { bridgeCommand, type BridgeCommand } from "./mcp-bridge.js";

/** Bounds for a harness's own commands: a list may take this long, and its output is cut here. */
const PROBE_TIMEOUT_MS = 20_000;
const APPLY_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 256 * 1024;

/**
 * How one harness's chats get awui's tools: `automatic` (its adapter passes them,
 * per chat) or `one-time` (one entry in the harness's own config).
 */
export type McpSetupKind = "automatic" | "one-time";

/** What a harness's own config already holds for awui, as its own list command showed it. */
export interface OneTimeExisting {
  verdict: "missing" | "ours" | "other" | "unknown";
  /** The entry's own line from that list (`awui mcp`, a truncated cell, another command). */
  transport: string | null;
  /** Why the list could not be read, for `unknown`. */
  reason: string | null;
}

export interface McpSetupEntry {
  harnessId: string;
  displayName: string;
  /** False when the harness is not installed here: the report says so and prints no instruction. */
  installed: boolean;
  kind: McpSetupKind;
  /** One sentence: how the tools arrive, or what the one-time step does. */
  detail: string;
  /** The one-time step as a runnable command, its own executable first; empty for an automatic harness. */
  argv: string[];
  /** What its own config already holds; null for an automatic harness. */
  existing: OneTimeExisting | null;
}

/** What `hermes mcp list` said about an entry named `awui`. */
export type HermesMcpList = { known: false; reason: string } | { known: true; transport: string | null };

export interface McpSetupInput {
  /** Every harness awui probes (the doctor's own list): id, name, and whether it is installed. */
  harnesses: { id: string; displayName: string; installed: boolean }[];
  /** awui's own command, or null when awui cannot be found to name one. */
  bridge: BridgeCommand | null;
  /** The Hermes CLI to run (config.yml's `harnesses.hermes.command`, else `hermes`). */
  hermesBin: string;
  hermes: HermesMcpList;
}

export interface McpSetupReport {
  bridge: BridgeCommand | null;
  entries: McpSetupEntry[];
  /** A footer about this machine (no Node for the stdio bridges), or null. */
  note: string | null;
}

/**
 * How each harness gets awui's tools, in its adapter's own terms. A harness not
 * in this table is reported as having nothing known, which
 * tests/unit/mcp-setup.test.ts refuses: a new harness adds its line here.
 */
const HOW: Record<string, string> = {
  pi: "an `-e` extension loaded on the chat's command line",
  omp: "an `-e` extension loaded on the chat's command line",
  claude: "`--mcp-config` on the chat's command line: awui's HTTP MCP endpoint, or the stdio bridge",
  codex: "`-c mcp_servers.*` flags on the chat's command line: awui's HTTP MCP endpoint, or the stdio bridge",
  dsh: "the session's `mcpServers` entry: awui's HTTP MCP endpoint, or the stdio bridge",
  grok: "the session's `mcpServers` entry, on `session/new` and `session/load`",
  opencode: "registered on its own shared server per chat, scoped by that session's permission rules",
  awui: "its own read-only chat loads `render_html` and `eval_python`; the orchestration tools are withheld by design",
};

/** Why Hermes is the one manual step, said the same way everywhere. */
const HERMES_WHY =
  "Hermes mounts MCP servers only from its own config, and one gateway owns its whole profile: awui cannot give a single chat its two variables there yet, so this entry is inert until it can";

/** The Hermes entry awui asks for: awui's bridge, with the chat's variables interpolated by Hermes itself. */
export function hermesSetupArgv(hermesBin: string, bridgeCommand: string): string[] {
  return [
    hermesBin,
    "mcp",
    "add",
    "awui",
    "--command",
    bridgeCommand,
    // Hermes expands ${VAR} from the environment of the process that starts the
    // server, so awui passes these placeholders literally: no token is written.
    "--env",
    "AWUI_ORCH_URL=${AWUI_ORCH_URL}",
    "AWUI_ORCH_TOKEN=${AWUI_ORCH_TOKEN}",
    // `--args` takes every argument after it, so it comes last.
    "--args",
    "mcp",
  ];
}

/**
 * `hermes mcp list`, parsed: the transport cell of the row named `awui`. The table
 * truncates a long command, so a transport is only compared when it is whole.
 */
export function parseHermesMcpList(text: string): { found: boolean; transport: string | null } {
  for (const line of text.split("\n")) {
    const cells = line.trim().split(/\s{2,}/);
    if (cells[0] === "awui") return { found: true, transport: cells[1] ?? null };
  }
  return { found: false, transport: null };
}

/**
 * Whether a listed transport runs awui's bridge: `awui mcp`, or a path ending in `/awui mcp`. The
 * path is matched whole rather than by splitting on spaces, since a program can live in a folder
 * whose name has one ("/home/u/My Apps/awui").
 */
export function isAwuiBridgeTransport(transport: string | null): boolean {
  if (transport === null) return false;
  return /(^|[/\\])awui(\.exe)? mcp$/i.test(transport.trim());
}

/** The entries, from what the probes found. Pure: every machine fact arrives in the input. */
export function buildMcpSetup(input: McpSetupInput): McpSetupReport {
  const entries: McpSetupEntry[] = [];
  for (const harness of input.harnesses) {
    if (!harness.installed) {
      entries.push({ harnessId: harness.id, displayName: harness.displayName, installed: false, kind: "automatic", detail: "not installed", argv: [], existing: null });
      continue;
    }
    if (harness.id === "hermes") {
      entries.push({
        harnessId: harness.id,
        displayName: harness.displayName,
        installed: true,
        kind: "one-time",
        detail: HERMES_WHY,
        argv: input.bridge ? hermesSetupArgv(input.hermesBin, input.bridge.command) : [],
        existing: hermesExisting(input.hermes),
      });
      continue;
    }
    entries.push({
      harnessId: harness.id,
      displayName: harness.displayName,
      installed: true,
      kind: "automatic",
      detail: HOW[harness.id] ?? "nothing known: awui's tools are not wired into this harness",
      argv: [],
      existing: null,
    });
  }
  return { bridge: input.bridge, entries, note: machineNote(input) };
}

function hermesExisting(list: HermesMcpList): OneTimeExisting {
  if (!list.known) return { verdict: "unknown", transport: null, reason: list.reason };
  if (list.transport === null) return { verdict: "missing", transport: null, reason: null };
  // A truncated cell cannot be compared: count it as awui's own entry rather than
  // offer to add a second one over a command nobody can read.
  if (list.transport.endsWith("…") || list.transport.endsWith("...") || isAwuiBridgeTransport(list.transport)) {
    return { verdict: "ours", transport: list.transport, reason: null };
  }
  return { verdict: "other", transport: list.transport, reason: null };
}

/** One footer line about something on this machine that changes the answer, or null. */
function machineNote(input: McpSetupInput): string | null {
  if (input.bridge === null) return "awui itself cannot be found, so no command can be printed for a harness config: run `awui setup mcp` from the installed `awui`.";
  if (nodeForMcpServers() === null) return "no Node is on the PATH: the harnesses that run awui's bridge as a program (Grok Build, OpenCode) get none of awui's tools.";
  return null;
}

/** A word a shell can run as-is, quoted only when it must be. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The whole command for a one-time step, as a shell would read it. */
export function commandText(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** One line naming what a one-time entry's own config already holds. */
function existingWords(existing: OneTimeExisting): string {
  if (existing.verdict === "ours") return "already set up";
  if (existing.verdict === "other") return `a different entry already exists (${existing.transport ?? "unknown command"})`;
  if (existing.verdict === "unknown") return `could not check (${existing.reason ?? "its own list command failed"})`;
  return "not set up yet";
}

/** The report as plain text, for a terminal. */
export function renderSetup(report: McpSetupReport): string {
  const width = Math.max(0, ...report.entries.map((e) => e.displayName.length));
  const pad = (name: string) => name.padEnd(width);
  const lines = [
    "awui's own tools reach a chat through its harness: per chat where the adapter can pass them, else by one entry in the harness's own config.",
    // Which awui a harness config should name, and how it was found: a stale copy on the PATH is a common surprise.
    ...(report.bridge ? [`awui's command for a harness config: ${report.bridge.command} (${report.bridge.source})`] : []),
    "",
  ];
  for (const entry of report.entries) {
    if (!entry.installed) {
      lines.push(`  - ${pad(entry.displayName)}  not installed`);
      continue;
    }
    if (entry.kind === "automatic") {
      lines.push(`  ✓ ${pad(entry.displayName)}  automatic: ${entry.detail}`);
      continue;
    }
    const existing = entry.existing ?? { verdict: "unknown" as const, transport: null, reason: null };
    lines.push(`  ${existing.verdict === "ours" ? "✓" : "!"} ${pad(entry.displayName)}  one-time setup: ${existingWords(existing)}`);
    lines.push(`      ${entry.detail}`);
    if (entry.argv.length > 0 && existing.verdict !== "ours") lines.push(`      ${commandText(entry.argv)}`);
    if (entry.argv.length > 0 && existing.verdict !== "ours") lines.push("      (`awui setup mcp --apply` runs that command after asking)");
    if (existing.verdict === "other") lines.push("      (`hermes mcp remove awui` takes the other entry away)");
  }
  if (report.note) lines.push("", `  ! ${report.note}`);
  lines.push("", "Nothing here edits a harness's config: a one-time step is the harness's own command.");
  return lines.join("\n");
}

/** The report as JSON, for scripts: the same data the text names. */
export function setupJson(report: McpSetupReport): string {
  return JSON.stringify({ version: embeddedVersion ?? "dev", ...report }, null, 2);
}

/** `hermes mcp list` as this report reads it: bounded, no shell, stdin closed so its own prompts cannot wait. */
export async function readHermesMcpList(bin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HermesMcpList> {
  try {
    const { stdout } = await execHarness(bin, ["mcp", "list"], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, closeStdin: true });
    return { known: true, transport: parseHermesMcpList(stdout).transport };
  } catch (error) {
    return { known: false, reason: failureText(error) };
  }
}

/** An exec failure's own words: the harness's stderr, which is where it says why. */
function failureText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim().split("\n").slice(-3).join(" ");
  return error instanceof Error ? error.message : String(error);
}

/**
 * The report for this machine: each harness's availability (already probed, as the
 * doctor has it) and what Hermes's own config holds. The Hermes list is only asked
 * when Hermes is installed, so no missing CLI is spawned.
 */
export async function gatherMcpSetup(input: {
  harnesses: { id: string; displayName: string; available: boolean }[];
  hermesBin: string;
  bridge?: BridgeCommand | null;
  env?: NodeJS.ProcessEnv;
}): Promise<McpSetupReport> {
  const installed = input.harnesses.map((h) => ({ id: h.id, displayName: h.displayName, installed: h.available }));
  const hermes = installed.some((h) => h.id === "hermes" && h.installed)
    ? await readHermesMcpList(input.hermesBin)
    : ({ known: false, reason: "Hermes is not installed" } as const);
  return buildMcpSetup({ harnesses: installed, bridge: input.bridge === undefined ? bridgeCommand(input.env) : input.bridge, hermesBin: input.hermesBin, hermes });
}

export interface ApplyResult {
  ok: boolean;
  /** What the one-time step left behind, as its own list now shows it. */
  existing: OneTimeExisting;
  /** The harness's own words when it failed, or null. */
  error: string | null;
}

/**
 * Run a one-time step through the harness's own CLI: never by editing a config file.
 * An entry that is already there is left alone; one with another command is never
 * overwritten; a step that cannot be checked first is not run at all.
 */
export async function applyOneTimeSetup(
  entry: McpSetupEntry,
  options: {
    /** Print a line (the CLI's stdout). */
    log: (line: string) => void;
    /** Ask before running, or null when there is nothing to ask on (`--yes`, or no TTY). */
    ask: ((command: string) => Promise<boolean>) | null;
    timeoutMs?: number;
  },
): Promise<ApplyResult> {
  const existing = entry.existing ?? { verdict: "unknown" as const, transport: null, reason: null };
  if (entry.kind !== "one-time" || entry.argv.length === 0) {
    options.log(`${entry.displayName}: nothing to set up.`);
    return { ok: true, existing, error: null };
  }
  const command = commandText(entry.argv);
  if (existing.verdict === "ours") {
    options.log(`${entry.displayName}: already set up, leaving its own entry alone.`);
    return { ok: true, existing, error: null };
  }
  if (existing.verdict === "other") {
    options.log(`${entry.displayName}: its config already has an entry named awui (${existing.transport ?? "unknown command"}), and awui will not overwrite it.`);
    options.log(`Remove it with \`${entry.argv[0] ?? "hermes"} mcp remove awui\` and run this again.`);
    return { ok: false, existing, error: null };
  }
  if (existing.verdict === "unknown") {
    options.log(`${entry.displayName}: could not read its own MCP list (${existing.reason ?? "the list command failed"}), so nothing was run.`);
    return { ok: false, existing, error: existing.reason };
  }
  options.log(`  ${command}`);
  if (options.ask === null) {
    options.log("Not run: no terminal to ask on. Use --yes in a script.");
    return { ok: false, existing, error: null };
  }
  if (!(await options.ask(command))) {
    options.log("Not run.");
    return { ok: false, existing, error: null };
  }
  const bin = entry.argv[0] ?? "hermes";
  try {
    await execHarness(bin, entry.argv.slice(1), { timeout: options.timeoutMs ?? APPLY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, closeStdin: true });
  } catch (error) {
    const text = failureText(error);
    options.log(`${entry.displayName}: its own command failed: ${text}`);
    return { ok: false, existing, error: text };
  }
  const after = await readHermesMcpList(bin);
  const landed = hermesExisting(after);
  if (landed.verdict !== "ours") {
    const text = after.known ? `its list does not show the entry (${after.transport ?? "no row named awui"})` : after.reason;
    options.log(`${entry.displayName}: the command ran, but ${text}`);
    return { ok: false, existing: landed, error: text };
  }
  options.log(`✓ ${entry.displayName}: saved to its own config (${landed.transport ?? "awui"}).`);
  // The bridge is inert outside awui, so this connects and discovers no tool; a
  // failure here is the harness's own words about an entry it cannot run.
  try {
    const { stdout } = await execHarness(bin, ["mcp", "test", "awui"], { timeout: options.timeoutMs ?? APPLY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, closeStdin: true });
    const last = stdout.trim().split("\n").filter((line) => line.trim()).slice(-1)[0];
    if (last) options.log(`  ${last.trim()}`);
  } catch (error) {
    const text = failureText(error);
    options.log(`${entry.displayName}: \`${bin} mcp test awui\` failed: ${text}`);
    return { ok: false, existing: landed, error: text };
  }
  return { ok: true, existing: landed, error: null };
}
