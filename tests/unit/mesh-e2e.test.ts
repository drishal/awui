// The mesh end to end (P1): a real PeerManager talking to the real worker
// `serve()` over an in-process memory link, with the real signed handshake on
// both sides, a real PinStore on each, and the fake harness behind the worker's
// registry. Nothing here is canned at the task level: the leader's
// PeerHarnessAdapter opens a task, the prompt crosses the wire, the worker
// enforces its inbound policy, and the run streams back as task.event
// notifications the relay folds. This is the one test that both halves of the
// spec must agree on; it is allowed to fail to compile until serve.ts lands
// (it is written against the API SPEC-P1B promises).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MeshConfig } from "../../src/server/user-config.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PeerManager, type PeerSpawn } from "../../src/server/mesh/manager.js";
import { PeerHarnessAdapter } from "../../src/server/mesh/peer-adapter.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { memoryLink, type PeerLink } from "../../src/server/mesh/transport.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import type { HarnessEvent } from "../../src/server/harness/types.js";
import { tempDir } from "../helpers/app.js";

/** Both halves of one test: the worker's state on one side, the leader's on the other. */
async function pair(workerConfig: MeshConfig) {
  const root = tempDir("awui-mesh-e2e-");
  const workerIdentity = await loadOrCreateIdentity(tempDir("awui-mesh-w-"));
  const leaderIdentity = await loadOrCreateIdentity(tempDir("awui-mesh-l-"));
  const workerPins = PinStore(path.join(tempDir("awui-mesh-wp-"), "pins.json"));
  const leaderPins = PinStore(path.join(tempDir("awui-mesh-lp-"), "pins.json"));

  const registry = new HarnessRegistry();
  registry.register(new FakeAdapter({ chunkDelayMs: 1 }));
  await registry.refreshStatus();

  const deps: ServeDeps = {
    identity: workerIdentity,
    name: "worker-box",
    pins: workerPins,
    audit: new AuditLog(path.join(root, "mesh", "audit.jsonl")),
    registry,
    config: () => workerConfig,
    enabled: () => true,
    home: root,
    log: () => undefined,
  };

  const spawn = (_peerName: string, _link: PeerLink): PeerSpawn => {
    const link = memoryLink();
    serve({ input: link.server.input, output: link.server.output }, deps);
    return {
      input: link.client.input,
      output: link.client.output,
      kill: () => {
        link.client.input.destroy();
        link.client.output.destroy();
      },
    };
  };

  const manager = new PeerManager({
    identity: async () => leaderIdentity,
    pins: leaderPins,
    config: () => ({ enabled: true, peers: [{ name: "lab", docker: "awui-worker-1" }] }),
    enabled: () => true,
    localName: () => "leader-box",
    spawn,
  });

  return { root, workerIdentity, leaderIdentity, workerPins, manager };
}

/** A `mesh:` block whose `work` policy lets a paired leader run fake-harness tasks in the project. */
function workerConfigFor(project: string): MeshConfig {
  return {
    enabled: true,
    policies: {
      work: {
        caps: ["discover", "task.run", "task.approve", "fs.read"],
        ask: ["fs.write"],
        roots: [project],
        harnesses: ["fake"],
        permission_ceiling: "auto-edit",
        max_tasks: 4,
        approvals_at: "origin",
      },
    },
    peers: [],
  };
}

/** The leader side pins the worker (tofu), the worker side pins the leader (accept). */
async function accept(workerPins: ReturnType<typeof PinStore>, leaderIdentity: NodeIdentity) {
  await workerPins.setInbound(leaderIdentity.publicKey, "leader-box", "work", "accept");
}

describe("mesh end to end", () => {
  it("runs a task on the worker over the real serve()", async () => {
    const root = tempDir("awui-mesh-e2e-");
    const proj = path.join(root, "proj");
    mkdirSync(proj);
    const both = await pair(workerConfigFor(proj));
    await accept(both.workerPins, both.leaderIdentity);

    // First contact under TOFU records it; the pin is what every later connect holds it to.
    const first = await both.manager.connect("lab", { tofu: true });
    expect(first.paired).toBe(true);
    expect(first.policy).toBe("work");
    await both.manager.pin("lab", first.serverKey);
    const conn = await both.manager.connect("lab");
    expect(conn.paired).toBe(true);

    const adapter = new PeerHarnessAdapter(both.manager, "lab", "fake", proj);
    const live = await adapter.openChat({ cwd: "/ignored/on/the/leader" });
    const events: HarnessEvent[] = [];
    live.subscribe((event) => events.push(event));
    await live.prompt("hello from the leader");
    const deadline = Date.now() + 10_000;
    while (!events.some((e) => e.type === "settled")) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the remote run to settle (got ${events.map((e) => e.type).join(", ")})`);
      await new Promise((r) => setTimeout(r, 10));
    }
    // The run really is the worker's fake harness: a session, an answer, a settle.
    expect(live.nativeId).toBeTruthy();
    const answer = events.find((e) => e.type === "assistant_end");
    expect(answer && answer.type === "assistant_end" ? answer.text : "").not.toBe("");
    const history = await live.history();
    expect(history.length).toBeGreaterThan(0);
    await live.dispose();
    conn.close();
  });

  it("refuses every task method from a leader the worker has not accepted", async () => {
    const root = tempDir("awui-mesh-e2e-");
    const proj = path.join(root, "proj");
    mkdirSync(proj);
    const both = await pair(workerConfigFor(proj));
    // No inbound pin: the worker reports unpaired, and only the handshake answers.
    const conn = await both.manager.connect("lab", { tofu: true });
    expect(conn.paired).toBe(false);
    await expect(conn.rpc.request("task.open", { harness: "fake", cwd: proj, hops: 0 })).rejects.toMatchObject({
      data: { code: "not_paired" },
    });
    conn.close();
  });
});
