// The desktop shell's half of the contract with the server: which port to look
// at, what `/api/health` means, and the page a window opens. The shell
// (apps/desktop) is a client like the browser — it never holds a second copy of
// the UI — so everything it decides before a window exists lives here, pure and
// unit-tested, and the Electron main process stays glue.
//
// No imports from node or electron: this file rides in the server build, the web
// bundle and the tests alike.

/** awui's default port: the same one the server's `--port` falls back to. */
export const DEFAULT_PORT = 4783;

/** How many ports a shell tries, from its base upward, before it gives up. */
export const PORT_TRIES = 8;

export interface Health {
  ok: boolean;
  /** The build the server serves; a window that loaded another one is stale. */
  build: string;
}

/** `/api/health` on this machine. Loopback by construction: the shell only ever drives a local server. */
export function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/health`;
}

/**
 * Parse `/api/health`'s body. Null when the answer is not awui's — another
 * program on the port, a proxy's error page, anything else — so the shell never
 * attaches to a stranger that happens to answer 200.
 */
export function parseHealth(body: string): Health | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { ok, build } = value as { ok?: unknown; build?: unknown };
  if (ok !== true || typeof build !== "string") return null;
  return { ok: true, build };
}

/** What a probe of one port found. */
export type ProbeState = "awui" | "other" | "free";

export interface Probe {
  port: number;
  state: ProbeState;
}

/** The ports a shell looks at, in order, from its base. */
export function portsFrom(base: number, count: number = PORT_TRIES): number[] {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) ports.push(base + i);
  return ports;
}

export interface Launch {
  action: "attach" | "spawn" | "none";
  port: number;
}

/**
 * Attach to an awui that already listens — even when a free port came first —
 * because a second server over the same state folder would hold the same session
 * files, and awui promises one live writer per session. Otherwise start one on
 * the first port nothing answers on; "none" when every port belongs to something
 * else.
 */
export function planLaunch(probes: Probe[]): Launch {
  const running = probes.find((p) => p.state === "awui");
  if (running) return { action: "attach", port: running.port };
  const free = probes.find((p) => p.state === "free");
  if (free) return { action: "spawn", port: free.port };
  return { action: "none", port: 0 };
}

/** What a menu item, a tray item, or an `awui://` link opens. */
export type Target = { kind: "home" } | { kind: "new" } | { kind: "sessions" } | { kind: "prompt"; text: string };

/**
 * The page a target opens, in the query grammar the web app already reads
 * (src/web/launch.ts): `?new=1`, `?sessions=1`, `?prompt=…`. A prompt link never
 * sends — it fills the composer.
 */
export function targetUrl(base: string, target: Target): string {
  switch (target.kind) {
    case "home":
      return `${base}/`;
    case "new":
      return `${base}/?new=1`;
    case "sessions":
      return `${base}/?sessions=1`;
    case "prompt":
      return `${base}/?prompt=${encodeURIComponent(target.text)}`;
  }
}

/**
 * A `awui://` link as a target: `awui://new`, `awui://sessions`,
 * `awui://prompt?text=…`. Null for anything else, so a malformed link opens the
 * window instead of a blank page.
 */
export function targetFromLink(link: string): Target | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "awui:") return null;
  // awui://prompt?text=… parses the first segment as the host, awui:///prompt as a path.
  const what = (url.hostname || url.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
  if (what === "new") return { kind: "new" };
  if (what === "sessions") return { kind: "sessions" };
  if (what === "prompt") {
    const text = url.searchParams.get("text") ?? url.searchParams.get("prompt") ?? "";
    return text ? { kind: "prompt", text } : null;
  }
  if (what === "") return { kind: "home" };
  return null;
}

/**
 * The count the page puts in its title — "(2) awui", "(99+) awui" — for the tray
 * tooltip and the window flash. 0 when the title carries none.
 */
export function titleCount(title: string): number {
  const match = /^\((\d+)\+?\)\s/.exec(title);
  if (!match?.[1]) return 0;
  return Number(match[1]) || 0;
}
