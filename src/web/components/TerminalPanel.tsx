// Project terminal: the chat shell keeps only a frame URL and a bounded status.
// Trusted xterm code runs in its own document because it needs DOM-inline styles
// the app's CSP correctly forbids. The child never renders agent HTML.
// One live terminal at a time: the tab strip names what is open here — this
// machine's terminal, and one per peer terminal opened through the "New
// terminal on…" menu (P3: peers whose mesh policy advertises `term.open`,
// listed by GET /api/mesh). Switching re-points the single frame; the peer's
// PTY lives on the peer, and a link that drops shows the failed state with
// Retry, which reopens it through the same create route.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ITheme } from "@xterm/xterm";
import type { WorkspaceInfo } from "../../shared/protocol.js";
import { IconX } from "../icons.js";
import { api } from "../api.js";
import { peerTerminals, type MeshPeerTarget } from "../terminal-peers.js";
import { reduceTerminal, terminalAnnouncement, terminalStatusLabel, type TerminalState } from "../terminal-state.js";

/** One entry of the tab strip: this machine, or a peer terminal opened on it. */
interface TerminalTab {
  /** Stable key: the iframe remounts on it, so switching starts the chosen terminal. */
  key: string;
  /** What the tab reads: the workspace's name, or "@<peer>" like a task's @host badge. */
  label: string;
  /** The configured peer this terminal runs on; absent for this machine's own. */
  peer?: string;
}

const initial = { phase: "starting", terminalId: null, exit: null, error: null } satisfies TerminalState;

export function TerminalPanel({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<TerminalState>(initial);
  const id = useRef<string | null>(state.terminalId);
  id.current = state.terminalId;
  const [tabs, setTabs] = useState<TerminalTab[]>([{ key: "local", label: workspace.name }]);
  const [activeKey, setActiveKey] = useState("local");
  // Bumped by Retry so the frame remounts and the start message is sent again.
  const [attempt, setAttempt] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [peers, setPeers] = useState<MeshPeerTarget[]>([]);
  const menu = useRef<HTMLSpanElement>(null);

  const active = tabs.find((tab) => tab.key === activeKey) ?? (tabs[0] as TerminalTab);
  const setPhase = (phase: TerminalState["phase"]) => setState((current) => phase === "failed" ? reduceTerminal(current, { type: "fail", error: "The terminal could not connect" }) : phase === "closing" ? reduceTerminal(current, { type: "closing" }) : phase === "exited" ? reduceTerminal(current, { type: "exit", code: 0 }) : { ...current, phase });

  // Peers that may host a terminal: read once when the panel opens. The mesh
  // being off answers a payload with no usable peers, and the menu then shows
  // nothing rather than offering machines that would refuse.
  useEffect(() => {
    let gone = false;
    void api("/api/mesh").then((payload) => {
      if (!gone) setPeers(peerTerminals(payload));
    }).catch(() => undefined);
    return () => { gone = true; };
  }, []);

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

  // Click-away for the peer menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const openPeer = (peer: string) => {
    setMenuOpen(false);
    setTabs((current) => {
      const key = `peer:${peer}`;
      if (current.some((tab) => tab.key === key)) {
        setActiveKey(key);
        return current;
      }
      setActiveKey(key);
      return [...current, { key, label: `@${peer}`, peer }];
    });
    setState(initial);
    setAttempt((at) => at + 1);
  };
  const show = (tab: TerminalTab) => {
    if (tab.key === activeKey) return;
    setActiveKey(tab.key);
    setState(initial);
    setAttempt((at) => at + 1);
  };
  const retry = () => {
    setState(initial);
    setAttempt((at) => at + 1);
  };

  return (
    <section className="terminal-window" aria-label={`Terminal for ${workspace.name}`}>
      <header className="terminal-head">
        <span className="terminal-title"><h2>{active?.label ?? workspace.name}</h2><span className="terminal-status">{terminalStatusLabel(state)}</span></span>
        <span className="terminal-tools">
          {peers.length > 0 ? (
            <span className="terminal-new" ref={menu}>
              <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="New terminal on…" onClick={() => setMenuOpen((open) => !open)}>＋</button>
              {menuOpen ? (
                <span className="terminal-new-menu" role="menu" aria-label="New terminal on…">
                  {peers.map((peer) => (
                    <button type="button" role="menuitem" key={peer.name} onClick={() => openPeer(peer.name)}>@{peer.name}</button>
                  ))}
                </span>
              ) : null}
            </span>
          ) : null}
          {state.phase === "failed" ? <button type="button" className="icon-btn" aria-label="Retry terminal" onClick={retry}>↻</button> : null}
          <button type="button" className="icon-btn" aria-label="Close terminal" onClick={close}><IconX size={14} /></button>
        </span>
      </header>
      {tabs.length > 1 ? (
        <nav className="terminal-tabs" aria-label="Open terminals">
          {tabs.map((tab) => (
            <button type="button" key={tab.key} className={`terminal-tab${tab.key === activeKey ? " is-active" : ""}`} aria-current={tab.key === activeKey ? "true" : undefined} onClick={() => show(tab)}>
              {tab.label}
              {tab.peer !== undefined ? <span className="visually-hidden"> (on peer {tab.peer})</span> : null}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="terminal-body">
        <iframe
          ref={frame}
          key={`${activeKey}:${attempt}`}
          className="terminal-shell"
          title="Terminal"
          src="/terminal-shell.html"
          sandbox="allow-scripts allow-same-origin"
          onLoad={(event) => {
            const target = event.currentTarget;
            // A peer terminal is created through the same route with `peer` in
            // the body; the shell relays it, and the target's own policy decides.
            target.contentWindow?.postMessage({ method: "start", workspace: { id: workspace.id, name: workspace.name, path: workspace.path }, ...(active?.peer ? { peer: active.peer } : {}), theme: theme() }, window.location.origin);
          }}
        />
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{terminalAnnouncement(state)}</p>
    </section>
  );
}
