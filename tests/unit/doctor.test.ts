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
  windows: false,
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

  it("reports a config error and never a secret", () => {
    const checks = evaluate({ ...healthy, configError: "config.yml: port must be a number" });
    expect(by(checks, "Config")).toMatchObject({ ok: false });
  });
});
