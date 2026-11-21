// Mesh transport (transport.ts): quoting is exact and rejects what would break a
// line, argv is word-for-word the ssh/docker form with nothing re-parsed locally,
// hostile destinations are refused before they reach a process, the child is never
// spawned through a shell, and the in-process pair actually carries bytes both ways.
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { argvFor, linkOf, memoryLink, shellQuote, spawnLink, type PeerLink } from "../../src/server/mesh/transport.js";

describe("shellQuote", () => {
  it("wraps a plain word in single quotes", () => {
    expect(shellQuote("awui")).toBe("'awui'");
    expect(shellQuote("/usr/local/bin/awui")).toBe("'/usr/local/bin/awui'");
  });

  it("quotes an empty string as ''", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("keeps spaces and shell syntax inert", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("$(touch /tmp/pwned)")).toBe("'$(touch /tmp/pwned)'");
    expect(shellQuote("`id`")).toBe("'`id`'");
    expect(shellQuote('"x"; rm -rf /')).toBe(`'"x"; rm -rf /'`);
    expect(shellQuote("$HOME")).toBe("'$HOME'");
  });

  it("closes, escapes, and reopens a single quote", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("'")).toBe("''\\'''");
  });

  it("refuses a newline or a NUL", () => {
    expect(() => shellQuote("a\nb")).toThrow(/newline/);
    expect(() => shellQuote("a\rb")).toThrow(/newline/);
    expect(() => shellQuote("a\u0000b")).toThrow(/NUL/);
  });
});

describe("linkOf", () => {
  it("maps an ssh peer and drops absent fields it does not have", () => {
    expect(linkOf({ ssh: "alice@lab-vm-3", ssh_opts: ["-p", "2222"], awui_path: "/opt/awui" })).toEqual({
      kind: "ssh",
      host: "alice@lab-vm-3",
      sshOpts: ["-p", "2222"],
      awuiPath: "/opt/awui",
    });
  });

  it("maps a docker peer with its engine", () => {
    expect(linkOf({ docker: "awui-worker", engine: "podman" })).toEqual({ kind: "docker", container: "awui-worker", engine: "podman" });
  });

  it("throws when the peer does not name exactly one of ssh, docker, or tls", () => {
    expect(() => linkOf({})).toThrow(/neither ssh, docker, nor tls/);
    expect(() => linkOf({ ssh: "a", docker: "b" })).toThrow(/both ssh and docker/);
    expect(() => linkOf({ ssh: "a", tls: "b:1" })).toThrow(/both ssh and tls/);
    expect(() => linkOf({ docker: "b", tls: "c:1" })).toThrow(/both docker and tls/);
    expect(linkOf({ tls: "10.0.0.9:4784" })).toEqual({ kind: "tls", address: "10.0.0.9:4784" });
  });
});

describe("argvFor", () => {
  const ssh = (extra: Partial<Extract<PeerLink, { kind: "ssh" }>> = {}): PeerLink => ({ kind: "ssh", host: "lab-vm-3", ...extra });

  it("builds the ssh form with the fixed options and the quoted remote command", () => {
    expect(argvFor(ssh(), "studio")).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=4",
      "--",
      "lab-vm-3",
      "'awui' peer serve-stdio --peer 'studio'",
    ]);
  });

  it("appends ssh options before the host and quotes a custom awui path", () => {
    const argv = argvFor(ssh({ host: "alice@lab-vm-3", sshOpts: ["-p", "2222", "-i", "/keys/lab"], awuiPath: "/opt/aw ui's bin/awui" }), "studio-2");
    expect(argv.slice(0, 8)).toEqual(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"]);
    expect(argv.slice(8, 12)).toEqual(["-p", "2222", "-i", "/keys/lab"]);
    expect(argv.slice(12)).toEqual([
      "--",
      "alice@lab-vm-3",
      `'/opt/aw ui'\\''s bin/awui' peer serve-stdio --peer 'studio-2'`,
    ]);
  });

  it("takes the default awui binary when no path is given", () => {
    expect(argvFor({ kind: "ssh", host: "h" }, "n")[10]).toBe("'awui' peer serve-stdio --peer 'n'");
  });

  it("builds the docker form with each word its own argument", () => {
    expect(argvFor({ kind: "docker", container: "awui-worker" }, "studio")).toEqual([
      "docker",
      "exec",
      "-i",
      "awui-worker",
      "awui",
      "peer",
      "serve-stdio",
      "--peer",
      "studio",
    ]);
  });

  it("uses podman and a custom path for a docker link", () => {
    expect(argvFor({ kind: "docker", container: "awui_worker.1", engine: "podman", awuiPath: "/opt/awui" }, "studio")).toEqual([
      "podman",
      "exec",
      "-i",
      "awui_worker.1",
      "/opt/awui",
      "peer",
      "serve-stdio",
      "--peer",
      "studio",
    ]);
  });

  it("refuses a host ssh would read as an option or split on a space", () => {
    expect(() => argvFor({ kind: "ssh", host: "-oProxyCommand=touch /tmp/x" }, "n")).toThrow(/ssh host/);
    expect(() => argvFor({ kind: "ssh", host: "lab vm" }, "n")).toThrow(/ssh host/);
    expect(() => argvFor({ kind: "ssh", host: "lab\nvm" }, "n")).toThrow(/ssh host/);
  });

  it("refuses a container that starts with a dash or holds a space", () => {
    expect(() => argvFor({ kind: "docker", container: "-v/etc:/etc" }, "n")).toThrow(/container/);
    expect(() => argvFor({ kind: "docker", container: "awui worker" }, "n")).toThrow(/container/);
  });

  it("refuses a peer name with a slash, a space, or over its length", () => {
    expect(() => argvFor({ kind: "ssh", host: "h" }, "a/b")).toThrow(/peer name/);
    expect(() => argvFor({ kind: "ssh", host: "h" }, "a b")).toThrow(/peer name/);
    expect(() => argvFor({ kind: "ssh", host: "h" }, "")).toThrow(/peer name/);
    expect(() => argvFor({ kind: "ssh", host: "h" }, "x".repeat(65))).toThrow(/peer name/);
  });

  it("refuses an ssh option with a newline", () => {
    expect(() => argvFor({ kind: "ssh", host: "h", sshOpts: ["-p 22\nrm -rf /"] }, "n")).toThrow(/ssh option/);
  });

  it("refuses an awui path with a newline anywhere and a leading dash for docker", () => {
    expect(() => argvFor({ kind: "ssh", host: "h", awuiPath: "awui\nrm -rf /" }, "n")).toThrow(/awui_path/);
    expect(() => argvFor({ kind: "docker", container: "c", awuiPath: "-entrypoint" }, "n")).toThrow(/awui_path/);
  });
});

describe("spawnLink", () => {
  /** A spawn stand-in: records its call and returns quiet pipes that can be closed. */
  const fakeSpawn = (): { calls: Array<{ command: string; args: string[]; options: unknown }>; spawn: typeof spawn } => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const impl = (command: string, args: string[], options: unknown): ChildProcessWithoutNullStreams => {
      calls.push({ command, args, options });
      const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdin, stdout, stderr, kill: () => true });
      return child;
    };
    return { calls, spawn: impl as unknown as typeof spawn };
  };

  it("spawns the argv with piped stdio and never a shell", () => {
    const fake = fakeSpawn();
    const env = { PATH: "/usr/bin" };
    const link = spawnLink({ kind: "ssh", host: "lab-vm-3" }, "studio", { spawn: fake.spawn, env });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.command).toBe("ssh");
    expect(call.args[0]).toBe("-T");
    expect(call.args.at(-1)).toBe("'awui' peer serve-stdio --peer 'studio'");
    expect(call.options).toEqual({ stdio: ["pipe", "pipe", "pipe"], shell: false, env });

    link.kill();
    expect(link.input).toBeDefined();
    expect(link.output).toBeDefined();
  });

  it("reads a worker's stderr as text and keeps only the tail", () => {
    const fake = fakeSpawn();
    const link = spawnLink({ kind: "docker", container: "awui-worker" }, "studio", { spawn: fake.spawn });
    // Sixteen KiB of noise: only the last 8 KiB may survive in an error message.
    // The link's stderr is a Readable; the fake's is a PassThrough it reads from.
    const stderr = link.stderr as PassThrough;
    stderr.write("a".repeat(4 * 1024));
    stderr.write("b".repeat(12 * 1024));
    expect(link.stderrTail()).toHaveLength(8 * 1024);
    expect(link.stderrTail()).toBe("b".repeat(8 * 1024));
  });
});

describe("memoryLink", () => {
  it("carries bytes both ways between the two ends", async () => {
    const { client, server } = memoryLink();
    const atServer: Buffer[] = [];
    const atClient: Buffer[] = [];
    server.input.on("data", (chunk: Buffer) => atServer.push(chunk));
    client.input.on("data", (chunk: Buffer) => atClient.push(chunk));

    client.output.write("hello worker\n");
    server.output.write("AWUI-MESH/1 READY\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(Buffer.concat(atServer).toString()).toBe("hello worker\n");
    expect(Buffer.concat(atClient).toString()).toBe("AWUI-MESH/1 READY\n");
  });
});
