import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configDir, configEnv, launchSettings, migrateConfigDir, readUserConfig, uiSettings, UserConfigError } from "../../src/server/user-config.js";
import { tempDir } from "../helpers/app.js";

function folder(yaml?: string, mode = 0o644): string {
  const dir = path.join(tempDir("awui-config-"), "awui");
  mkdirSync(dir);
  if (yaml !== undefined) writeFileSync(path.join(dir, "config.yml"), yaml, { mode });
  return dir;
}

describe("config.yml", () => {
  it("lives in $XDG_CONFIG_HOME/awui; AWUI_CONFIG_DIR moves it and an empty one ignores it", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/awui");
    expect(configDir({ AWUI_CONFIG_DIR: "/elsewhere" })).toBe("/elsewhere");
    expect(configDir({ AWUI_CONFIG_DIR: "" })).toBeNull();
    expect(readUserConfig(null)).toBeNull();
    expect(readUserConfig(folder())).toBeNull();
  });

  it("moves a leftover agentwebui folder to the new name, once", () => {
    const base = tempDir("awui-config-");
    const old = path.join(base, "agentwebui");
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, "config.yml"), "port: 4801\n");
    const env = { XDG_CONFIG_HOME: base };
    expect(migrateConfigDir(env)).toBe("moved");
    expect(readFileSync(path.join(base, "awui", "config.yml"), "utf8")).toContain("4801");
    // Idempotent: a fresh call leaves the moved folder alone.
    expect(migrateConfigDir(env)).toBeNull();
  });

  it("maps its settings onto the server's variables", () => {
    const dir = folder(`# comments are fine
port: 4800
host: 0.0.0.0
auth:
  username: drishal
  password: "correct horse"
workspace_roots: [/home/x/code, /srv]
allowed_hosts: [box.tail.ts.net]
theme: base16
chat_width: full
density: compact
tool_style: lines
font: system
autocollapse_sidebar: false
show_status_bar: false
herdr: false
herdr_socket: ~/run/herdr.sock
`);
    const read = readUserConfig(dir);
    expect(read && configEnv(read.config)).toEqual({
      PORT: "4800",
      HOST: "0.0.0.0",
      AUTH_USERNAME: "drishal",
      AUTH_PASSWORD: "correct horse",
      WORKSPACE_ROOTS: `/home/x/code${path.delimiter}/srv`,
      ALLOWED_HOSTS: "box.tail.ts.net",
    });
    expect(uiSettings(read?.config, {})).toEqual({ theme: "base16", textScale: null, chatWidth: "full", density: "compact", toolStyle: "lines", font: "system", autocollapseSidebar: false, showStatusBar: false, herdr: false });
    // AWUI_HERDR wins over the file, as every variable does.
    expect(uiSettings(read?.config, { AWUI_HERDR: "1" }).herdr).toBe(true);
    expect(read?.config.herdr_socket).toBe("~/run/herdr.sock");
    // The old name still works.
    expect(uiSettings(readUserConfig(folder("theme: custom\n"))?.config).theme).toBe("base16");
  });

  it("defaults the browser settings, and an empty file is no settings", () => {
    expect(uiSettings(undefined, {})).toEqual({ theme: null, textScale: null, chatWidth: null, density: null, toolStyle: null, font: null, autocollapseSidebar: true, showStatusBar: true, herdr: true });
    expect(readUserConfig(folder(""))?.config).toEqual({});
  });

  it("narrows a file holding a password to its owner", () => {
    const dir = folder("auth:\n  username: a\n  password: long-enough\n");
    expect(readUserConfig(dir)?.tightened).toBe(true);
    expect(statSync(path.join(dir, "config.yml")).mode & 0o777).toBe(0o600);
    expect(readUserConfig(folder("port: 4800\n"))?.tightened).toBe(false);
  });

  it("starts each harness as its harnesses: block says, a *_BIN variable winning over it", () => {
    const yaml = ["harnesses:", "  pi:", "    command: ~/bin/pi-dev", "    args: [--no-skills, --verbose]", "  claude:", "    args: [--add-dir, /srv/docs]", "  hermes:", "    command: /opt/hermes/bin/hermes", ""].join("\n");
    const read = readUserConfig(folder(yaml));
    expect(launchSettings(read?.config, {}, "/home/me")).toEqual({
      pi: { command: "/home/me/bin/pi-dev", args: ["--no-skills", "--verbose"] },
      claude: { args: ["--add-dir", "/srv/docs"] },
      hermes: { command: "/opt/hermes/bin/hermes", args: [] },
    });
    expect(launchSettings(read?.config, { CLAUDE_BIN: "/usr/local/bin/claude", OMP_BIN: "omp-next" }, "/home/me")).toMatchObject({
      claude: { command: "/usr/local/bin/claude", args: ["--add-dir", "/srv/docs"] },
      omp: { command: "omp-next", args: [] },
    });
    expect(launchSettings(undefined, {}, "/home/me")).toEqual({});
  });

  it("refuses launch settings it cannot honour", () => {
    // Hermes's gateway has no command line to add to; a typo'd harness or key is named.
    expect(() => readUserConfig(folder("harnesses:\n  hermes:\n    args: [-v]\n"))).toThrow(/harnesses\.hermes/);
    expect(() => readUserConfig(folder("harnesses:\n  cursor:\n    command: cursor\n"))).toThrow(/harnesses/);
    expect(() => readUserConfig(folder("harnesses:\n  pi:\n    comand: pi\n"))).toThrow(/harnesses\.pi/);
    expect(() => readUserConfig(folder('harnesses:\n  pi:\n    command: "pi\\nrm"\n'))).toThrow(/control characters/);
    expect(() => readUserConfig(folder("harnesses:\n  pi:\n    command: ''\n"))).toThrow(/harnesses\.pi\.command/);
  });

  it("names the bad key instead of guessing", () => {
    expect(() => readUserConfig(folder("autocollapse_sidebar: yes\n"))).toThrow(/autocollapse_sidebar/);
    expect(() => readUserConfig(folder("thme: dark\n"))).toThrow(UserConfigError);
    expect(() => readUserConfig(folder("theme: [dark\n"))).toThrow(/not valid YAML/);
    expect(() => readUserConfig(folder("theme: blue\n"))).toThrow(/theme/);
  });
});
