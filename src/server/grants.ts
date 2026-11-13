// Additive grants for limited remote sessions (E3). A password sign-in is full
// access — that is the backwards-compatible default. A limited session is issued
// by an invitation's own one-time secret, never the owner's password: the cookie
// then carries only the invitation's id and the server resolves that id's allow
// list on every request (so a revocation, or an edit to an invitation's grants,
// applies at once, and a revoked invitation has no secret left to sign in with).
// No entitlement travels in the cookie or a header, and only the secret's hash
// is stored here.
//
// Grants are a small fixed vocabulary, not roles: there is no role that
// duplicates all-authority. Local requests (this machine) are always full.
//
//  chat.read        Read chats, sessions, files, usage, and events.
//  chat.write       Send prompts, approve/deny, open/close/resume chats, run commands, git writes.
//  settings.manage  Read and change settings, restart the server, manage providers and ACP agents.
//  workspaces.manage Open workspaces, browse the host filesystem, manage worktrees and terminals.
//  routines.manage  Create, change, run, and delete routines and their webhooks.
//  boards.manage    Manage board bots, rooms, members, and their queues.
//
// Everything an invitation does not name is refused with 403 `missing_grant`,
// which names the grant so the invite UI can say what is missing.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { isObj, readJson, writeJsonChecked } from "./state-file.js";

/** The params shape a route's handler reads: its named keys stay strings. */
type RouteParams<P extends object> = Request<P>;

/** The fixed grant vocabulary. Never extend it without a route that checks it. */
export const GRANTS = ["chat.read", "chat.write", "chat.approve", "settings.manage", "workspaces.manage", "routines.manage", "boards.manage"] as const;
export type Grant = (typeof GRANTS)[number];
export const isGrant = (v: unknown): v is Grant => typeof v === "string" && (GRANTS as readonly string[]).includes(v);

export const GRANTS_FILE = "invites.json";
/** Invitations remembered at once; each is a few dozen bytes. */
const MAX_INVITES = 200;

export interface Invite {
  /** Opaque id (the cookie carries this and nothing else about the grants). */
  id: string;
  name: string;
  grants: Grant[];
  createdAt: number;
}

/** A stored invitation: the list's view, plus the one-way hash of its sign-in secret. */
interface InviteRecord extends Invite {
  secretHash: string;
}

/** A secret at rest: 256 random bits, so a plain SHA-256 is enough to verify a presented one. */
const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** What the panel sees: never the hash, only the name and the grants. */
const view = (record: InviteRecord): Invite => ({ id: record.id, name: record.name, grants: [...record.grants], createdAt: record.createdAt });

export class InviteStore {
  private invites = new Map<string, InviteRecord>();
  private readonly ready: Promise<void>;

  constructor(private readonly file: string | null, private readonly log: (message: string) => void = () => undefined) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const data = await readJson(this.file);
    if (!isObj(data)) return;
    for (const [id, raw] of Object.entries(data)) {
      if (this.invites.size >= MAX_INVITES) break;
      if (!isObj(raw) || typeof raw.name !== "string" || raw.name.length === 0) continue;
      // A row without a secret hash cannot sign in (it predates the secret): it is
      // dropped, so the panel never lists an invitation whose link is dead on arrival.
      if (typeof raw.secretHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.secretHash)) continue;
      const grants = Array.isArray(raw.grants) ? [...new Set(raw.grants.filter(isGrant))] : [];
      // An invitation whose every grant was edited away would lock its holder out of
      // everything but sign-in; it is kept (the holder can still read their own grants),
      // but an empty list is only ever made on purpose, never by a malformed file.
      if (grants.length === 0) continue;
      this.invites.set(id, { id, name: raw.name, grants, createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(), secretHash: raw.secretHash });
    }
  }

  /** Resolves once the file has been read: call before the first check. */
  get loaded(): Promise<void> {
    return this.ready;
  }

  list(): Invite[] {
    return [...this.invites.values()].sort((a, b) => b.createdAt - a.createdAt).map(view);
  }

  get(id: string): Invite | null {
    const record = this.invites.get(id);
    return record ? view(record) : null;
  }

  /** The invitation once the file has been read: what a request's gate resolves through. */
  async getAfterLoad(id: string): Promise<Invite | null> {
    await this.ready;
    const record = this.invites.get(id);
    return record ? view(record) : null;
  }

  /**
   * A new invitation and the secret that signs it in, shown once. The id is random
   * bytes (a name and a clock reading would be guessable), and only the secret's
   * hash touches the file.
   */
  async create(name: string, grants: Grant[]): Promise<{ invite: Invite; secret: string }> {
    await this.ready;
    const id = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const record: InviteRecord = { id, name, grants: [...new Set(grants)], createdAt: Date.now(), secretHash: hashSecret(secret) };
    this.invites.set(id, record);
    while (this.invites.size > MAX_INVITES) {
      const oldest = [...this.invites.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.invites.delete(oldest.id);
    }
    this.persist();
    return { invite: view(record), secret };
  }

  /** Whether a presented secret is the one this invitation was created with; constant-time on the hashes. */
  async verifySecret(id: string, secret: string): Promise<boolean> {
    await this.ready;
    const record = this.invites.get(id);
    if (!record || secret.length === 0) return false;
    const given = Buffer.from(hashSecret(secret), "hex");
    const expected = Buffer.from(record.secretHash, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Edit one invitation's grants in place; a revoked id resolves to null at once. */
  update(id: string, name: string | null, grants: Grant[] | null): Invite | null {
    const record = this.invites.get(id);
    if (!record) return null;
    if (name !== null && name.trim()) record.name = name.trim().slice(0, 80);
    if (grants !== null) record.grants = [...new Set(grants)];
    this.persist();
    return view(record);
  }

  remove(id: string): boolean {
    const gone = this.invites.delete(id);
    if (gone) this.persist();
    return gone;
  }

  /** One serialized temp+rename; a failed save is logged, never an unhandled rejection. */
  private persist(): void {
    void writeJsonChecked(this.file, Object.fromEntries([...this.invites.values()].map((i) => [i.id, i]))).catch((error: unknown) => {
      this.log(`invites: could not save the invitations: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

/** Where the invites file lives: the state folder, beside the signed-out list. */
export const invitesFileOf = (stateDir: string): string => `${stateDir}/${GRANTS_FILE}`;

/**
 * The request's grants: full (null) for local use and for a password session with
 * no invitation; the invitation's list for a session carrying an invite id. Async:
 * the invite store reads its file once, and a request awaits that read.
 */
export type GrantsOf = (req: Request<any>, res: Response) => Promise<string[] | null>;

export type RequireGrant = (grant: Grant) => <P extends object>(req: RouteParams<P>, res: Response, next: NextFunction) => void;

/**
 * The per-route gate. Full sessions pass; a limited session needs the grant.
 * Every protected route declares its grant explicitly with this — there is no
 * blanket privileged route and no route that skips the check after an omission.
 * The returned middleware is generic in the route's params shape, so a route's own
 * handler still reads `req.params.id` as a string (express 5 loses that inference
 * once a middleware with a widened `Request` annotation precedes it).
 */
export function makeRequireGrant(grantsOf: GrantsOf): RequireGrant {
  return (grant: Grant) => async <P extends object>(req: RouteParams<P>, res: Response, next: NextFunction) => {
    const grants = await grantsOf(req, res);
    if (grants === null || grants.includes(grant)) return next();
    res.status(403).json({ error: `This session's invitation does not include "${grant}"`, code: "missing_grant", grant });
  };
}
