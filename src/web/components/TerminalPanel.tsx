// Project terminal: the chat shell keeps only a frame URL and a bounded status.
// Trusted xterm code runs in its own document because it needs DOM-inline styles
// the app's CSP correctly forbids. The child never renders agent HTML.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ITheme } from "@xterm/xterm";
import type { WorkspaceInfo } from "../../shared/protocol.js";
import { IconX } from "../icons.js";
import { api } from "../api.js";
import { reduceTerminal, terminalAnnouncement, terminalStatusLabel, type TerminalState } from "../terminal-state.js";

const initial = { phase: "starting", terminalId: null, exit: null, error: null } satisfies TerminalState;

export function TerminalPanel({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<TerminalState>(initial);
  const id = useRef<string | null>(state.terminalId);
  id.current = state.terminalId;
  const setPhase = (phase: TerminalState["phase"]) => setState((current) => phase === "failed" ? reduceTerminal(current, { type: "fail", error: "The terminal could not connect" }) : phase === "closing" ? reduceTerminal(current, { type: "closing" }) : phase === "exited" ? reduceTerminal(current, { type: "exit", code: 0 }) : { ...current, phase });

  const theme = () => {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string) => styles.getPropertyValue(name).trim();
    return { background: read("--surface-2"), foreground: read("--text"), cursor: read("--accent"), cursorAccent: read("--surface-2"), selectionBackground: read("--selection") } satisfies ITheme;
  };
  const resize = useCallback((cols: number, rows: number) => {
    if (id.current === null) return;
    void api(`/api/workspaces/${workspace.id}/terminal/${id.current}/resize`, { method: "POST", body: { cols, rows } }).catch(() => undefined);
  }, [workspace.id]);
  const close = useCallback(() => {
    setState((current) => reduceTerminal(current, { type: "closing" }));
    frame.current?.contentWindow?.postMessage({ method: "stop" }, window.location.origin);
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow || typeof event.data !== "object" || event.data === null) return;
      const method = "method" in event.data ? event.data.method : undefined;
      if (typeof method !== "string") return;
      if (method === "created" && "id" in event.data && typeof event.data.id === "string") {
        setState((current) => reduceTerminal(current, { type: "created", id: event.data.id as string }));
        return;
      }
      if (method === "resize" && "cols" in event.data && "rows" in event.data) {
        resize(event.data.cols as number, event.data.rows as number);
        return;
      }
      // Public method names are deliberately narrow; never forward HTML or commands.
      if (method === "live") setState((current) => current.phase === "starting" ? reduceTerminal(current, { type: "output" }) : current);
      if (method === "failed" || method === "error") setPhase("failed");
      if (method === "exited") setPhase("exited");
      if (method === "connecting") setPhase("starting");
      if (method === "stopped") onClose();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [workspace.id, resize, onClose]);

  return (
    <section className="terminal-window" aria-label={`Terminal for ${workspace.name}`}>
      <header className="terminal-head">
        <span className="terminal-title"><h2>{workspace.name}</h2><span className="terminal-status">{terminalStatusLabel(state)}</span></span>
        <button type="button" className="icon-btn" aria-label="Close terminal" onClick={close}><IconX size={14} /></button>
      </header>
      <div className="terminal-body">
        <iframe
          ref={frame}
          className="terminal-shell"
          title="Terminal"
          src="/terminal-shell.html"
          sandbox="allow-scripts allow-same-origin"
          onLoad={(event) => {
            const target = event.currentTarget;
            target.contentWindow?.postMessage({ method: "start", workspace: { id: workspace.id, name: workspace.name, path: workspace.path }, theme: theme() }, window.location.origin);
          }}
        />
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{terminalAnnouncement(state)}</p>
    </section>
  );
}
