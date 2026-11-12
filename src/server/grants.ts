// Additive grants for limited remote sessions (E3). A password sign-in is full
// access — that is the backwards-compatible default — unless the session was
// issued for a specific invitation, in which case the cookie carries only the
// invitation's id and the server resolves that id's allow list on every request
// (so a revocation, or an edit to an invitation's grants, applies at once; no
// entitlement travels in the cookie or a header).
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

import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { isObj, readJson, writeJson } from "./state-file.js";

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

export class InviteStore {
  private invites = new Map<string, Invite>();
  private readonly ready: Promise<void>;

  constructor(private readonly file: string | null) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const data = await readJson(this.file);
    if (!isObj(data)) return;
    for (const [id, raw] of Object.entries(data)) {
      if (this.invites.size >= MAX_INVITES) break;
      if (!isObj(raw) || typeof raw.name !== "string" || raw.name.length === 0) continue;
      const grants = Array.isArray(raw.grants) ? [...new Set(raw.grants.filter(isGrant))] : [];
      // An invitation whose every grant was edited away would lock its holder out of
      // everything but sign-in; it is kept (the holder can still read their own grants),
      // but an empty list is only ever made on purpose, never by a malformed file.
      if (grants.length === 0) continue;
      this.invites.set(id, { id, name: raw.name, grants, createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now() });
    }
  }

  /** Resolves once the file has been read: call before the first check. */
  get loaded(): Promise<void> {
    return this.ready;
  }

  list(): Invite[] {
    return [...this.invites.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Invite | null {
    return this.invites.get(id) ?? null;
  }

  /** The invitation once the file has been read: what a request's gate resolves through. */
  async getAfterLoad(id: string): Promise<Invite | null> {
    await this.ready;
    return this.invites.get(id) ?? null;
  }

  create(name: string, grants: Grant[]): Invite {
    const id = createHash("sha256")
      .update(`${Date.now()}\0${name}\0${grants.join(",")}\0${Math.random()}`)
      .digest("base64url")
      .slice(0, 22);
    const invite: Invite = { id, name, grants: [...new Set(grants)], createdAt: Date.now() };
    this.invites.set(id, invite);
    while (this.invites.size > MAX_INVITES) {
      const oldest = [...this.invites.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.invites.delete(oldest.id);
    }
    void writeJson(this.file, Object.fromEntries([...this.invites.values()].map((i) => [i.id, i])));
    return invite;
  }

  /** Edit one invitation's grants in place; a revoked id resolves to null at once. */
  update(id: string, name: string | null, grants: Grant[] | null): Invite | null {
    const invite = this.invites.get(id);
    if (!invite) return null;
    if (name !== null && name.trim()) invite.name = name.trim().slice(0, 80);
    if (grants !== null) invite.grants = [...new Set(grants)];
    void writeJson(this.file, Object.fromEntries([...this.invites.values()].map((i) => [i.id, i])));
    return invite;
  }

  remove(id: string): boolean {
    const gone = this.invites.delete(id);
    if (gone) void writeJson(this.file, Object.fromEntries([...this.invites.values()].map((i) => [i.id, i])));
    return gone;
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
