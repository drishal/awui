// `awui setup mcp`: what each harness needs before awui's own tools reach its
// chats, and the one harness whose step is its own command. The builder and
// renderer are pure; the two commands that touch the machine (a harness's own
// `mcp list` and `mcp add`) run against a fake `hermes` on a scratch PATH, which
// records its argv, so nothing here reads or writes a real Hermes home.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOneTimeSetup,
  buildMcpSetup,
  commandText,
  isAwuiBridgeTransport,
  parseHermesMcpList,
  readHermesMcpList,
  renderSetup,
  type McpSetupEntry,
  type McpSetupInput,
} from "../../src/server/mcp-setup.js";
import { loadConfig } from "../../src/server/config.js";
import { tempDir } from "../helpers/app.js";

const HERMES_LIST = `  MCP Servers:

  Name             Transport                      Tools        Status    
  ──────────────── ────────────────────────────── ──────────── ──────────
  awui             /home/u/.local/bin/awui mcp    all          ✓ enabled
`;

const HERMES_OTHER = `  MCP Servers:

  Name             Transport                      Tools        Status    
  ──────────────── ────────────────────────────── ──────────── ──────────
  awui             /usr/bin/something-else mcp    all          ✓ enabled
`;

const INSTALLED = [
  { id: "pi", displayName: "Pi", installed: true },
  { id: "hermes", displayName: "Hermes", installed: true },
];

function input(overrides: Partial<McpSetupInput> = {}): McpSetupInput {
  return {
    harnesses: INSTALLED,
    bridge: { command: "/home/u/.local/bin/awui", source: "the awui on your PATH" },
    hermesBin: "hermes",
    hermes: { known: true, transport: null },
    ...overrides,
  };
}

const hermesEntry = (report: ReturnType<typeof buildMcpSetup>): McpSetupEntry => report.entries.find((e) => e.harnessId === "hermes")!;

describe("the per-harness report", () => {
  it("names the automatic harnesses, and one one-time step for Hermes", () => {
    const report = buildMcpSetup(input());
    const pi = report.entries.find((e) => e.harnessId === "pi")!;
    expect(pi).toMatchObject({ kind: "automatic", installed: true });
    expect(pi.detail).toContain("-e");
    const hermes = hermesEntry(report);
    expect(hermes).toMatchObject({ kind: "one-time", installed: true });
    expect(hermes.existing).toEqual({ verdict: "missing", transport: null, reason: null });
    // The entry is Hermes's own command, with `--args` last because it takes everything after it.
    expect(hermes.argv).toEqual([
      "hermes",
      "mcp",
      "add",
      "awui",
      "--command",
      "/home/u/.local/bin/awui",
      "--env",
      "AWUI_ORCH_URL=${AWUI_ORCH_URL}",
      "AWUI_ORCH_TOKEN=${AWUI_ORCH_TOKEN}",
      "--args",
      "mcp",
    ]);
    expect(hermes.argv.at(-2)).toBe("--args");
  });

  it("knows every harness awui ships, so a new one cannot be left out", () => {
    const shipped = loadConfig({}).harnesses;
    const report = buildMcpSetup({ ...input(), harnesses: shipped.map((id) => ({ id, displayName: id, installed: true })) });
    for (const entry of report.entries) {
      expect(entry.detail).not.toContain("nothing known");
    }
    expect(report.entries.map((e) => e.harnessId).sort()).toEqual([...shipped].sort());
  });

  it("says a harness is not installed instead of giving it instructions", () => {
    const report = buildMcpSetup(input({ harnesses: [{ id: "hermes", displayName: "Hermes", installed: false }] }));
    expect(report.entries[0]).toMatchObject({ installed: false, argv: [] });
    expect(renderSetup(report)).toContain("- Hermes");
    expect(renderSetup(report)).toContain("not installed");
  });

  it("reads an existing entry as awui's own, another's, or unreadable", () => {
    expect(hermesEntry(buildMcpSetup(input({ hermes: { known: true, transport: "/home/u/.local/bin/awui mcp" } }))).existing?.verdict).toBe("ours");
    expect(hermesEntry(buildMcpSetup(input({ hermes: { known: true, transport: "/usr/bin/something-else mcp" } }))).existing).toMatchObject({ verdict: "other", transport: "/usr/bin/something-else mcp" });
    expect(hermesEntry(buildMcpSetup(input({ hermes: { known: false, reason: "hermes not found" } }))).existing).toMatchObject({ verdict: "unknown", reason: "hermes not found" });
    // A table cell the list truncated cannot be compared: it counts as awui's own.
    expect(hermesEntry(buildMcpSetup(input({ hermes: { known: true, transport: "/home/u/.local/bin/..." } }))).existing?.verdict).toBe("ours");
  });

  it("prints no command when awui itself cannot be found", () => {
    const report = buildMcpSetup(input({ bridge: null }));
    expect(hermesEntry(report).argv).toEqual([]);
    expect(report.note).toContain("awui itself cannot be found");
    expect(renderSetup(report)).not.toContain("hermes mcp add");
  });

  it("renders each state, and the way back from a foreign entry", () => {
    const missing = renderSetup(buildMcpSetup(input()));
    expect(missing).toContain("! Hermes");
    expect(missing).toContain("one-time setup: not set up");
    expect(missing).toContain("hermes mcp add awui --command /home/u/.local/bin/awui");
    // A shell would read the placeholders literally, so they are quoted.
    expect(missing).toContain("'AWUI_ORCH_URL=${AWUI_ORCH_URL}'");
    expect(missing).toContain("✓ Pi");
    expect(missing).toContain("automatic: an `-e` extension");
    expect(missing).toContain("awui setup mcp --apply");

    const ours = renderSetup(buildMcpSetup(input({ hermes: { known: true, transport: "awui mcp" } })));
    expect(ours).toContain("✓ Hermes");
    expect(ours).toContain("one-time setup: already set up");
    expect(ours).not.toContain("hermes mcp add");

    const other = renderSetup(buildMcpSetup(input({ hermes: { known: true, transport: "/usr/bin/something-else mcp" } })));
    expect(other).toContain("a different entry already exists (/usr/bin/something-else mcp)");
    expect(other).toContain("hermes mcp remove awui");

    const unknown = renderSetup(buildMcpSetup(input({ hermes: { known: false, reason: "timed out" } })));
    expect(unknown).toContain("could not check (timed out)");
  });
});

describe("Hermes's own MCP list", () => {
  it("takes the row named awui and nothing else", () => {
    expect(parseHermesMcpList(HERMES_LIST)).toEqual({ found: true, transport: "/home/u/.local/bin/awui mcp" });
    expect(parseHermesMcpList(HERMES_OTHER).transport).toBe("/usr/bin/something-else mcp");
    expect(parseHermesMcpList("  No MCP servers configured.\n")).toEqual({ found: false, transport: null });
  });

  it("tells awui's bridge apart from any other program", () => {
    expect(isAwuiBridgeTransport("/home/u/.local/bin/awui mcp")).toBe(true);
    expect(isAwuiBridgeTransport("awui mcp")).toBe(true);
    expect(isAwuiBridgeTransport("C:\\bin\\awui.exe mcp")).toBe(true);
    expect(isAwuiBridgeTransport("/usr/bin/something-else mcp")).toBe(false);
    expect(isAwuiBridgeTransport("/usr/bin/awui-other mcp")).toBe(false);
    // A folder whose own name has a space: splitting the cell into words read this as someone else's.
    expect(isAwuiBridgeTransport("/home/u/My Apps/awui mcp")).toBe(true);
    expect(isAwuiBridgeTransport("C:\\Program Files\\awui\\awui.exe mcp")).toBe(true);
    expect(isAwuiBridgeTransport("awui mcp --verbose")).toBe(false);
    expect(isAwuiBridgeTransport("awui serve")).toBe(false);
    expect(isAwuiBridgeTransport(null)).toBe(false);
  });

  it("quotes only what a shell would misread", () => {
    expect(commandText(["awui", "mcp"])).toBe("awui mcp");
    expect(commandText(["/home/u/my awui", "mcp"])).toBe("'/home/u/my awui' mcp");
    expect(commandText(["hermes", "mcp", "add", "awui", "--env", "A=${B}"])).toBe("hermes mcp add awui --env 'A=${B}'");
  });
});

/** A `hermes` stand-in on a scratch PATH: it records its argv and answers the three MCP commands. */
function fakeHermes(): { bin: string; state: string } {
  const dir = tempDir("awui-fake-hermes-");
  const state = path.join(dir, "state");
  mkdirSync(state, { recursive: true });
  const bin = path.join(dir, "hermes");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const state = process.env.FAKE_HERMES_STATE;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(state, "calls.log"), JSON.stringify(argv) + "\\n");
const list = path.join(state, "list.txt");
const command = argv[0] === "mcp" ? argv[1] : "";
if (command === "list") {
  process.stdout.write(fs.existsSync(list) ? fs.readFileSync(list, "utf8") : "  No MCP servers configured.\\n");
  if (process.env.FAKE_HERMES_LIST_EXIT) process.exit(Number(process.env.FAKE_HERMES_LIST_EXIT));
} else if (command === "add") {
  if (process.env.FAKE_HERMES_ADD_EXIT) {
    process.stderr.write("hermes: could not write its config\\n");
    process.exit(Number(process.env.FAKE_HERMES_ADD_EXIT));
  }
  const target = argv[argv.indexOf("--command") + 1];
  fs.writeFileSync(list, "  Name             Transport                      Tools        Status\\n  awui             " + path.basename(target) + " mcp    all          enabled\\n");
  process.stdout.write("  Saved 'awui' to config\\n");
} else if (command === "test") {
  process.stdout.write("  Testing 'awui'...\\n  Connected (12ms)\\n  Tools discovered: 0\\n");
} else {
  process.exit(64);
}
`,
  );
  chmodSync(bin, 0o755);
  return { bin, state };
}

const savedEnv = { FAKE_HERMES_STATE: process.env.FAKE_HERMES_STATE, FAKE_HERMES_ADD_EXIT: process.env.FAKE_HERMES_ADD_EXIT, FAKE_HERMES_LIST_EXIT: process.env.FAKE_HERMES_LIST_EXIT };

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The argv the fake was run with, in order. */
function calls(state: string): string[][] {
  const file = path.join(state, "calls.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

describe("an entry's own command", () => {
  it("is read through the harness, bounded, and answers unknown when it cannot be read", async () => {
    const fake = fakeHermes();
    process.env.FAKE_HERMES_STATE = fake.state;
    expect(await readHermesMcpList(fake.bin)).toEqual({ known: true, transport: null });
    writeFileSync(path.join(fake.state, "list.txt"), HERMES_LIST);
    expect(await readHermesMcpList(fake.bin)).toEqual({ known: true, transport: "/home/u/.local/bin/awui mcp" });
    process.env.FAKE_HERMES_LIST_EXIT = "1";
    const refused = await readHermesMcpList(fake.bin);
    expect(refused.known).toBe(false);
    expect(calls(fake.state)).toEqual([["mcp", "list"], ["mcp", "list"], ["mcp", "list"]]);
  });

  it("runs once, with exactly the printed argv, and reports what landed", async () => {
    const fake = fakeHermes();
    process.env.FAKE_HERMES_STATE = fake.state;
    const entry = hermesEntry(buildMcpSetup(input({ hermesBin: fake.bin })));
    const log: string[] = [];
    const result = await applyOneTimeSetup(entry, { log: (line) => log.push(line), ask: async () => true });
    expect(result.ok).toBe(true);
    expect(result.existing.verdict).toBe("ours");
    expect(calls(fake.state)).toEqual([["mcp", "add", "awui", "--command", "/home/u/.local/bin/awui", "--env", "AWUI_ORCH_URL=${AWUI_ORCH_URL}", "AWUI_ORCH_TOKEN=${AWUI_ORCH_TOKEN}", "--args", "mcp"], ["mcp", "list"], ["mcp", "test", "awui"]]);
    // The printed command is the one that ran, placeholders quoted so no shell expands them.
    expect(log[0]).toContain("'AWUI_ORCH_URL=${AWUI_ORCH_URL}'");
    expect(log.join("\n")).toContain("saved to its own config");
    expect(log.join("\n")).toContain("Tools discovered: 0");
  });

  it("leaves an entry that is already there alone", async () => {
    const fake = fakeHermes();
    process.env.FAKE_HERMES_STATE = fake.state;
    writeFileSync(path.join(fake.state, "list.txt"), HERMES_LIST);
    const entry = hermesEntry(buildMcpSetup({ ...input({ hermesBin: fake.bin }), hermes: await readHermesMcpList(fake.bin) }));
    const log: string[] = [];
    const result = await applyOneTimeSetup(entry, { log: (line) => log.push(line), ask: async () => true });
    expect(result).toMatchObject({ ok: true, existing: { verdict: "ours" } });
    expect(log.join("\n")).toContain("already set up");
    expect(calls(fake.state)).toEqual([["mcp", "list"]]);
  });

  it("never overwrites an entry with another command", async () => {
    const fake = fakeHermes();
    process.env.FAKE_HERMES_STATE = fake.state;
    writeFileSync(path.join(fake.state, "list.txt"), HERMES_OTHER);
    const entry = hermesEntry(buildMcpSetup({ ...input({ hermesBin: fake.bin }), hermes: await readHermesMcpList(fake.bin) }));
    const log: string[] = [];
    const result = await applyOneTimeSetup(entry, { log: (line) => log.push(line), ask: async () => true });
    expect(result.ok).toBe(false);
    expect(log.join("\n")).toContain("/usr/bin/something-else mcp");
    expect(log.join("\n")).toContain("mcp remove awui");
    expect(calls(fake.state)).toEqual([["mcp", "list"]]);
  });

  it("runs nothing when the list cannot be read, or without a terminal to ask on", async () => {
    const fake = fakeHermes();
    process.env.FAKE_HERMES_STATE = fake.state;
    process.env.FAKE_HERMES_LIST_EXIT = "2";
    const unreadable = hermesEntry(buildMcpSetup({ ...input({ hermesBin: fake.bin }), hermes: await readHermesMcpList(fake.bin) }));
    const log: string[] = [];
    expect((await applyOneTimeSetup(unreadable, { log: (line) => log.push(line), ask: async () => true })).ok).toBe(false);
    expect(log.join("\n")).toContain("could not read");
    expect(calls(fake.state)).toEqual([["mcp", "list"]]);

    process.env.FAKE_HERMES_LIST_EXIT = "0";
    const entry = hermesEntry(buildMcpSetup(input({ hermesBin: fake.bin })));
    const noTty: string[] = [];
    expect((await applyOneTimeSetup(entry, { log: (line) => noTty.push(line), ask: null })).ok).toBe(false);
    expect(noTty.join("\n")).toContain("no terminal to ask on");
    expect(noTty.join("\n")).toContain("hermes mcp add awui");
    // Only the probe for the unreadable case ran; nothing was added either time.
    expect(calls(fake.state)).toEqual([["mcp", "list"]]);
  });

  it("reports the harness's own error, and a declined question runs nothing", async () => {
    const fake = fakeHermes();
    process.env.FAKE_HERMES_STATE = fake.state;
    const entry = hermesEntry(buildMcpSetup(input({ hermesBin: fake.bin })));
    const declined: string[] = [];
    expect((await applyOneTimeSetup(entry, { log: (line) => declined.push(line), ask: async () => false })).ok).toBe(false);
    expect(declined.join("\n")).toContain("Not run.");
    expect(calls(fake.state)).toEqual([]);

    process.env.FAKE_HERMES_ADD_EXIT = "3";
    const failed: string[] = [];
    const result = await applyOneTimeSetup(entry, { log: (line) => failed.push(line), ask: async () => true });
    expect(result.ok).toBe(false);
    expect(failed.join("\n")).toContain("could not write its config");
  });
});
