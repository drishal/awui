// Trusted awui terminal renderer in its own page, iframe-isolated from the chat app.
// xterm necessarily assigns DOM styles for grids and fonts; its use is confined to
// this trusted UI, never an agent-rendered page. Main App keeps strict CSP.
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ITheme } from "@xterm/xterm";
import "./styles/terminal-shell.css";

interface TerminalStart {
  method: "start";
  workspace: { id: string; path: string; name: string };
  theme: Pick<ITheme, "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground">;
}
interface TerminalMessage {
  method: string;
  workspace?: TerminalStart["workspace"];
  theme?: TerminalStart["theme"];
  message?: unknown;
}
interface Created {
  id: string;
  createdAt: number;
}

const root = document.getElementById("terminal");
if (!root) throw new Error("missing terminal root");
let current: EventSource | null = null;
let identifier: string | null = null;
let workspaceId: string | null = null;
let disposed = false;

const term = new Terminal({ cursorBlink: true, allowProposedApi: true, scrollback: 5000, screenReaderMode: false });
term.open(root);
const fit = new FitAddon();
term.loadAddon(fit);
term.attachCustomKeyEventHandler((event) => {
  if (event.type === "keydown" && event.key === "Tab") event.stopPropagation();
  return true;
});
// One write at a time: concurrent POSTs travel separate connections and can
// reach the PTY out of order, turning fast typing or a paste into garbage.
let writes: Promise<unknown> = Promise.resolve();
term.onData((data) => {
  if (identifier === null || workspaceId === null) return;
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${identifier}/write`;
  writes = writes.then(() => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) })).catch(() => undefined);
});

// The frame resizes with the split and the window; refit and report a changed grid.
let sized = { cols: term.cols, rows: term.rows };
let refit = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(refit);
  refit = requestAnimationFrame(() => {
    fit.fit();
    if (!identifier || (term.cols === sized.cols && term.rows === sized.rows)) return;
    sized = { cols: term.cols, rows: term.rows };
    parent.postMessage({ method: "resize", cols: term.cols, rows: term.rows }, window.location.origin);
  });
}).observe(root);

window.addEventListener("message", async (event) => {
  if (event.origin !== window.location.origin) return;
  const value = event.data as TerminalMessage;
  if (typeof value.method !== "string") return;
  if (value.method === "start" && value.workspace && value.theme) {
    current?.close();
    disposed = false;
    identifier = null;
    term.reset();
    term.options.theme = value.theme;
    workspaceId = value.workspace.id;
    parent.postMessage({ method: "connecting" }, window.location.origin);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: term.cols, rows: term.rows }) });
      if (!response.ok) throw new Error((await response.json()) as string);
      const created = (await response.json()) as Created;
      identifier = created.id;
      if (disposed) {
        await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${created.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
        return;
      }
      parent.postMessage({ method: "created", id: created.id }, window.location.origin);
      current = new EventSource(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${created.id}/events`);
      current.addEventListener("terminal", (e) => {
        const frame = JSON.parse((e as MessageEvent<string>).data) as { text?: unknown };
        if (typeof frame.text === "string") {
          term.write(frame.text);
          parent.postMessage({ method: "live" }, window.location.origin);
        }
      });
      current.addEventListener("exit", (e) => {
        const frame = JSON.parse((e as MessageEvent<string>).data) as { code?: number; signal?: number };
        parent.postMessage({ method: "exited", code: frame.code, signal: frame.signal }, window.location.origin);
      });
      current.onerror = () => {
        if (current?.readyState === EventSource.CLOSED) parent.postMessage({ method: "error", error: "Connection lost" }, window.location.origin);
      };
      fit.fit();
      sized = { cols: term.cols, rows: term.rows };
      parent.postMessage({ method: "resize", cols: term.cols, rows: term.rows }, window.location.origin);
    } catch {
      parent.postMessage({ method: "failed", error: "The terminal could not start here" }, window.location.origin);
    }
    return;
  }
  if (value.method === "theme" && value.theme) {
    term.options.theme = value.theme;
    fit.fit();
    parent.postMessage({ method: "resize", cols: term.cols, rows: term.rows }, window.location.origin);
    return;
  }
  if (value.method === "resize") {
    fit.fit();
    if (identifier) parent.postMessage({ method: "resize", cols: term.cols, rows: term.rows }, window.location.origin);
    return;
  }
  if (value.method === "stop") {
    disposed = true;
    current?.close();
    const id = identifier;
    identifier = null;
    if (id && workspaceId) await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
    parent.postMessage({ method: "stopped" }, window.location.origin);
  }
});
