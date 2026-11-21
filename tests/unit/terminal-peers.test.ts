// The terminal panel's peer list (src/web/terminal-peers.ts): what GET /api/mesh
// must say before a "New terminal on…" menu offers a peer, and the tolerance it
// shows the cap list's shape while the mesh server's own spelling settles.
import { describe, expect, it } from "vitest";
import { advertisesTermOpen, peerTerminals } from "../../src/web/terminal-peers.js";

describe("peerTerminals", () => {
  it("offers the peers whose caps advertise term.open, in listed order", () => {
    expect(peerTerminals({ enabled: true, peers: [
      { name: "lab-vm-3", caps: ["discover", "term.open"] },
      { name: "reader", caps: ["discover"] },
      { name: "writer", caps: { allow: ["discover"], ask: ["term.open"] } },
      { name: "mapped", caps: { "term.open": "ask" } },
      { name: "denied", caps: { "term.open": "deny" } },
      { name: "" },
      { no: "name" },
    ] })).toEqual([{ name: "lab-vm-3" }, { name: "writer" }, { name: "mapped" }]);
  });

  it("answers nothing for a mesh-off payload, a missing list, or junk", () => {
    expect(peerTerminals(undefined)).toEqual([]);
    expect(peerTerminals({ enabled: false })).toEqual([]);
    expect(peerTerminals({ peers: "all" })).toEqual([]);
    expect(peerTerminals(null)).toEqual([]);
  });

  it("advertisesTermOpen is false for a cap list of any other shape", () => {
    expect(advertisesTermOpen("term.open")).toBe(false);
    expect(advertisesTermOpen(null)).toBe(false);
    expect(advertisesTermOpen({ other: ["term.open"] })).toBe(false);
    expect(advertisesTermOpen({ ask: ["term.open"] })).toBe(true);
  });
});
