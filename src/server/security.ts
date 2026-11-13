// Request trust and authentication.
//  1. Host must be loopback, listed in ALLOWED_HOSTS (Tailscale Serve), or,
//     with HOST=0.0.0.0, one of this machine's LAN addresses/hostname. Origin
//     must match Host; cross-site fetches are refused. Failures are 403
//     (DNS rebinding, CSRF).
//  2. Local use needs no sign-in: a request is local only when the TCP peer is
//     loopback, the Host is loopback, and no proxy headers are present (so a
//     LAN client faking `Host: 127.0.0.1`, or Tailscale Serve proxying over
//     loopback, is never local).
//  3. Everything else (LAN via HOST=0.0.0.0, Tailscale Serve) signs in with
//     username and password (POST /api/login) and gets a signed, host-bound,
//     HttpOnly, SameSite=Strict session cookie carrying the credential
//     fingerprint, so changing the password signs every device out.
//  4. If ALLOWED_TAILSCALE_USERS is set, Serve requests must also carry an
//     allowed Tailscale-User-Login.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { IS_WINDOWS } from "./platform-win.js";
import type { NextFunction, Request, Response } from "express";
import { LoginLimiter, type PasswordAuth } from "./auth.js";
import { parseAuthority } from "./config.js";
import { isObj, readJson, writeJson } from "./state-file.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PROXY_HEADERS = ["tailscale-user-login", "tailscale-user-name", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FAIL_DELAY_MS = 400;
/** Signed-out sessions remembered at once; each is a few dozen bytes. */
const MAX_REVOKED = 10_000;

export interface SecurityOptions {
  port: number;
  allowedHosts: string[];
  allowedTailscaleUsers: string[];
  secret: Buffer;
  /** Required for any non-local access; absent means local-only. */
  password?: PasswordAuth;
  /** HOST=0.0.0.0: hostnames of this machine reachable on the LAN. */
  lanHosts?: () => Set<string>;
  /** Where signed-out sessions are remembered until their cookies expire; absent keeps them in memory only. */
  revokedFile?: string;
  log?: (message: string) => void;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function send(res: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).type("application/json").send(JSON.stringify({ error, code, ...extra }));
}

export class Security {
  readonly cookieName: string;
  private readonly limiter = new LoginLimiter();
  /** Signed-out sessions by id, with when their cookie would have expired; a copied cookie is void once its device signs out. */
  private revoked = new Map<string, number>();
  /** The revoked list as read from the state folder, once, before the first check. */
  readonly ready: Promise<void>;

  constructor(private readonly options: SecurityOptions) {
    this.cookieName = `awui_${options.port}`;
    this.ready = this.loadRevoked();
  }

  private async loadRevoked(): Promise<void> {
    const data = await readJson(this.options.revokedFile ?? null);
    if (!isObj(data)) return;
    const now = Date.now();
    for (const [id, exp] of Object.entries(data)) {
      if (typeof exp === "number" && exp > now && this.revoked.size < MAX_REVOKED) this.revoked.set(id, exp);
    }
  }

  /** Remember one session as signed out, until its cookie would expire anyway. */
  private revoke(id: string, exp: number, now = Date.now()): void {
    for (const [k, e] of this.revoked) if (e <= now) this.revoked.delete(k);
    // Past the cap the oldest go first: a cookie that old is near its own expiry.
    while (this.revoked.size >= MAX_REVOKED) {
      const oldest = this.revoked.keys().next().value;
      if (oldest === undefined) break;
      this.revoked.delete(oldest);
    }
    this.revoked.set(id, exp);
    void writeJson(this.options.revokedFile ?? null, Object.fromEntries(this.revoked));
  }

  get username(): string | null {
    return this.options.password?.username ?? null;
  }

  /** Classify a Host header: loopback, a LAN address (HOST=0.0.0.0), an allowed Serve host, or untrusted. */
  classify(hostHeader: string | undefined): { kind: "loopback" | "lan" | "remote"; authority: string } | null {
    const auth = parseAuthority(hostHeader);
    if (!auth) return null;
    if (LOOPBACK_HOSTS.has(auth.hostname)) return { kind: "loopback", authority: auth.authority };
    for (const entry of this.options.allowedHosts) {
      const matches = entry.includes(":") ? entry === auth.authority : entry === auth.hostname;
      if (matches) return { kind: "remote", authority: auth.authority };
    }
    if (this.options.lanHosts?.().has(auth.hostname)) return { kind: "lan", authority: auth.authority };
    return null;
  }

  /** Same machine, direct connection, no proxy in between. */
  isLocal(req: Request, hostKind: "loopback" | "lan" | "remote"): boolean {
    if (hostKind !== "loopback" || !isLoopbackAddress(req.socket.remoteAddress)) return false;
    return !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  }

  /** Host / Origin / Sec-Fetch-Site / Tailscale identity. Applies to every request. */
  trust = (req: Request, res: Response, next: NextFunction): void => {
    const host = this.classify(req.headers.host);
    if (!host) return send(res, 403, "host_not_allowed", "Host not allowed");
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null") {
      let originAuthority: string | null = null;
      try {
        const url = new URL(origin);
        originAuthority = url.port ? `${url.hostname}:${url.port}` : url.hostname;
      } catch {
        originAuthority = null;
      }
      if (originAuthority?.toLowerCase() !== host.authority) {
        return send(res, 403, "origin_not_allowed", "Cross-origin request refused");
      }
    } else if (origin === "null") {
      return send(res, 403, "origin_not_allowed", "Opaque origin refused");
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return send(res, 403, "cross_site", "Cross-site request refused");
    }
    const local = this.isLocal(req, host.kind);
    if (!local && !this.options.password) {
      return send(res, 403, "remote_disabled", "Access from other devices needs a password: run `npm run set-password`");
    }
    if (host.kind === "remote" && this.options.allowedTailscaleUsers.length > 0) {
      const login = String(req.headers["tailscale-user-login"] ?? "").toLowerCase();
      if (!login || !this.options.allowedTailscaleUsers.includes(login)) {
        return send(res, 403, "tailscale_user_denied", "This Tailscale user is not allowed");
      }
    }
    res.locals.hostKind = host.kind;
    res.locals.authority = host.authority;
    res.locals.local = local;
    next();
  };

  private sign(payload: string): string {
    return createHmac("sha256", this.options.secret).update(payload).digest("base64url");
  }

  /**
   * A session's cookie. `invite` names one invitation (grants.ts) the session is
   * bound to: the cookie carries only that id — never the grants themselves — so
   * the server resolves the list on every request and a revocation or edit applies
   * at once. No invite: full access (the backwards-compatible default).
   */
  issueCookie(authority: string, secure: boolean, invite?: string, now = Date.now()): string {
    const body = { v: 2, h: authority, iat: now, exp: now + COOKIE_MAX_AGE_MS, f: this.options.password?.fingerprint ?? "", n: randomBytes(12).toString("base64url"), ...(invite ? { g: invite } : {}) };
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    const value = `${payload}.${this.sign(payload)}`;
    const attrs = [`${this.cookieName}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${COOKIE_MAX_AGE_MS / 1000}`];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
  }

  private readCookie(req: Request): string | null {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === this.cookieName) return part.slice(eq + 1).trim();
    }
    return null;
  }

  /** The request's cookie, when it is a valid session for this authority: its id (absent on cookies from before ids) and expiry. */
  private session(req: Request, authority: string, now = Date.now()): { n?: string; g?: string; exp: number } | null {
    const password = this.options.password;
    if (!password) return null;
    const value = this.readCookie(req);
    if (!value) return null;
    const dot = value.indexOf(".");
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { h?: string; exp?: number; f?: string; n?: unknown; g?: unknown };
      // A cookie from before the password changed is void, and so is one whose device signed out.
      if (data.h !== authority || typeof data.exp !== "number" || data.exp <= now || data.f !== password.fingerprint) return null;
      const n = typeof data.n === "string" ? data.n : undefined;
      if (n !== undefined && this.revoked.has(n)) return null;
      const g = typeof data.g === "string" && data.g.length <= 64 ? data.g : undefined;
      return { exp: data.exp, ...(n !== undefined ? { n } : {}), ...(g !== undefined ? { g } : {}) };
    } catch {
      return null;
    }
  }

  hasSession(req: Request, authority: string, now = Date.now()): boolean {
    return this.session(req, authority, now) !== null;
  }

  /**
   * The request's session id, so state a session keeps (an idempotency key's owner) is not
   * shared with another device. Null for a local request or a cookie minted before ids.
   */
  sessionId(req: Request, authority: string): string | null {
    return this.session(req, authority)?.n ?? null;
  }

  /**
   * The invitation the session was issued for (grants.ts), so the request's grants are
   * that invitation's allow list. Null for a local request or a full password session.
   */
  inviteId(req: Request, authority: string): string | null {
    return this.session(req, authority)?.g ?? null;
  }

  /**
   * A guest link's browser key, from the same signed cookie shape but valid even on a
   * local server without password sign-in. Guest routes are the only callers: this never
   * becomes a full session, and `GuestStore` still checks expiry and revocation itself.
   */
  guestBrowserKey(req: Request, authority: string): string | null {
    const password = this.options.password;
    const value = this.readCookie(req);
    if (!value) return null;
    const dot = value.indexOf(".");
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { h?: string; exp?: number; f?: string; g?: unknown };
      if (data.h !== authority || typeof data.exp !== "number" || data.exp <= Date.now()) return null;
      if (password && data.f !== password.fingerprint) return null;
      const g = typeof data.g === "string" && data.g.length <= 64 ? data.g : undefined;
      return g ?? null;
    } catch {
      return null;
    }
  }

  /** POST /api/login { username, password }. */
  login = async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const auth = this.options.password;
    if (!auth) return send(res, 404, "not_found", "Password sign-in is not configured");
    const address = req.socket.remoteAddress ?? "unknown";
    // Tailscale Serve proxies every device over loopback, so its peer address is
    // always 127.0.0.1: count those failures by the tailnet login instead, or one
    // device guessing could lock every other one out.
    const login = res.locals.hostKind === "remote" ? String(req.headers["tailscale-user-login"] ?? "").toLowerCase() : "";
    const who = login ? `tailscale:${login}` : address;
    const wait = this.limiter.retryAfter(who);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return send(res, 429, "locked", `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} min.`, { retryAfter: wait });
    }
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.slice(0, 128) : "";
    const password = typeof body.password === "string" ? body.password.slice(0, 1024) : "";
    const ok = await auth.verify(username, password);
    if (!ok) {
      this.limiter.fail(who);
      this.options.log?.(`sign-in failed from ${login ? `${login} via Tailscale` : address}`);
      await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
      return send(res, 401, "bad_credentials", "Wrong username or password");
    }
    this.limiter.succeed(who);
    const invite = typeof res.locals.loginInvite === "string" ? res.locals.loginInvite : undefined;
    res.setHeader("Set-Cookie", this.issueCookie(res.locals.authority as string, res.locals.hostKind === "remote", invite));
    res.json({ ok: true, username: auth.username });
  };

  logout = (req: Request, res: Response): void => {
    const session = typeof res.locals.authority === "string" ? this.session(req, res.locals.authority) : null;
    if (session?.n !== undefined) this.revoke(session.n, session.exp);
    res.setHeader("Set-Cookie", `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  };

  /** Local requests pass; everything else needs a password session. */
  requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (res.locals.local === true) return next();
    if (!this.hasSession(req, res.locals.authority as string)) {
      return send(res, 401, "unauthenticated", "Sign in with your username and password", { auth: "password" });
    }
    next();
  };
}

/** Load the cookie-signing secret, creating it with mode 0600 on first use. */
export async function loadOrCreateSecret(stateDir: string): Promise<Buffer> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, "cookie-secret");
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      const stat = await fs.stat(file);
      // Windows NTFS has no POSIX mode to tighten; ACLs govern read access there.
      if (!IS_WINDOWS && (stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
      return Buffer.from(existing, "hex");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, secret.toString("hex"), { mode: 0o600 });
  await fs.rename(tmp, file);
  return secret;
}
