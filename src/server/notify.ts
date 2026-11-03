// Notifications: a short note when a run finishes, fails, or asks for an
// answer, pushed to every device that turned them on. The push carries no
// payload (so nothing about the chat passes through the browser vendor's push
// service and no payload encryption is needed); the service worker fetches
// the note from this server with the device's own cookie. Push requests are
// signed with a VAPID key kept in the state folder.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import path from "node:path";
import { approvalAnswers } from "../shared/approval.js";
import type { InteractionRequest, PushNote } from "../shared/protocol.js";
import { isObj, readJson, writeJson } from "./state-file.js";

const MAX_NOTES = 50;
const PUSH_TTL_S = 3600;
/** The browsers' push services; a subscription anywhere else is refused, so this server never posts to an arbitrary URL. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function pushEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "Not a URL";
  }
  if (url.protocol !== "https:") return "Push endpoints are HTTPS";
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return "Not a known browser push service";
  return null;
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** The application server key browsers subscribe with: the raw uncompressed P-256 point. */
export function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  return b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, "base64url"), Buffer.from(jwk.y as string, "base64url")]));
}

/** RFC 8292: `vapid t=<ES256 JWT for the push service's origin>, k=<public key>`. */
export function vapidAuthorization(endpoint: string, privateKey: KeyObject, publicKey: KeyObject, now = Date.now()): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: "mailto:awui@localhost" }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${rawPublicKey(publicKey)}`;
}

interface Subscription {
  endpoint: string;
  addedAt: number;
}

/**
 * A Board room's note as a push note. A room's bots are no ordinary chats (their
 * chat routes answer 404), so the note names the room: a click opens it, and an
 * approval's Approve/Deny goes to the room's answer route.
 */
export function roomPushNote(note: { kind: PushNote["kind"]; roomId: string; title: string; body: string; request?: InteractionRequest }): Omit<PushNote, "id" | "at"> {
  const answers = note.request ? approvalAnswers(note.request) : null;
  return {
    kind: note.kind,
    chatId: "",
    roomId: note.roomId,
    sessionId: null,
    title: note.title,
    body: note.body,
    ...(note.request && answers ? { approval: { requestId: note.request.id, ...answers } } : {}),
  };
}

export type PushFetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number }>;

export class Notifier {
  private notes: PushNote[] = [];
  private subscriptions: Subscription[] = [];
  private counter = 0;

  private constructor(
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
    private readonly subscriptionsFile: string | null,
    private readonly fetcher: PushFetch,
    private readonly log: (message: string) => void,
  ) {}

  static inMemory(fetcher: PushFetch = fetch as unknown as PushFetch): Notifier {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return new Notifier(privateKey, publicKey, null, fetcher, () => undefined);
  }

  static async open(stateDir: string, log: (message: string) => void): Promise<Notifier> {
    const keyFile = path.join(stateDir, "vapid.json");
    const stored = await readJson(keyFile);
    let privateKey: KeyObject;
    if (isObj(stored) && stored.kty === "EC") {
      privateKey = createPrivateKey({ key: stored as JsonWebKey, format: "jwk" });
    } else {
      privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
      await writeJson(keyFile, privateKey.export({ format: "jwk" }));
    }
    const file = path.join(stateDir, "push-subscriptions.json");
    const notifier = new Notifier(privateKey, createPublicKey(privateKey), file, fetch as unknown as PushFetch, log);
    const subs = await readJson(file);
    if (Array.isArray(subs)) {
      notifier.subscriptions = subs.filter((s): s is Subscription => isObj(s) && typeof s.endpoint === "string" && pushEndpointProblem(s.endpoint) === null);
    }
    return notifier;
  }

  get applicationServerKey(): string {
    return rawPublicKey(this.publicKey);
  }

  async subscribe(endpoint: string): Promise<void> {
    if (this.subscriptions.some((s) => s.endpoint === endpoint)) return;
    this.subscriptions.push({ endpoint, addedAt: Date.now() });
    await writeJson(this.subscriptionsFile, this.subscriptions);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) await writeJson(this.subscriptionsFile, this.subscriptions);
  }

  /** Notes newer than `since` (epoch ms), oldest first. */
  since(since: number): PushNote[] {
    return this.notes.filter((n) => n.at > since);
  }

  /** Record a note and wake every subscribed device (or just `only`, for a test). */
  notify(note: Omit<PushNote, "id" | "at">, only?: string): PushNote {
    const full: PushNote = { ...note, id: `${Date.now().toString(36)}-${++this.counter}`, at: Date.now() };
    this.notes.push(full);
    if (this.notes.length > MAX_NOTES) this.notes.splice(0, this.notes.length - MAX_NOTES);
    const targets = only ? this.subscriptions.filter((s) => s.endpoint === only) : this.subscriptions;
    for (const s of targets) void this.push(s.endpoint);
    return full;
  }

  private async push(endpoint: string): Promise<void> {
    try {
      const res = await this.fetcher(endpoint, {
        method: "POST",
        headers: {
          Authorization: vapidAuthorization(endpoint, this.privateKey, this.publicKey),
          TTL: String(PUSH_TTL_S),
          Urgency: "high",
          "Content-Length": "0",
        },
      });
      // Gone: the browser dropped the subscription (permission revoked, site data cleared).
      if (res.status === 404 || res.status === 410) await this.unsubscribe(endpoint);
      else if (res.status >= 400) this.log(`push to ${new URL(endpoint).hostname} failed: HTTP ${res.status}`);
    } catch (error) {
      this.log(`push to ${new URL(endpoint).hostname} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
