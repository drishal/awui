import { describe, expect, it } from "vitest";
import { asHarnessId } from "../../src/shared/protocol.js";
import { evaluate, render, type DoctorInput } from "../../src/server/doctor.js";

const healthy: DoctorInput = {
  configError: null,
  configFile: "/c/config.yml",
  nodeVersion: "v22.19.0",
  bunVersion: "1.3.14",
  harnesses: [{ id: asHarnessId("pi"), displayName: "Pi", available: true, version: "1.0.2", warnings: [] }],
  harnessError: null,
  host: "127.0.0.1",
  port: 4783,
  workspaceWarnings: [],
  workspaceRoots: 1,
  stateDir: { path: "/s/awui", error: null, mode: 0o700 },
  portProbe: { kind: "free" },
  remote: { exposed: false, credentials: false },
  herdr: { enabled: false, socket: "/h.sock", exists: false },
  orchestration: { enabled: true, maxChildrenPerChat: 4, maxDepth: 2, maxLiveTasks: 12, missingBridges: [] },
  mcp: [{ harnessId: "pi", displayName: "Pi", installed: true, kind: "automatic", detail: "an `-e` extension loaded on the chat's command line", argv: [], existing: null }],
  windows: false,
  embedded: false,
};
const by = (c: ReturnType<typeof evaluate>, name: string) => c.find((x) => x.name === name)!;

describe("doctor", () => {
  it("passes a healthy setup", () => {
    const checks = evaluate(healthy);
    expect(checks.every((c) => c.ok === true)).toBe(true);
    expect(render(checks).split("\n").at(-1)).toBe("No problems");
  });

  it("flags a missing harness with its reason", () => {
    const checks = evaluate({ ...healthy, harnesses: [{ id: asHarnessId("omp"), displayName: "omp", available: false, reason: "omp not found on PATH", warnings: [] }] });
    expect(by(checks, "Harness omp")).toMatchObject({ ok: false, detail: "omp not found on PATH" });
    expect(render(checks)).toContain("✗ Harness omp");
    // Beside one that works, a missing harness is only a note.
    const pi = { id: asHarnessId("pi"), displayName: "Pi", available: true, version: "1.0.0", warnings: [] };
    const both = evaluate({ ...healthy, harnesses: [pi, { id: asHarnessId("omp"), displayName: "omp", available: false, reason: "omp not found on PATH", warnings: [] }] });
    expect(by(both, "Harness omp")).toMatchObject({ ok: "warn" });
  });

  it("flags a state folder others can read", () => {
    const c = by(evaluate({ ...healthy, stateDir: { path: "/s/awui", error: null, mode: 0o755 } }), "State folder");
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("chmod 700");
  });

  it("tells awui, something else, and free apart on the port", () => {
    expect(by(evaluate({ ...healthy, portProbe: { kind: "awui", version: "1.2.3" } }), "Port").detail).toContain("awui is running");
    expect(by(evaluate({ ...healthy, portProbe: { kind: "awui", version: "1.2.3" } }), "Port").detail).toContain("1.2.3");
    expect(by(evaluate({ ...healthy, portProbe: { kind: "other", detail: "HTTP 404, not awui" } }), "Port").ok).toBe(false);
  });

  it("warns on Bun, Node, remote access and herdr", () => {
    const checks = evaluate({ ...healthy, nodeVersion: "v20.0.0", bunVersion: null, remote: { exposed: true, credentials: false }, herdr: { enabled: true, socket: "/h.sock", exists: false } });
    expect(by(checks, "Node").ok).toBe(false);
    expect(by(checks, "Bun").ok).toBe("warn");
    expect(by(checks, "Remote access").ok).toBe("warn");
    expect(by(checks, "herdr").ok).toBe("warn");
  });

  it("does not warn on Bun in the binary, where the terminal clients are built in", () => {
    const checks = evaluate({ ...healthy, bunVersion: null, embedded: true });
    expect(by(checks, "Bun")).toMatchObject({ ok: true, detail: "not needed (the binary carries the terminal clients)" });
  });

  it("reports the delegation surface, and warns when its bridges are missing", () => {
    expect(by(evaluate(healthy), "Orchestration")).toMatchObject({ ok: true, detail: "on (max 4 children per chat, depth 2, 12 live tasks)" });
    // Turned off in config.yml: a note, not a problem.
    const off = by(evaluate({ ...healthy, orchestration: { ...healthy.orchestration, enabled: false } }), "Orchestration");
    expect(off).toMatchObject({ ok: true, detail: "off (orchestration.enabled is false in config.yml)" });
    // On but unloadable: the server is fine and no agent is given the tools, which is a warning.
    const missing = by(evaluate({ ...healthy, orchestration: { ...healthy.orchestration, missingBridges: ["extensions/orchestrate.ts", "extensions/orchestrate-mcp.mjs"] } }), "Orchestration");
    expect(missing.ok).toBe("warn");
    expect(missing.detail).toContain("extensions/orchestrate.ts");
    expect(render(evaluate({ ...healthy, orchestration: { ...healthy.orchestration, missingBridges: ["extensions/orchestrate.ts"] } }))).toContain("! Orchestration");
  });

  it("warns for a harness whose own config still needs awui's entry", () => {
    expect(by(evaluate(healthy), "MCP tools")).toMatchObject({ ok: true, detail: "every installed harness gets awui's tools per chat" });
    // Hermes is the one manual step, and doctor names where to read the command rather than repeat it.
    const hermes = { harnessId: "hermes", displayName: "Hermes", installed: true, kind: "one-time" as const, detail: "Hermes mounts MCP servers only from its own config", argv: ["hermes", "mcp", "add", "awui"], existing: { verdict: "missing" as const, transport: null, reason: null } };
    expect(by(evaluate({ ...healthy, mcp: [...healthy.mcp, hermes] }), "MCP tools")).toMatchObject({ ok: "warn", detail: "Hermes needs a one-time entry in its own config (`awui setup mcp` prints the command)" });
    // Once it is there, and for a harness that is not installed, nothing is owed.
    expect(by(evaluate({ ...healthy, mcp: [...healthy.mcp, { ...hermes, existing: { verdict: "ours" as const, transport: "awui mcp", reason: null } }] }), "MCP tools").ok).toBe(true);
    expect(by(evaluate({ ...healthy, mcp: [...healthy.mcp, { ...hermes, installed: false }] }), "MCP tools").ok).toBe(true);
    expect(render(evaluate({ ...healthy, mcp: [...healthy.mcp, hermes] }))).toContain("! MCP tools");
  });
  it("reports a config error and never a secret", () => {
    const checks = evaluate({ ...healthy, configError: "config.yml: port must be a number" });
    expect(by(checks, "Config")).toMatchObject({ ok: false });
  });
});

describe("resource pressure", () => {
  it("carries the running server's own view when the port is awui's", () => {
    expect(by(evaluate({ ...healthy, portProbe: { kind: "awui", version: "1.2.3", pressure: "warn" } }), "Resource pressure").ok).toBe("warn");
    expect(by(evaluate({ ...healthy, portProbe: { kind: "awui", version: "1.2.3", pressure: "ok" } }), "Resource pressure").ok).toBe(true);
    // Nothing running here, or a server whose health answer predates the sampler.
    expect(by(evaluate(healthy), "Resource pressure")).toBeUndefined();
  });
});
