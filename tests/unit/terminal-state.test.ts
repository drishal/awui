import { describe, expect, it } from "vitest";
import { initialTerminalState, reduceTerminal, terminalAnnouncement, terminalStatusLabel, type TerminalState } from "../../src/web/terminal-state.js";

const fold = (state: TerminalState, ...events: Parameters<typeof reduceTerminal>[1][]): TerminalState => events.reduce(reduceTerminal, state);

describe("initial state", () => {
  it("starts in the starting phase with no terminal and no exit", () => {
    const state = initialTerminalState();
    expect(state).toEqual({ phase: "starting", terminalId: null, exit: null, error: null });
  });
});

describe("created", () => {
  it("records the server terminal's id and keeps the starting phase", () => {
    const state = fold(initialTerminalState(), { type: "created", id: "t1" });
    expect(state.terminalId).toBe("t1");
    expect(state.phase).toBe("starting");
    expect(state.exit).toBeNull();
    expect(state.error).toBeNull();
  });
});

describe("output", () => {
  it("flips starting to live on the first output", () => {
    const state = fold(initialTerminalState(), { type: "created", id: "t1" }, { type: "output" });
    expect(state.phase).toBe("live");
  });

  it("stays live on later output", () => {
    const state = fold(initialTerminalState(), { type: "created", id: "t1" }, { type: "output" }, { type: "output" });
    expect(state.phase).toBe("live");
  });

  it("does not resurrect a failed session", () => {
    const state = fold(initialTerminalState(), { type: "fail", error: "gone" }, { type: "output" });
    expect(state.phase).toBe("failed");
  });

  it("does not resurrect a closing session", () => {
    const state = fold(initialTerminalState(), { type: "created", id: "t1" }, { type: "closing" }, { type: "output" });
    expect(state.phase).toBe("closing");
  });
});

describe("exit", () => {
  it("marks the session exited with its code", () => {
    const state = fold(initialTerminalState(), { type: "created", id: "t1" }, { type: "exit", code: 0 });
    expect(state.phase).toBe("exited");
    expect(state.exit).toEqual({ code: 0 });
  });

  it("keeps the signal when the shell was killed", () => {
    const state = fold(initialTerminalState(), { type: "exit", code: 1, signal: 9 });
    expect(state.exit).toEqual({ code: 1, signal: 9 });
    expect(terminalStatusLabel(state)).toBe("exited");
  });

  it("leaves a closing session closing", () => {
    const state = fold(initialTerminalState(), { type: "created", id: "t1" }, { type: "closing" }, { type: "exit", code: 0 });
    expect(state.phase).toBe("closing");
    expect(state.exit).toEqual({ code: 0 });
  });
});

describe("fail", () => {
  it("records the error and stops the session", () => {
    const state = fold(initialTerminalState(), { type: "fail", error: "Cannot reach the server" });
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("Cannot reach the server");
    expect(terminalStatusLabel(state)).toBe("failed");
  });
});

describe("closing", () => {
  it("marks the session closing while the delete runs", () => {
    const state = fold(initialTerminalState(), { type: "created", id: "t1" }, { type: "closing" });
    expect(state.phase).toBe("closing");
    expect(state.terminalId).toBe("t1");
  });
});

describe("labels and announcements", () => {
  it("labels every phase", () => {
    expect(terminalStatusLabel(initialTerminalState())).toBe("starting");
    expect(terminalStatusLabel(fold(initialTerminalState(), { type: "created", id: "t1" }, { type: "output" }))).toBe("live");
    expect(terminalStatusLabel(fold(initialTerminalState(), { type: "exit", code: 0 }))).toBe("exited");
    expect(terminalStatusLabel(fold(initialTerminalState(), { type: "closing" }))).toBe("closing");
  });

  it("announces the start and readiness", () => {
    expect(terminalAnnouncement(initialTerminalState())).toBe("Terminal starting");
    expect(terminalAnnouncement(fold(initialTerminalState(), { type: "output" }))).toBe("Terminal ready");
  });

  it("announces an exit with its code, and a signal when there is one", () => {
    expect(terminalAnnouncement(fold(initialTerminalState(), { type: "exit", code: 0 }))).toBe("Terminal exited with code 0");
    expect(terminalAnnouncement(fold(initialTerminalState(), { type: "exit", code: 1, signal: 15 }))).toBe(
      "Terminal exited with code 1 (signal 15)",
    );
    expect(terminalAnnouncement(fold(initialTerminalState(), { type: "exit", code: 1 }))).toBe("Terminal exited with code 1");
  });

  it("announces closing and a failure", () => {
    expect(terminalAnnouncement(fold(initialTerminalState(), { type: "closing" }))).toBe("Terminal closing");
    expect(terminalAnnouncement(fold(initialTerminalState(), { type: "fail", error: "no shell" }))).toBe("Terminal failed: no shell");
    expect(terminalAnnouncement(fold(initialTerminalState(), { type: "fail", error: "" }))).toBe("Terminal failed: unknown error");
  });
});
