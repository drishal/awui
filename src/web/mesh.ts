// The Peers section's words, pure (mesh P2 §4): status labels, the SAS a
// person compares on two screens, transport names, and an invite's time
// left. Nothing here talks to the server or holds state — the panel draws,
// this file decides the wording, and tests/unit/web-mesh.test.ts pins it.
import type { MeshApprovalRow, MeshHostTermRow, MeshPeerRow, MeshTaskRow } from "../shared/protocol.js";

/** The six-digit SAS as a person reads it: "123-456". The wire spells it "123 456"; a malformed value is shown untouched, never guessed at. */
export function sasLabel(sas: string): string {
  const digits = sas.replace(/\D/g, "");
  return digits.length === 6 && sas.replace(/[^\d ]/g, "") === sas ? `${digits.slice(0, 3)}-${digits.slice(3)}` : sas;
}

/** One transport's name, as the peers list and the add form spell it. */
export function transportLabel(transport: MeshPeerRow["transport"]): string {
  return transport === "tls" ? "TLS" : transport === "ssh" ? "SSH" : "Docker";
}

/** Where a peer's definition lives, in one short phrase. */
export function sourceLabel(source: MeshPeerRow["source"]): string {
  return source === "config" ? "config.yml" : "saved here";
}

/** An invite's or approval's remaining time, in the largest whole unit that is not zero. */
export function timeLeft(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1) return `${minutes}m left`;
  return `${Math.max(1, Math.floor(ms / 1000))}s left`;
}

/** A task's state in the sidebar's own words; an unknown value is shown as-is, never blank. */
export function taskStateLabel(state: MeshTaskRow["state"]): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "idle":
      return "Finished";
    case "compacting":
      return "Compacting";
    case "error":
      return "Failed";
    case "disposed":
      return "Closed";
    default:
      return state;
  }
}

/** One ask approval's one-line reading: who asks, for what, and how long the person has left to answer. */
export function approvalLine(approval: MeshApprovalRow, now: number): string {
  return `${approval.peerName}: ${approval.summary} · ${timeLeft(approval.expiresAt, now)}`;
}

/** One peer terminal's one-line reading for the owner's list (finding #2): whose it is, where it runs, and its size. */
export function hostTermLine(term: MeshHostTermRow): string {
  return `${term.peerName}: ${term.cwd} · ${term.cols}×${term.rows}${term.exited ? " · exited" : ""}`;
}
