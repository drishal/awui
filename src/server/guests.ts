// Expiring single-chat guests: owners intentionally share one normal chat.
// Guests read a limited text projection and propose input; only a real owner can send it.
// State stores SHA-256 of invitation+client keys and bounded pending texts, never loaded user credentials.
import { createHash, randomBytes } from "node:crypto";
import type { ChatItem, WorkspaceInfo } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { isObj, readJson, writeJsonChecked } from "./state-file.js";

export const GUEST_TTL_MS = 24 * 60 * 60_000;
const MAX_GUESTS = 32;
const MAX_MESSAGES = 32;
const MAX_TEXT = 4_000;

export interface GuestTarget {
  harnessId: string;
  nativeId: string;
  workspace: WorkspaceInfo;
  title: string;
}

export interface GuestView {
  id: string;
  title: string;
  harnessId: string;
  workspaceName: string;
  expiresAt: number;
  browserSession: "bound" | "unused";
  pending: Array<{ id: string; text: string; at: number }>;
}

interface PendingMessage {
  id: string;
  text: string;
  clientId: string;
  at: number;
  state: "queued" | "sending" | "sent" | "dismissed";
}
interface GuestRecord {
  id: string;
  tokenHash: string;
  browserHash: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  target: GuestTarget;
  messages: PendingMessage[];
}

const hash = (val: string): string => createHash("sha256").update(val).digest("hex");

/** Load only trusted shape variants; malformed data never becomes an owner selection. */
function wireGuest(raw: unknown): GuestRecord | null {
  if (!isObj(raw) || typeof raw.id !== "string" || !/^[a-f0-9]{32}$/.test(raw.id)) return null;
  if (typeof raw.tokenHash !== "string" || (raw.browserHash !== null && typeof raw.browserHash !== "string")) return null;
  if (typeof raw.createdAt !== "number" || typeof raw.expiresAt !== "number") return null;
  if (raw.revokedAt !== null && typeof raw.revokedAt !== "number") return null;
  if (!isObj(raw.target) || !isObj(raw.target.workspace)) return null;
  const target = raw.target as Record<string, unknown>;
  const ws = target.workspace as Record<string, unknown>;
  if (typeof target.harnessId !== "string" || typeof target.nativeId !== "string" || typeof target.title !== "string") return null;
  if (typeof ws.id !== "string" || typeof ws.path !== "string" || typeof ws.name !== "string") return null;
  const targetInfo: GuestTarget = { harnessId: target.harnessId, nativeId: target.nativeId, title: target.title, workspace: { id: ws.id, path: ws.path, name: ws.name } };
  const messages = Array.isArray(raw.messages) ? raw.messages.filter((m): m is PendingMessage => isObj(m) && typeof m.id === "string" && typeof m.text === "string" && m.text.length <= MAX_TEXT && typeof m.at === "number" && typeof m.clientId === "string" && typeof m.state === "string" && ["queued", "sending", "sent", "dismissed"].includes(m.state)) : [];
  const createdAt = raw.createdAt;
  const expiresAt = raw.expiresAt;
  const revokedAt = raw.revokedAt as number | null;
  const browserHash = raw.browserHash as string | null;
  return { id: raw.id, tokenHash: raw.tokenHash, createdAt, expiresAt, revokedAt, browserHash, target: targetInfo, messages };
}

export class GuestStore {
  private readonly records = new Map<string, GuestRecord>();
  private readonly ready: Promise<void>;

  constructor(private readonly file: string | null, private readonly now = () => Date.now()) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const data = await readJson(this.file);
    if (!isObj(data) || !Array.isArray(data.guests)) return;
    for (const raw of data.guests) {
      const parsed = wireGuest(raw);
      if (parsed) this.records.set(parsed.id, parsed);
    }
    // Expired and revoked links from a previous process are not invitations any more:
    // they go now, so they cannot hold the cap against the live ones.
    this.prune();
  }

  async create(target: GuestTarget): Promise<{ record: GuestView; token: string }> {
    await this.ready;
    // The cap counts live links, not every link ever made: a revoked or expired one is
    // dropped here, so a long history of shares never locks the feature.
    this.prune();
    if (this.records.size >= MAX_GUESTS) throw new ChatError(429, "guest_limit", "Revoke an older share before making another. At most 32 links are allowed.");
    const id = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("base64url");
    this.records.set(id, {
      id, tokenHash: hash(token), browserHash: null, createdAt: this.now(), expiresAt: this.now() + GUEST_TTL_MS, revokedAt: null, target, messages: [],
    });
    await this.save();
    return { record: this.view(this.records.get(id)!), token };
  }

  async redeem(token: string, oldBrowserKey?: string): Promise<{ view: GuestView; browserKey: string }> {
    await this.ready;
    if (typeof token !== "string" || token.length < 16 || token.length > 100) throw new ChatError(410, "guest_expired", "Guest link expired or invalid");
    const record = [...this.records.values()].find((record) => record.tokenHash === hash(token));
    if (!this.valid(record)) throw new ChatError(410, "guest_expired", "Guest link is expired or revoked");
    if (record.browserHash && record.browserHash !== hash(oldBrowserKey ?? "")) throw new ChatError(403, "guest_in_use", "This link was already claimed by another browser");
    const browserKey = oldBrowserKey && record.browserHash === hash(oldBrowserKey) ? oldBrowserKey : randomBytes(32).toString("base64url");
    record.browserHash = hash(browserKey);
    await this.save();
    return { view: this.view(record), browserKey };
  }

  async session(browserKey: string): Promise<GuestView> {
    await this.ready;
    const record = [...this.records.values()].find((record) => record.browserHash === hash(browserKey));
    if (!this.valid(record)) throw new ChatError(410, "guest_expired", "Guest session expired or revoked");
    return this.view(record);
  }

  async target(guestId: string): Promise<GuestTarget> {
    await this.ready;
    const record = this.records.get(guestId);
    if (!this.valid(record)) throw new ChatError(410, "guest_expired", "This invitation has expired");
    return record.target;
  }

  async offer(browserKey: string, clientId: string, text: string): Promise<void> {
    await this.ready;
    const record = [...this.records.values()].find((row) => row.browserHash === hash(browserKey));
    if (!this.valid(record)) throw new ChatError(410, "guest_expired", "This guest session expired");
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(clientId)) throw new ChatError(400, "invalid_request_id", "Retry ids are bounded opaque strings");
    const content = text.trim();
    if (!content || content.length > MAX_TEXT) throw new ChatError(422, "invalid_guest_message", "Write up to 4,000 characters for the owner to evaluate");
    if (record.messages.length >= MAX_MESSAGES) throw new ChatError(429, "guest_queue_limit", "Waiting queue is full; the owner must review a message before more can arrive");
    if (record.messages.some((m) => m.clientId === clientId)) {
      if (record.messages.find((m) => m.clientId === clientId)?.text === content) return;
      throw new ChatError(409, "request_reused", "This retry id belongs to another message; exactly matching retries are replay-safe");
    }
    record.messages.push({ id: randomBytes(8).toString("hex"), text: content, clientId, at: this.now(), state: "queued" });
    await this.save();
  }

  async claim(guestId: string, messageId: string): Promise<string | null> {
    const row = this.records.get(guestId)?.messages.find((m) => m.id === messageId && m.state === "queued");
    if (!row) return null;
    row.state = "sending";
    await this.save();
    return row.text;
  }

  async markSent(guestId: string, messageId: string): Promise<void> {
    const row = this.records.get(guestId)?.messages.find((m) => m.id === messageId);
    if (row && row.state === "sending") row.state = "sent";
    await this.save();
  }

  async requeue(guestId: string, messageId: string): Promise<void> {
    const row = this.records.get(guestId)?.messages.find((m) => m.id === messageId);
    if (row && row.state !== "sent") row.state = "queued";
    await this.save();
  }

  async dismiss(guestId: string, messageId: string): Promise<boolean> {
    const row = this.records.get(guestId)?.messages.find((m) => m.id === messageId);
    if (!row || row.state === "sent") return false;
    row.state = "dismissed";
    await this.save();
    return true;
  }

  async revoke(guestId: string): Promise<boolean> {
    const row = this.records.get(guestId);
    if (!row) return false;
    row.revokedAt = this.now();
    row.browserHash = null;
    await this.save();
    return true;
  }

  /** The live links for one session; both its harness and its native id name it (ids are harness-scoped). */
  async list(harnessId?: string, nativeId?: string): Promise<GuestView[]> {
    await this.ready;
    this.prune();
    return [...this.records.values()].filter((record) => (!harnessId || record.target.harnessId === harnessId) && (!nativeId || record.target.nativeId === nativeId)).map((r) => this.view(r));
  }

  /**
   * Reveal only human-authored/harness answer text items. Internal tool/parameters,
   * credentials, approval bodies, provider counts and full configuration never leave the owner.
   */
  static readonly history = (items: ChatItem[]) => items.flatMap((i) => i.kind === "user" || i.kind === "assistant" ? [{ id: i.id, kind: i.kind, text: i.text.slice(0, 16_384), ...(typeof i.at === "number" ? { at: i.at } : {}) }] : []).slice(-200);

  /** Drop every record that is no longer a live invitation (revoked or past its TTL). */
  private prune(): void {
    for (const [id, record] of this.records) if (!this.valid(record)) this.records.delete(id);
  }

  private valid(row: GuestRecord | undefined): row is GuestRecord {
    return row !== undefined && row.revokedAt === null && row.expiresAt > this.now();
  }

  private view(record: GuestRecord): GuestView {
    return { id: record.id, title: record.target.title, harnessId: record.target.harnessId, workspaceName: record.target.workspace.name, expiresAt: record.expiresAt, browserSession: record.browserHash ? "bound" : "unused", pending: record.messages.filter((m) => m.state === "queued").map(({ id, text, at }) => ({ id, text, at })) };
  }

  private save(): Promise<void> {
    return writeJsonChecked(this.file, { guests: [...this.records.values()] });
  }
}
