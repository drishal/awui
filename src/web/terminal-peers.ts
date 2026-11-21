// Peer terminals in the panel (P3): which configured peers a "New terminal
// on…" menu may name. The answer comes from GET /api/mesh, whose peers rows
// carry what peer.info advertises — the cap list that says whether the peer's
// own policy opens `term.open` at all. The exact cap shape is the mesh server's
// (it is being written in step with this), so the read is deliberately
// tolerant: a cap list spelled as a flat array, as the info's allow/ask split,
// or as a name-to-decision map all count; anything else is not a terminal
// peer. Pure, so the panel stays layout and this stays testable.
/** One configured peer the panel can open a terminal on. */
export interface MeshPeerTarget {
  name: string;
}

/** How a peer's capability list may spell "term.open is open here". */
export function advertisesTermOpen(caps: unknown): boolean {
  if (Array.isArray(caps)) {
    return caps.some((cap) => cap === "term.open");
  }
  if (typeof caps === "object" && caps !== null) {
    const record = caps as Record<string, unknown>;
    const lists = ["allow", "ask"].filter((k) => Array.isArray(record[k]));
    if (lists.length > 0) {
      return lists.some((k) => (record[k] as unknown[]).some((cap) => cap === "term.open"));
    }
    // A name-to-decision map: term.open present with any decision short of deny.
    const decision = record["term.open"];
    return typeof decision === "string" && decision !== "deny";
  }
  return false;
}

/** The configured peers this panel's "New terminal on…" menu can offer, in the order the server listed them. */
export function peerTerminals(payload: unknown): MeshPeerTarget[] {
  if (typeof payload !== "object" || payload === null) return [];
  const peers = (payload as { peers?: unknown }).peers;
  if (!Array.isArray(peers)) return [];
  const targets: MeshPeerTarget[] = [];
  for (const entry of peers) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 64) continue;
    if (!advertisesTermOpen(record.caps)) continue;
    targets.push({ name });
  }
  return targets;
}
