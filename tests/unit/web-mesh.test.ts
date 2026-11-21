// The Peers section's wording (src/web/mesh.ts): pure, so every label a mesh
// surface shows is pinned here — the SAS a person compares on two screens, the
// transports, an invite's countdown, and a task's state words.
import { describe, expect, it } from "vitest";
import { approvalLine, sasLabel, sourceLabel, taskStateLabel, timeLeft, transportLabel } from "../../src/web/mesh.js";
import type { MeshApprovalRow } from "../../src/shared/protocol.js";

describe("sasLabel", () => {
  it("splits a six-digit SAS the way a person reads it, from either spelling", () => {
    expect(sasLabel("123456")).toBe("123-456");
    expect(sasLabel("224 517")).toBe("224-517");
    expect(sasLabel("000000")).toBe("000-000");
  });

  it("shows anything else untouched rather than guessing", () => {
    expect(sasLabel("")).toBe("");
    expect(sasLabel("12345")).toBe("12345");
    expect(sasLabel("1234567")).toBe("1234567");
    expect(sasLabel("12a45b")).toBe("12a45b");
  });
});

describe("transportLabel", () => {
  it("names each transport", () => {
    expect(transportLabel("tls")).toBe("TLS");
    expect(transportLabel("ssh")).toBe("SSH");
    expect(transportLabel("docker")).toBe("Docker");
  });
});

describe("sourceLabel", () => {
  it("says where a peer's definition lives", () => {
    expect(sourceLabel("config")).toBe("config.yml");
    expect(sourceLabel("ui")).toBe("saved here");
  });
});

describe("timeLeft", () => {
  const now = 1_000_000;
  it("counts whole minutes first", () => {
    expect(timeLeft(now + 9 * 60_000, now)).toBe("9m left");
    expect(timeLeft(now + 60_000, now)).toBe("1m left");
  });

  it("counts seconds under a minute, never zero", () => {
    expect(timeLeft(now + 45_000, now)).toBe("45s left");
    expect(timeLeft(now + 200, now)).toBe("1s left");
  });

  it("says expired at or past the moment", () => {
    expect(timeLeft(now, now)).toBe("expired");
    expect(timeLeft(now - 1, now)).toBe("expired");
  });
});

describe("taskStateLabel", () => {
  it("uses the sidebar's words for each state", () => {
    expect(taskStateLabel("running")).toBe("Running");
    expect(taskStateLabel("idle")).toBe("Finished");
    expect(taskStateLabel("error")).toBe("Failed");
    expect(taskStateLabel("disposed")).toBe("Closed");
  });

  it("shows an unknown state as-is, never blank", () => {
    expect(taskStateLabel("paused")).toBe("paused");
  });
});

describe("approvalLine", () => {
  it("reads as who, what, and how long is left", () => {
    const approval: MeshApprovalRow = {
      id: "ap_1",
      peerName: "lab-vm-3",
      nodeId: "node-1",
      method: "fs.write",
      cap: "fs.write",
      summary: "fs.write into ~/code/app.ts",
      root: "/home/me/code",
      createdAt: 0,
      expiresAt: 300_000,
    };
    expect(approvalLine(approval, 0)).toBe("lab-vm-3: fs.write into ~/code/app.ts · 5m left");
    expect(approvalLine(approval, 300_000)).toBe("lab-vm-3: fs.write into ~/code/app.ts · expired");
  });
});
