import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { meshConfig, meshDetachedTtlHours, meshEnabled, readUserConfig } from "../../src/server/user-config.js";
import { tempDir } from "../helpers/app.js";

function folder(yaml?: string): string {
  const dir = path.join(tempDir("awui-mesh-config-"), "awui");
  mkdirSync(dir, { recursive: true });
  if (yaml !== undefined) writeFileSync(path.join(dir, "config.yml"), yaml);
  return dir;
}

/** A peer line that is valid on its own, with one field replaced. */
const peer = (over: string) => `mesh:
  enabled: true
  peers:
    - name: lab-vm-3
      ssh: drishal@lab-vm-3
      ${over}`;

describe("mesh config", () => {
  it("is off unless config.yml says enabled: true, and AWUI_MESH=0 can only turn it off", () => {
    expect(meshEnabled(undefined, {})).toBe(false);
    expect(meshEnabled(readUserConfig(folder("mesh: {}\n"))?.config, {})).toBe(false);
    expect(meshEnabled(readUserConfig(folder("mesh: {}\n"))?.config, { AWUI_MESH: "1" })).toBe(false);
    expect(meshEnabled(readUserConfig(folder("mesh:\n  enabled: true\n"))?.config, {})).toBe(true);
    expect(meshEnabled(readUserConfig(folder("mesh:\n  enabled: true\n"))?.config, { AWUI_MESH: "1" })).toBe(true);
    // No variable forces the mesh on: env only vetoes.
    expect(meshEnabled(undefined, { AWUI_MESH: "1" })).toBe(false);
    expect(meshEnabled(readUserConfig(folder("mesh:\n  enabled: true\n"))?.config, { AWUI_MESH: "0" })).toBe(false);
    expect(meshConfig(undefined)).toBeUndefined();
    expect(meshConfig(readUserConfig(folder("mesh:\n  enabled: true\n"))?.config)).toEqual({ enabled: true });
  });

  it("accepts a full block", () => {
    const read = readUserConfig(folder(`mesh:
  enabled: true
  name: my-box
  max_hops: 1
  max_remote_tasks: 8
  chats: lead-only
  policies:
    worker:
      caps: [discover, task.run]
      ask: [fs.write]
      roots: [~/code]
      harnesses: [pi]
      permission_ceiling: auto-edit
      max_tasks: 4
      max_file_bytes: 52428800
      approvals_at: origin
  peers:
    - name: lab-vm-3
      ssh: drishal@lab-vm-3
      ssh_opts: ["-p", "2222"]
      awui_path: /home/drishal/.local/bin/awui
      inbound_policy: worker
    - name: ci-box
      docker: awui-worker-1
      engine: podman
`));
    const mesh = meshConfig(read?.config)!;
    expect(mesh.enabled).toBe(true);
    expect(mesh.name).toBe("my-box");
    expect(mesh.max_hops).toBe(1);
    expect(mesh.max_remote_tasks).toBe(8);
    expect(mesh.chats).toBe("lead-only");
    expect(mesh.policies?.worker?.caps).toEqual(["discover", "task.run"]);
    expect(mesh.peers?.[0]).toMatchObject({ name: "lab-vm-3", ssh: "drishal@lab-vm-3", inbound_policy: "worker" });
    expect(mesh.peers?.[1]).toMatchObject({ name: "ci-box", docker: "awui-worker-1", engine: "podman" });
    expect(meshEnabled(read?.config, {})).toBe(true);
  });

  it("rejects max_hops other than 1, out-of-bounds numbers, and unknown caps", () => {
    expect(() => readUserConfig(folder("mesh:\n  max_hops: 2\n"))).toThrow(/max_hops/);
    expect(() => readUserConfig(folder("mesh:\n  max_remote_tasks: 0\n"))).toThrow(/max_remote_tasks/);
    expect(() => readUserConfig(folder("mesh:\n  max_remote_tasks: 65\n"))).toThrow(/max_remote_tasks/);
    expect(() => readUserConfig(folder(`mesh:
  policies:
    worker:
      caps: [exec]
`))).toThrow(/caps/);
    expect(() => readUserConfig(folder(`mesh:
  policies:
    worker:
      permission_ceiling: yolo
`))).toThrow(/permission_ceiling/);
    expect(() => readUserConfig(folder(`mesh:
  policies:
    worker:
      max_file_bytes: 0
`))).toThrow(/max_file_bytes/);
    // A misspelled key is named, like every other setting.
    expect(() => readUserConfig(folder("mesh:\n  enbled: true\n"))).toThrow(/mesh/);
  });

  it("rejects a peer with both ssh and docker, or neither", () => {
    expect(() => readUserConfig(folder(`mesh:
  peers:
    - name: lab-vm-3
      ssh: drishal@lab-vm-3
      docker: awui-worker-1
`))).toThrow(/ssh/);
    expect(() => readUserConfig(folder(`mesh:
  peers:
    - name: lab-vm-3
`))).toThrow(/ssh/);
  });

  it("rejects duplicate peer names, case-insensitively", () => {
    expect(() =>
      readUserConfig(folder(`mesh:
  peers:
    - name: lab-vm-3
      ssh: a@b
    - name: Lab-VM-3
      docker: box
`)),
    ).toThrow(/already defined/);
  });

  it("rejects an unknown inbound_policy, and a policy named none", () => {
    expect(() => readUserConfig(folder(peer("inbound_policy: goldfish\n")))).toThrow(/inbound_policy/);
    // A configured policy satisfies it; the built-ins always do.
    expect(readUserConfig(folder(`mesh:
  policies:
    goldfish:
      caps: [discover]
  peers:
    - name: lab-vm-3
      ssh: drishal@lab-vm-3
      inbound_policy: goldfish
`))?.config.mesh?.peers?.[0]?.inbound_policy).toBe("goldfish");
    expect(() => readUserConfig(folder(`mesh:
  policies:
    none:
      caps: [fs.read]
`))).toThrow(/none/);
  });

  it("accepts a detached TTL in hours, and defaults it to a day", () => {
    expect(meshDetachedTtlHours(undefined)).toBe(24);
    expect(meshDetachedTtlHours(readUserConfig(folder("mesh: {}\n"))?.config)).toBe(24);
    expect(meshDetachedTtlHours(readUserConfig(folder("mesh:\n  detached_ttl_hours: 720\n"))?.config)).toBe(720);
    expect(() => readUserConfig(folder("mesh:\n  detached_ttl_hours: 0\n"))).toThrow(/detached_ttl_hours/);
    expect(() => readUserConfig(folder("mesh:\n  detached_ttl_hours: 721\n"))).toThrow(/detached_ttl_hours/);
    expect(() => readUserConfig(folder("mesh:\n  detached_ttl_hours: 1.5\n"))).toThrow(/detached_ttl_hours/);
  });

  it("rejects ssh_opts with a newline or a NUL, and a bad name shape", () => {
    expect(() => readUserConfig(folder(peer('ssh_opts: ["-p", "2222\\nrm -rf /"]\n')))).toThrow(/newline/);
    expect(() => readUserConfig(folder(`mesh:\n  peers:\n    - name: has space\n      ssh: a@b\n`))).toThrow(/name/);
    expect(() => readUserConfig(folder("mesh:\n  policies:\n    None:\n      caps: []\n"))).toThrow(/policies/);
  });

  it("rejects an ssh destination or container that would read as an option", () => {
    expect(() => readUserConfig(folder(`mesh:\n  peers:\n    - name: a\n      ssh: -oProxyCommand=evil\n`))).toThrow(/ssh/);
    expect(() => readUserConfig(folder(`mesh:\n  peers:\n    - name: a\n      ssh: "a b"\n`))).toThrow(/ssh/);
    expect(() => readUserConfig(folder(`mesh:\n  peers:\n    - name: a\n      docker: --privileged\n`))).toThrow(/docker/);
    expect(readUserConfig(folder(`mesh:\n  peers:\n    - name: a\n      ssh: drishal@[fd7a::1]\n    - name: b\n      docker: awui-worker_1\n`))?.config.mesh?.peers?.length).toBe(2);
  });
});
