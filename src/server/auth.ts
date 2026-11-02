// Username/password credentials for HOST=0.0.0.0 mode. Only a salted scrypt
// hash is stored (written by `npm run set-password`, mode 0600); passwords are
// never logged or returned. Includes a small per-address lockout.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform-win.js";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface StoredCredentials {
  v: 1;
  username: string;
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/** Scrypt cost parameters; scripts/set-password.mjs writes them too (tests/unit/credential-parity.test.ts). */
export const DEFAULTS = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
const maxmem = (N: number, r: number) => 128 * N * r * 2;

export async function hashPassword(username: string, password: string, salt: Buffer = randomBytes(16)): Promise<StoredCredentials> {
  const key = await scrypt(password, salt, DEFAULTS.keylen, { N: DEFAULTS.N, r: DEFAULTS.r, p: DEFAULTS.p, maxmem: maxmem(DEFAULTS.N, DEFAULTS.r) });
  return { v: 1, username, salt: salt.toString("base64"), hash: key.toString("base64"), ...DEFAULTS };
}

export class CredentialError extends Error {}

export async function loadCredentials(file: string): Promise<StoredCredentials> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new CredentialError(`No credentials at ${file}. Run \`npm run set-password\` first.`);
  }
  const stat = await fs.stat(file);
  // Windows NTFS has no POSIX mode to tighten; ACLs govern read access there.
  if (!IS_WINDOWS && (stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
  let data: Partial<StoredCredentials>;
  try {
    data = JSON.parse(raw) as Partial<StoredCredentials>;
  } catch {
    throw new CredentialError(`Credentials file ${file} is not valid JSON`);
  }
  const ok =
    data.v === 1 &&
    typeof data.username === "string" &&
    data.username.length > 0 &&
    typeof data.salt === "string" &&
    typeof data.hash === "string" &&
    Number.isInteger(data.N) &&
    Number.isInteger(data.r) &&
    Number.isInteger(data.p) &&
    Number.isInteger(data.keylen);
  if (!ok) throw new CredentialError(`Credentials file ${file} is malformed; run \`npm run set-password\` again`);
  return data as StoredCredentials;
}

export class PasswordAuth {
  /** Changes whenever the password changes; embedded in session cookies to revoke old ones. */
  readonly fingerprint: string;
  private readonly expected: Buffer;
  private readonly salt: Buffer;

  constructor(private readonly creds: StoredCredentials) {
    this.expected = Buffer.from(creds.hash, "base64");
    this.salt = Buffer.from(creds.salt, "base64");
    this.fingerprint = createHash("sha256").update(`${creds.username}\0${creds.hash}`).digest("base64url").slice(0, 16);
  }

  get username(): string {
    return this.creds.username;
  }

  /** Constant-work check: the hash is always computed, even for a wrong username. */
  async verify(username: string, password: string): Promise<boolean> {
    const { N, r, p, keylen } = this.creds;
    const key = await scrypt(password, this.salt, keylen, { N, r, p, maxmem: maxmem(N, r) });
    const passOk = key.length === this.expected.length && timingSafeEqual(key, this.expected);
    const a = createHash("sha256").update(username).digest();
    const b = createHash("sha256").update(this.creds.username).digest();
    return timingSafeEqual(a, b) && passOk;
  }
}

interface Attempts {
  failures: number;
  first: number;
  lockedUntil: number;
}

/** Per-address lockout: MAX failures within WINDOW locks that address for WINDOW. */
export class LoginLimiter {
  private attempts = new Map<string, Attempts>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  /** Seconds until the address may try again, or 0. */
  retryAfter(address: string, now = Date.now()): number {
    const a = this.attempts.get(address);
    if (!a || a.lockedUntil <= now) return 0;
    return Math.ceil((a.lockedUntil - now) / 1000);
  }

  fail(address: string, now = Date.now()): void {
    let a = this.attempts.get(address);
    if (!a || now - a.first > this.windowMs) a = { failures: 0, first: now, lockedUntil: 0 };
    a.failures += 1;
    if (a.failures >= this.max) a.lockedUntil = now + this.windowMs;
    this.attempts.set(address, a);
    if (this.attempts.size > 10_000) {
      for (const [k, v] of this.attempts) if (v.lockedUntil < now && now - v.first > this.windowMs) this.attempts.delete(k);
    }
  }

  succeed(address: string): void {
    this.attempts.delete(address);
  }
}
