import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings, writeSettings, type SettingsContext } from "../../src/server/settings.js";
import { settingsPatchSchema } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

function setup(yaml: string, overrides: Partial<SettingsContext> = {}) {
  const home = tempDir("awui-settings-");
  const dir = path.join(home, ".config", "awui");
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(home, "code"));
  const file = path.join(dir, "config.yml");
  if (yaml) writeFileSync(file, yaml);
  const ctx: SettingsContext = {
    configDir: dir,
    running: { port: 4783, host: "127.0.0.1", username: "", password: null, workspaceRoots: [home], allowedHosts: [], allowedTailscaleUsers: [], acpAgents: "[]" },
    envSet: new Set(),
    credentialsFile: path.join(home, "credentials.json"),
    canRestart: false,
    home,
    ...overrides,
  };
  return { ctx, file, home };
}

const FILE = `# My awui settings
port: 4783 # the usual port
theme: base16
autocollapse_sidebar: true
`;

describe("settings", () => {
  it("reads config.yml with defaults for what it leaves out", () => {
    const { ctx } = setup(FILE);
    const view = readSettings(ctx, true);
    expect(view).toMatchObject({ editable: true, writable: true, restartPending: [], envOverrides: [], canRestart: false });
    expect(view.values).toEqual({
      port: 4783,
      host: "127.0.0.1",
      username: "",
      hasPassword: false,
      workspaceRoots: [],
      allowedHosts: [],
      allowedTailscaleUsers: [],
      theme: "base16",
      textScale: null,
      chatWidth: null,
      density: null,
      toolStyle: null,
      font: null,
      autocollapseSidebar: true,
      showStatusBar: true,
      herdr: true,
      desktopBackground: true,
      orchestrationEnabled: true,
      agentProfiles: [],
      acpAgents: [],
    });
  });

  it("rewrites the file in place, keeping comments, and says what waits for a restart", () => {
    const { ctx, file, home } = setup(FILE);
    const code = path.join(home, "code");
    const view = writeSettings(ctx, { port: 4800, theme: null, textScale: 1.22, chatWidth: "wide", density: "compact", autocollapseSidebar: false, showStatusBar: false, herdr: false, desktopBackground: false, workspaceRoots: [code] });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# My awui settings");
    expect(text).toContain("port: 4800 # the usual port");
    expect(text).not.toContain("theme:");
    expect(text).toContain("text_scale: 1.22");
    expect(text).toContain("chat_width: wide");
    expect(text).toContain("density: compact");
    expect(text).toContain("autocollapse_sidebar: false");
    expect(text).toContain("show_status_bar: false");
    expect(text).toContain("herdr: false");
    expect(text).toContain("desktop_background: false");
    expect(text).toContain(`workspace_roots:\n  - ${code}`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(view.values).toMatchObject({ port: 4800, theme: null, textScale: 1.22, chatWidth: "wide", density: "compact", autocollapseSidebar: false, showStatusBar: false, herdr: false, desktopBackground: false });
    // Port and roots take a restart; theme, text size, width, folding, and herdr apply on the next page load.
    expect(view.restartPending).toEqual(["port", "workspaceRoots"]);
    // Back to comfortable, the default, leaves no setting behind.
    expect(writeSettings(ctx, { chatWidth: null }).values.chatWidth).toBeNull();
    expect(readFileSync(file, "utf8")).not.toContain("chat_width");
    // Density the same: comfortable is saved as no setting, and a value the schema does not know is refused, writing nothing.
    expect(writeSettings(ctx, { density: null }).values.density).toBeNull();
    expect(readFileSync(file, "utf8")).not.toContain("density");
    expect(settingsPatchSchema.safeParse({ density: "tiny" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ density: "compact" }).success).toBe(true);
    // The tool-call skin, the same way round: cards is the default, lines the other choice.
    expect(writeSettings(ctx, { toolStyle: "lines" }).values.toolStyle).toBe("lines");
    expect(readFileSync(file, "utf8")).toContain("tool_style: lines");
    expect(writeSettings(ctx, { toolStyle: null }).values.toolStyle).toBeNull();
    expect(readFileSync(file, "utf8")).not.toContain("tool_style");
    // The font the same: the bundled one is the default, the system font the other choice.
    expect(writeSettings(ctx, { font: "system" }).values.font).toBe("system");
    expect(readFileSync(file, "utf8")).toContain("font: system");
    expect(writeSettings(ctx, { font: null }).values.font).toBeNull();
    expect(readFileSync(file, "utf8")).not.toContain("font:");
    expect(settingsPatchSchema.safeParse({ font: "comic" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ toolStyle: "tiles" }).success).toBe(false);
  });

  it("saves the orchestration switch and leaves the rest of its block alone", () => {
    const { ctx, file } = setup(`${FILE}orchestration:\n  enabled: true\n  maxDepth: 1\n`);
    const off = writeSettings(ctx, { orchestrationEnabled: false });
    expect(readFileSync(file, "utf8")).toContain("orchestration:\n  enabled: false\n  maxDepth: 1");
    expect(off.values.orchestrationEnabled).toBe(false);
    // The numbers are read while the server runs, so the switch needs no restart either.
    expect(off.restartPending).toEqual([]);
    // Back on is the default, saved as no key at all: the maxDepth written by hand stays.
    const on = writeSettings(ctx, { orchestrationEnabled: true });
    expect(on.values.orchestrationEnabled).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("orchestration:\n  maxDepth: 1\n");
    expect(readFileSync(file, "utf8")).not.toContain("enabled");
    // A block holding nothing else goes with the switch.
    const bare = setup(`${FILE}orchestration:\n  enabled: false\n`);
    writeSettings(bare.ctx, { orchestrationEnabled: true });
    expect(readFileSync(bare.file, "utf8")).not.toContain("orchestration");
  });

  it("keeps the password write-only and refuses to listen beyond this machine without a login", () => {
    const { ctx, file } = setup(FILE);
    expect(() => writeSettings(ctx, { host: "0.0.0.0" })).toThrow(/need a username and password/);
    expect(readFileSync(file, "utf8")).not.toContain("0.0.0.0");
    const view = writeSettings(ctx, { host: "0.0.0.0", username: "me", password: "s3cret pass" });
    expect(JSON.stringify(view)).not.toContain("s3cret");
    expect(view.values).toMatchObject({ host: "0.0.0.0", username: "me", hasPassword: true });
    expect(view.restartPending).toEqual(["host", "username", "password"]);
    expect(readFileSync(file, "utf8")).toContain("password: s3cret pass");
    // Removing it again: the auth block goes with it once empty.
    const cleared = writeSettings(ctx, { host: "127.0.0.1", username: "", password: null });
    expect(cleared.values.hasPassword).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("auth");
  });

  it("refuses what startup would refuse, writing nothing", () => {
    const { ctx, file } = setup(FILE);
    const before = readFileSync(file, "utf8");
    expect(() => writeSettings(ctx, { username: "has space", password: "x" })).toThrow(/username/);
    expect(() => writeSettings(ctx, { workspaceRoots: ["/no/such/folder"] })).toThrow(/workspace roots/);
    expect(() => writeSettings(ctx, { allowedHosts: ["bad host/path"] })).toThrow(/ALLOWED_HOSTS|allowed_hosts/i);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("creates config.yml when there is none, and names what the environment overrides", () => {
    const { ctx, file } = setup("", { envSet: new Set(["PORT"]) });
    const view = writeSettings(ctx, { allowedTailscaleUsers: ["Me@Example.com"] });
    expect(readFileSync(file, "utf8")).toBe("allowed_tailscale_users:\n  - Me@Example.com\n");
    expect(view.envOverrides).toEqual(["port"]);
    expect(view.restartPending).toEqual(["allowedTailscaleUsers"]);
  });

  it("refuses a save from another device that would shut that device out", () => {
    const { ctx, file } = setup(`host: 0.0.0.0\nallowed_hosts:\n  - box.tail.ts.net\nauth:\n  username: me\n  password: pass word\n`);
    const before = readFileSync(file, "utf8");
    const phone = { local: false, kind: "lan" as const, authority: "192.168.1.5:4783", tailscaleUser: null };
    const serve = { local: false, kind: "remote" as const, authority: "box.tail.ts.net", tailscaleUser: "me@example.com" };
    expect(() => writeSettings(ctx, { host: "127.0.0.1" }, phone)).toThrow(/lock this device out/);
    expect(() => writeSettings(ctx, { allowedHosts: [] }, serve)).toThrow(/box.tail.ts.net would no longer be an allowed host/);
    expect(() => writeSettings(ctx, { allowedTailscaleUsers: ["someone@else.com"] }, serve)).toThrow(/Tailscale login/);
    expect(readFileSync(file, "utf8")).toBe(before);
    // What leaves the device a way in goes through.
    expect(writeSettings(ctx, { host: "127.0.0.1" }, serve).values.host).toBe("127.0.0.1");
    expect(writeSettings(ctx, { allowedTailscaleUsers: ["Me@Example.com"] }, serve).values.allowedTailscaleUsers).toEqual(["Me@Example.com"]);
    expect(writeSettings(ctx, { host: "0.0.0.0", port: 4800 }, phone).values.port).toBe(4800);
  });

  it("saves ACP agents whole, never shows an env value, and keeps a stored one through a blank save", () => {
    const { ctx, file } = setup("harnesses:\n  pi:\n    command: /opt/pi\n  acp:\n    - id: gemini\n      command: gemini\n      args: [--acp]\n      env:\n        GEMINI_API_KEY: s3cret\n");
    const view = readSettings(ctx, true);
    expect(view.values.acpAgents).toEqual([{ id: "gemini", name: "gemini", command: "gemini", args: ["--acp"], envNames: ["GEMINI_API_KEY"], authMethod: null }]);
    // The dialog sends every name it saw, blank, and a new one: the blank keeps the secret, the new one is stored.
    const saved = writeSettings(ctx, { acpAgents: [{ id: "gemini", command: "gemini", args: ["--acp", "--debug"], env: { GEMINI_API_KEY: "", GOOSE_HOME: "/srv/goose" }, authMethod: "api-key" }] });
    expect(saved.values.acpAgents).toEqual([{ id: "gemini", name: "gemini", command: "gemini", args: ["--acp", "--debug"], envNames: ["GEMINI_API_KEY", "GOOSE_HOME"], authMethod: "api-key" }]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("s3cret");
    expect(text).toContain("GOOSE_HOME: /srv/goose");
    expect(text).toContain("auth_method: api-key");
    // The pi launch beside it is untouched, and the ACP list waits for a restart.
    expect(text).toContain("/opt/pi");
    // This server started with no ACP agent, so a list that differs from that is waiting for a restart.
    expect(writeSettings(ctx, { acpAgents: [{ id: "goose", command: "goose" }] }).restartPending).toContain("acpAgents");
  });

  it("saves shared agent profiles for delegation without writing credentials", () => {
    const { ctx, file } = setup(FILE);
    const profile = { name: "Reviewer", harness: "omp", model: "provider/review-small", thinking: "high", permissionMode: "acceptEdits", note: "Reviews before integration." };
    const saved = writeSettings(ctx, { agentProfiles: [profile] });
    expect(saved.values.agentProfiles).toEqual([profile]);
    expect(readSettings(ctx, true).values.agentProfiles).toEqual([profile]);
    expect(readFileSync(file, "utf8")).toContain("agent_profiles:");
    expect(readFileSync(file, "utf8")).toContain("permission_mode: acceptEdits");
    expect(saved.restartPending).toEqual([]);
    expect(writeSettings(ctx, { agentProfiles: [] }).values.agentProfiles).toEqual([]);
  });

  it("has nothing to write to without a settings folder", () => {
    const { ctx } = setup(FILE, { configDir: null });
    expect(readSettings(ctx, true).writable).toBe(false);
    expect(() => writeSettings(ctx, { port: 1 })).toThrow(/without a settings folder/);
  });
});
