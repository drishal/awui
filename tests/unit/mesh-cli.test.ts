// The mesh peer CLI (src/server/mesh/cli.ts): the command line's strictness, the
// mesh-off refusals, what `status` may print, and the revocation `remove` performs.
// Like the headless CLI's tests, this runs with its own config and state folders
// handed in through the environment, so the developer's awui is never touched.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CONFIG, EXIT_FAILED, EXIT_OK, EXIT_USAGE, runPeerCli, type PeerCliIo } from "../../src/server/mesh/cli.js";
import { loadOrCreateIdentity } from "../../src/server/mesh/identity.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { tempDir } from "../helpers/app.js";

/** A collector instead of the process's streams; the env carries the test's folders. */
function collector(env: NodeJS.ProcessEnv, ask?: (question: string) => Promise<string>) {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const io: PeerCliIo = {
    env: { AWUI_CONFIG_DIR: "", AWUI_MESH: "", ...env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(ask
      ? {
          ask: (question: string) => {
            questions.push(question);
            return ask(question);
          },
        }
      : {}),
  };
  return { io, out, err, questions };
}

/** A config folder whose config.yml turns the mesh on, with one configured peer. */
function meshOnDir(): string {
  const dir = tempDir("awui-mesh-cli-cfg-");
  writeFileSync(
    path.join(dir, "config.yml"),
    ["mesh:", "  enabled: true", "  name: leader-box", "  peers:", "    - name: lab", "      ssh: user@lab-box", ""].join("\n"),
  );
  return dir;
}

describe("the peer CLI's command line", () => {
  it("refuses an unknown command, a missing name, and an unknown flag with usage on stderr, exit 2", async () => {
    // "accept lab" without --policy is no longer a usage error: an invited request
    // (P2 §3) pre-fills its own policy, so the command itself judges after reading
    // the pending entry -- it fails with that entry's own words instead.
    for (const args of [[], ["bogus"], ["add"], ["add", "lab", "--nope"], ["test", "lab", "extra"], ["remove", "a/b"], ["log", "--tail", "soon"], ["status", "stray"]]) {
      const c = collector({});
      expect(await runPeerCli(args, c.io), JSON.stringify(args)).toBe(EXIT_USAGE);
      expect(c.err.join("\n")).toContain("Usage");
      expect(c.out).toEqual([]);
    }
  });

  it("prints the usage for --help and exits 0", async () => {
    const c = collector({});
    expect(await runPeerCli(["--help"], c.io)).toBe(EXIT_OK);
    expect(c.out[0]).toContain("awui peer");
  });

  it("names the file and task commands in the usage", async () => {
    const c = collector({});
    expect(await runPeerCli(["--help"], c.io)).toBe(EXIT_OK);
    const usage = c.out.join("\n");
    expect(usage).toContain("peer ls <name> <path>");
    expect(usage).toContain("peer cat <name> <path>");
    expect(usage).toContain("peer tasks <name>");
  });

  it("refuses ls, cat, and tasks lines that are not exactly peer name and path", async () => {
    for (const args of [["ls", "lab"], ["cat", "lab"], ["ls", "lab", "/x", "extra"], ["cat", "lab", "/x", "--nope"], ["tasks"], ["tasks", "lab", "extra"]]) {
      const c = collector({});
      expect(await runPeerCli(args, c.io), JSON.stringify(args)).toBe(EXIT_USAGE);
      expect(c.err.join("\n")).toContain("Usage");
      expect(c.out).toEqual([]);
    }
  });
});

describe("the peer CLI with the mesh off", () => {
  it("status, list, and log still answer and say the mesh is off", async () => {
    for (const args of [["status"], ["list"], ["log"]]) {
      const c = collector({});
      expect(await runPeerCli(args, c.io), JSON.stringify(args)).toBe(EXIT_OK);
      expect(c.out).toContain("mesh: off");
      expect(c.out.join("\n")).toContain("mesh.enabled: true");
    }
  });

  it("add, accept, and test refuse with 78 and the one-line hint", async () => {
    for (const args of [["add", "lab"], ["test", "lab"], ["accept", "lab", "--policy", "worker"]]) {
      const c = collector({});
      expect(await runPeerCli(args, c.io), JSON.stringify(args)).toBe(EXIT_CONFIG);
      expect(c.err.join("\n")).toContain("mesh.enabled: true");
    }
  });

  it("ls, cat, and tasks need the mesh on too: they open a link", async () => {
    for (const args of [["ls", "lab", "/srv/proj"], ["cat", "lab", "/srv/proj/notes.md"], ["tasks", "lab"]]) {
      const c = collector({});
      expect(await runPeerCli(args, c.io), JSON.stringify(args)).toBe(EXIT_CONFIG);
      expect(c.err.join("\n")).toContain("mesh.enabled: true");
    }
  });
});

describe("awui peer status", () => {
  it("names the node: id and public key, never any private key material", async () => {
    const configDir = meshOnDir();
    const stateDir = tempDir("awui-mesh-cli-state-");
    const c = collector({ AWUI_CONFIG_DIR: configDir, AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["status"], c.io)).toBe(EXIT_OK);
    const identity = await loadOrCreateIdentity(stateDir);
    expect(c.out).toContain("mesh: on");
    expect(c.out).toContain("name: leader-box");
    expect(c.out).toContain(`node id: ${identity.nodeId}`);
    expect(c.out).toContain(`public key: ${identity.publicKey.toString("base64url")}`);
    expect(c.out.join("\n")).toContain("lab (ssh)");
    expect(c.out.join("\n").toUpperCase()).not.toContain("PRIVATE");
    expect(c.err).toEqual([]);
  });

  it("says off without creating an identity on disk", async () => {
    const stateDir = tempDir("awui-mesh-cli-state-");
    const c = collector({ AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["status"], c.io)).toBe(EXIT_OK);
    expect(c.out[0]).toBe("mesh: off");
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(stateDir, "mesh"))).toBe(false);
  });
});

describe("awui peer accept", () => {
  it("fails when there is no pending request from that name", async () => {
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-cli-state-") });
    expect(await runPeerCli(["accept", "lab", "--policy", "worker", "--yes"], c.io)).toBe(EXIT_FAILED);
    expect(c.err.join("\n")).toContain("no pending request from \"lab\"");
  });

  it("pins a single pending request after the question, and refuses when two keys claim the name", async () => {
    const stateDir = tempDir("awui-mesh-cli-state-");
    const pins = PinStore(path.join(stateDir, "mesh", "pins.json"));
    const one = await loadOrCreateIdentity(tempDir("awui-mesh-cli-k1-"));
    const two = await loadOrCreateIdentity(tempDir("awui-mesh-cli-k2-"));
    await pins.addPending(one.publicKey, "lab");
    const ok = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir }, async () => "y");
    expect(await runPeerCli(["accept", "lab", "--policy", "worker"], ok.io)).toBe(EXIT_OK);
    expect(ok.questions.length).toBe(1);
    expect((await pins.inboundByName("lab"))?.publicKey.equals(one.publicKey)).toBe(true);

    await pins.addPending(one.publicKey, "ci");
    await pins.addPending(two.publicKey, "ci");
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["accept", "ci", "--policy", "worker", "--yes"], c.io)).toBe(EXIT_FAILED);
    expect(c.err.join("\n")).toContain("2 pending requests claim the name");
    expect(await pins.inboundByName("ci")).toBeNull();
  });

  it("refuses a policy that does not exist, naming what does", async () => {
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-cli-state-") });
    expect(await runPeerCli(["accept", "lab", "--policy", "nowhere"], c.io)).toBe(EXIT_CONFIG);
    expect(c.err.join("\n")).toContain('no mesh policy named "nowhere"');
    expect(c.err.join("\n")).toContain("none, worker, peer");
  });
});

describe("awui peer remove", () => {
  it("drops the outbound, inbound, and pending pins under the name", async () => {
    const stateDir = tempDir("awui-mesh-cli-state-");
    const pins = PinStore(path.join(stateDir, "mesh", "pins.json"));
    const leader = await loadOrCreateIdentity(tempDir("awui-mesh-cli-k1-"));
    const other = await loadOrCreateIdentity(tempDir("awui-mesh-cli-k2-"));
    await pins.setOutbound("lab", leader.publicKey);
    await pins.setInbound(leader.publicKey, "lab", "worker", "accept");
    await pins.addPending(other.publicKey, "lab");
    await pins.setOutbound("ci", other.publicKey);

    const c = collector({ AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["remove", "lab"], c.io)).toBe(EXIT_OK);
    const after = await pins.snapshot();
    expect(after.outbound.map((p) => p.name)).toEqual(["ci"]);
    expect(after.inbound).toEqual([]);
    expect(after.pending).toEqual([]);
    expect(after.outbound[0]?.name).toBe("ci");
  });
});

describe("awui peer log", () => {
  it("prints the audit log's tail, filtered by --peer", async () => {
    const stateDir = tempDir("awui-mesh-cli-state-");
    const { AuditLog } = await import("../../src/server/mesh/audit.js");
    const audit = new AuditLog(path.join(stateDir, "mesh", "audit.jsonl"));
    await audit.append({ peer: "lab", method: "task.open", decision: "allow", outcome: "rt_1" });
    await audit.append({ peer: "ci", method: "peer.info", decision: "deny" });

    const all = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["log", "--tail", "10"], all.io)).toBe(EXIT_OK);
    expect(all.out).toHaveLength(2);
    expect(all.out[0]).toContain("lab  task.open  allow");
    expect(all.out[1]).toContain("ci  peer.info  deny");

    const one = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["log", "--peer", "ci"], one.io)).toBe(EXIT_OK);
    expect(one.out).toHaveLength(1);
    expect(one.out[0]).toContain("peer.info");
  });
});

describe("awui peer bootstrap", () => {
  it("prints the exact commands with the hostile parts quoted, and runs nothing", async () => {
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-cli-state-") });
    const key = tempDir("awui-mesh-cli-key-") + "/id_ed25519.pub";
    writeFileSync(key, "ssh-ed25519 AAAA test-key comment\n");
    const root = "/srv/wo" + String.fromCharCode(39) + "rked; rm -rf ~";
    expect(await runPeerCli(["bootstrap", "drishal@lab-box", "--root", root, "--pubkey", key], c.io)).toBe(EXIT_OK);
    const printed = c.out.join("\n");
    // The repo, the root and the forced command are quoted as whole words: the
    // shell the commands land in can read them back as one word each.
    expect(printed).toContain("git clone 'https://github.com/drishal/awui.git'");
    expect(printed).toContain('roots: ["/srv/wo\'rked; rm -rf ~"]');
    // The forced command is inside the line's one single-quoted token (the
    // inner quotes are escaped the shell way, `'\''`), and it carries the
    // marker the step's own grep looks for, so a re-run appends nothing twice.
    expect(printed).toContain('restrict,command="$HOME/.local/bin/awui peer serve-stdio');
    expect(printed).toContain("--peer '");
    expect(printed).toContain("awui-mesh leader-box");
    // Nothing executes when --run is absent.
    expect(c.err.join("\n")).not.toContain("running");
  });

  it("refuses an option-shaped destination, a relative root, a custom policy name, and a stray word with usage, exit 2", async () => {
    for (const args of [
      ["bootstrap", "--evil", "x"],
      ["bootstrap", "-lab"],
      ["bootstrap", "drishal@lab", "--root", "relative/path"],
      ["bootstrap", "drishal@lab", "--policy", "custom"],
      ["bootstrap", "drishal@lab", "stray"],
      ["bootstrap"],
      ["bootstrap", "drishal@lab", "--repo", "line1\nline2"],
    ]) {
      const c = collector({});
      expect(await runPeerCli(args, c.io), JSON.stringify(args)).toBe(EXIT_USAGE);
      expect(c.err.join("\n")).toContain("Usage");
      expect(c.out).toEqual([]);
    }
  });

  it("with --run asks, then runs the steps over ssh as argv only (no shell)", async () => {
    const steps: string[][] = [];
    const printed: string[] = [];
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-cli-state-") }, async () => "y");
    c.io.runStep = async (argv) => {
      steps.push(argv);
      printed.push(argv[argv.length - 1] ?? "");
      return 0;
    };
    expect(await runPeerCli(["bootstrap", "drishal@lab-box", "--run"], c.io)).toBe(EXIT_OK);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const argv of steps) {
      // argv words only: ssh, its fixed options, the destination, the script.
      expect(argv[0]).toBe("ssh");
      expect(argv).toContain("--");
      expect(argv[argv.length - 2]).toBe("drishal@lab-box");
    }
    // The remote command carries a root value that would be a command elsewhere,
    // held to one word by the quoting.
    const asked = c.questions.join("\n");
    expect(asked).toContain("over ssh now?");
  });

  it("without a terminal or --yes, --run asks and stops before any step", async () => {
    const steps: string[][] = [];
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-cli-state-") });
    c.io.runStep = async (argv) => {
      steps.push(argv);
      return 0;
    };
    expect(await runPeerCli(["bootstrap", "drishal@lab-box", "--run"], c.io)).toBe(EXIT_FAILED);
    expect(steps).toEqual([]);
    expect(c.err.join("\n")).toContain("not run");
  });

  it("stops at the first failing step", async () => {
    const steps: string[][] = [];
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-cli-state-") }, async () => "y");
    c.io.runStep = async (argv) => {
      steps.push(argv);
      return steps.length === 1 ? 3 : 0;
    };
    expect(await runPeerCli(["bootstrap", "drishal@lab-box", "--run"], c.io)).toBe(EXIT_FAILED);
    expect(steps).toHaveLength(1);
    expect(c.err.join("\n")).toContain("exited 3");
  });
});
