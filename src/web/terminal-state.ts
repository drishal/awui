// The terminal panel's pure state: which phase the session is in, its id, and
// how it ended. xterm owns the output itself; this only tracks what the header,
// the announcements, and the close flow need.

export type TerminalPhase = "starting" | "live" | "exited" | "closing" | "failed";

export interface TerminalState {
  phase: TerminalPhase;
  /** The server terminal's id, null until the create route answered. */
  terminalId: string | null;
  exit: { code: number; signal?: number } | null;
  error: string | null;
}

export type TerminalEvent =
  | { type: "created"; id: string }
  | { type: "output" }
  | { type: "exit"; code: number; signal?: number }
  | { type: "fail"; error: string }
  | { type: "closing" };

export const initialTerminalState = (): TerminalState => ({ phase: "starting", terminalId: null, exit: null, error: null });

export function reduceTerminal(state: TerminalState, event: TerminalEvent): TerminalState {
  switch (event.type) {
    case "created":
      return { ...state, terminalId: event.id };
    case "output":
      return state.phase === "starting" ? { ...state, phase: "live" } : state;
    case "exit": {
      const exit = { code: event.code, ...(event.signal !== undefined ? { signal: event.signal } : {}) };
      // Closing is sticky: the panel is on its way out, an exit mid-delete
      // must not flip it back to a live-looking "exited" state.
      return { ...state, exit, phase: state.phase === "closing" ? "closing" : "exited" };
    }
    case "fail":
      return { ...state, phase: "failed", error: event.error };
    case "closing":
      return { ...state, phase: "closing" };
  }
}

const LABELS: Record<TerminalPhase, string> = { starting: "starting", live: "live", exited: "exited", closing: "closing", failed: "failed" };

/** The header's one-word status. */
export function terminalStatusLabel(state: TerminalState): string {
  return LABELS[state.phase];
}

/** What a screen reader announces when the phase changes. */
export function terminalAnnouncement(state: TerminalState): string {
  switch (state.phase) {
    case "starting":
      return "Terminal starting";
    case "live":
      return "Terminal ready";
    case "exited":
      if (state.exit === null) return "Terminal exited";
      return state.exit.signal === undefined
        ? `Terminal exited with code ${state.exit.code}`
        : `Terminal exited with code ${state.exit.code} (signal ${state.exit.signal})`;
    case "closing":
      return "Terminal closing";
    case "failed":
      return `Terminal failed: ${state.error || "unknown error"}`;
  }
}
