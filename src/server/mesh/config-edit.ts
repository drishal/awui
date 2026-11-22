// Writing a peer back into config.yml (the sync half of "add a machine"):
// peers added from a chat, the Settings dialog, or `awui peer join` live in
// peers.json, which outlives restarts but is not the file a person versions or
// expects to read. This module moves one saved peer into config.yml's
// `mesh.peers` when — and only when — that file is a plain, writable regular
// file whose mesh is already enabled. A symlinked config.yml is a module's
// rendered output and is refused untouched, the same rule Settings follows.
// The document is parsed with yaml's Document so comments and key order
// survive, then validated by the same schema startup uses before the write;
// a sync that would not start is never written.
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSeq, parseDocument } from "yaml";
import { checkUserConfig, CONFIG_FILE } from "../user-config.js";
import type { MeshPeerEntry, MeshPeerStore } from "./peer-store.js";

/** One peer written into config.yml, or why it stayed in peers.json. */
export type PeerConfigWrite = { ok: true; already: boolean } | { ok: false; reason: string };

/** What a sync moved, what stayed and why, and names no saved peer matched. */
export interface SyncPeersResult {
  moved: string[];
  kept: { name: string; reason: string }[];
  unknown: string[];
}

function failure(reason: string): PeerConfigWrite {
  return { ok: false, reason };
}

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One peers[] entry's name, lowercased, or "" for a value that is not one. */
function peerNameOf(value: unknown): string {
  if (value === null || typeof value !== "object" || !("name" in value) || typeof value.name !== "string") return "";
  return value.name.toLowerCase();
}

/** Appends one peer under mesh.peers in config.yml, or says why it cannot. */
export function appendMeshPeer(configDir: string | null, entry: MeshPeerEntry): PeerConfigWrite {
  if (configDir === null) return failure("this server runs without a settings folder (AWUI_CONFIG_DIR is empty)");
  const file = path.join(configDir, CONFIG_FILE);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return failure("there is no config.yml to write");
  }
  if (stat.isSymbolicLink()) return failure(`${CONFIG_FILE} is a symlink (a module renders it), so this server leaves it alone`);
  if (!stat.isFile()) return failure(`${CONFIG_FILE} is not a regular file`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return failure(`${CONFIG_FILE} could not be read: ${said(error)}`);
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return failure(`${CONFIG_FILE} is not valid YAML: ${doc.errors[0]?.message.split("\n")[0] ?? "parse error"}`);
  if (doc.getIn(["mesh", "enabled"]) !== true) return failure(`mesh.enabled is not true in ${CONFIG_FILE}, so a peer added there would be inert`);
  const node = doc.getIn(["mesh", "peers"], true);
  const asJson = isSeq(node) ? node.toJSON() : undefined;
  const names = Array.isArray(asJson) ? asJson.map(peerNameOf) : [];
  if (names.includes(entry.name.toLowerCase())) return { ok: true, already: true };
  if (node === undefined) doc.setIn(["mesh", "peers"], [entry]);
  else if (isSeq(node)) node.add(entry);
  else return failure(`${CONFIG_FILE}'s mesh.peers is not a list`);
  try {
    checkUserConfig(doc.toJS({ maxAliasCount: 10 }), CONFIG_FILE);
  } catch (error) {
    return failure(`the change would not pass startup's check: ${said(error)}`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // 0600 like Settings: config.yml may hold the sign-in password.
    writeFileSync(tmp, doc.toString(), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    return failure(`${CONFIG_FILE} could not be written: ${said(error)}`);
  }
  return { ok: true, already: false };
}

/**
 * Moves saved peers into config.yml, newest source winning: a peer written
 * there is dropped from peers.json so one machine has one entry. Names the
 * caller asked for that are not saved are reported, not invented.
 */
export async function syncPeersToConfig(
  configDir: string | null,
  saved: Pick<MeshPeerStore, "list" | "remove">,
  names?: string[],
): Promise<SyncPeersResult> {
  const all = await saved.list();
  const asked = names?.map((name) => name.toLowerCase()).filter((name, index, list) => list.indexOf(name) === index);
  const unknown = asked?.filter((name) => !all.some((peer) => peer.name.toLowerCase() === name)) ?? [];
  const wanted = asked === undefined ? all : all.filter((peer) => asked.includes(peer.name.toLowerCase()));
  const result: SyncPeersResult = { moved: [], kept: [], unknown };
  for (const entry of wanted) {
    const written = appendMeshPeer(configDir, entry);
    if (!written.ok) {
      result.kept.push({ name: entry.name, reason: written.reason });
      continue;
    }
    // Already in config.yml (config wins on a clash): the saved copy is the shadow, so drop it.
    await saved.remove(entry.name);
    result.moved.push(entry.name);
  }
  return result;
}
