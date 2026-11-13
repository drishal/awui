// atui's screen: a side panel on the left (Sessions and Info tabs, folding to
// a rail), the conversation and composer beside it, and no status bar: the
// composer's footer carries vim's mode, a waiting C-x, a lost connection, and
// a passing hint; dialogs over it all. Keys are written the Emacs way (C- is Ctrl, M- is Alt). Global
// keys: C-k commands, C-r history, M-h/M-m/M-t the harness, model, and
// thinking pickers (the composer's footer opens them on a click too), C-x
// then a letter for the rest (a which-key panel lists them until a key, Esc,
// or C-g), PageUp/PageDown scroll, Esc Esc stops the agent, C-c clears,
// stops, or (twice) quits. In vim mode (--vim, or C-x v) Esc leaves the
// composer for NORMAL, where src/atui/vim.ts's keys move around; i goes back
// to typing. Jumps of more than a line glide; C-x g is glass mode (no fills, the
// terminal's background shows through); background sessions' news toasts in
// the corner, and the terminal's title and tab progress follow the chat.
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { RunResult } from "../../shared/protocol.js";
import { runnable } from "../../web/code-blocks.js";
import { codeBlocks, quoteText, runForMessage, runStatus } from "../assist.js";
import { RunOutput } from "./runout.js";
import type { UserItem } from "../../shared/protocol.js";
import type { PaletteItem } from "../../web/palette.js";
import { isBusy } from "../../web/session-groups.js";
import { atuiColumn, chatWidthLabel, CHAT_WIDTHS, nextChatWidth } from "../../shared/chat-width.js";
import { ago, STATUS_LABEL } from "../format.js";
import { leader, LEADER_KEYS, VIM_HELP } from "../keys.js";
import { harnessGlyph } from "../neat.js";
import type { Atui } from "../state.js";
import { terminalState, type TerminalState } from "../terminal.js";
import { accentOf } from "../theme.js";
import { Composer } from "./composer.js";
import { AtuiContext } from "./context.js";
import { glideBy, glideTo, Shimmer } from "./fx.js";
import { SwitchGhost } from "./ghost.js";
import { Picker, type PreviewText } from "./picker.js";
import { RequestCard } from "./request.js";
import { RAIL_WIDTH, Sidebar, SidebarRail, type SidebarTab } from "./sidebar.js";
import { Splash } from "./splash.js";
import { TabBar } from "./tabbar.js";
import { UndoDialog } from "./undo.js";
import { BoardView } from "./board.js";
import { DelegatedView } from "./delegated.js";
import { ContextRailView } from "./rail.js";
import { ReviewView } from "./review.js";
import { GitView } from "./git.js";
import { GitHubView } from "./github.js";
import { collectChanges } from "../../web/review.js";
import { Toasts } from "./toasts.js";
import { Transcript } from "./transcript.js";
import { WhichKey } from "./whichkey.js";
import { turnOffset, vimKey } from "../vim.js";
import { buildTurns, turnOfTool } from "../../web/turns.js";

type Dialog = "palette" | "models" | "harness" | "thinking" | "history" | "run" | null;

const TWICE_MS = 1200;
/** A session that opens within this shows at once; one that takes longer gets the ghost thread meanwhile. */
const GHOST_AFTER_MS = 50;

export function App(p: {
  app: Atui;
  onExit: () => void;
  vim?: boolean;
  onVim?: (on: boolean) => void;
  onGlass?: (on: boolean) => void;
  /** The terminal's title and progress indicator changed (none in tests). */
  onTerminal?: (state: TerminalState) => void;
}) {
  const app = p.app;
  const t = app.theme;
  const size = useTerminalDimensions();
  const [sidebar, setSidebar] = createSignal(size().width >= 110);
  const [sideTab, setSideTab] = createSignal<SidebarTab>("sessions");
  const [focus, setFocus] = createSignal<"composer" | "sidebar">("composer");
  const [dialog, setDialog] = createSignal<Dialog>(null);
  // The work shows, as neat-render draws it (nothing folds); C-x e folds every turn to its line.
  const [showWork, setShowWork] = createSignal(true);
  const [compactChoice, setCompactChoice] = createSignal<boolean | null>(null);
  const [reviewing, setReviewing] = createSignal(false);
  /** The delegated work panel, opened on one worker when a rail row named it. */
  const [delegated, setDelegated] = createSignal<{ taskId?: string } | null>(null);
  const [rail, setRail] = createSignal(false);
  const [board, setBoard] = createSignal(false);
  /** The git panel: the project's status, staging, and commits (C-x u). */
  const [gitting, setGitting] = createSignal(false);
  /** The GitHub panel: the project's PR, its checks, and its stack (C-x p). */
  const [hubbing, setHubbing] = createSignal(false);
  /** A command run from an answer (C-x x), and what it gave once done. */
  const [running, setRunning] = createSignal<{ command: string; result: RunResult | null } | null>(null);
  const renderer = useRenderer();
  const [hint, setHint] = createSignal<string | null>(null);
  /** C-x was pressed: the which-key panel is open and the next key is a command. */
  const [leaderOn, setLeaderOn] = createSignal(false);
  const [vim, setVim] = createSignal(p.vim ?? false);
  const [mode, setMode] = createSignal<"insert" | "normal">("insert");
  const normal = () => vim() && mode() === "normal";
  /** Keys typed toward a NORMAL command so far: a count, a `g` or `z`. */
  let vimPending = "";
  let lastCtrlC = 0;
  let lastEsc = 0;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let composer: TextareaRenderable | undefined;
  let scroller: ScrollBoxRenderable | undefined;

  const flash = (text: string, ms = 2500) => {
    clearTimeout(hintTimer);
    setHint(text);
    hintTimer = setTimeout(() => setHint(null), ms);
  };
  onCleanup(() => clearTimeout(hintTimer));

  // The session being opened, once it has taken long enough to be worth a screen of its own.
  const [ghost, setGhost] = createSignal<{ title: string; harnessId: string } | null>(null);
  let ghostTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(app.opening, (target) => {
      clearTimeout(ghostTimer);
      if (!target) return setGhost(null);
      ghostTimer = setTimeout(() => setGhost(target), GHOST_AFTER_MS);
    }),
  );
  onCleanup(() => clearTimeout(ghostTimer));

  const pending = createMemo(() => app.chat()?.pending[0] ?? null);
  const hasPrompt = createMemo(() => app.chat()?.items.some((i) => i.kind === "user") ?? false);
  const sideWidth = () => Math.min(36, Math.max(26, Math.floor(size().width * 0.24)));
  /**
   * The conversation's column: config.yml's `chat_width` (comfortable 104, wide 160, full the
   * content) inside what the side panel leaves, minus the transcript's 2+2 padding. The composer's
   * card, its menus, and an approval card draw at it; the footer under them stays the pane's status line.
   */
  const column = () => atuiColumn(app.boot()?.ui.chatWidth ?? null, size().width - (sidebar() ? sideWidth() : RAIL_WIDTH) - 4);

  // A run that ends: git and limits may have moved.
  createEffect(
    on(
      () => app.chat()?.status,
      (status, before) => {
        if (before && isBusy(before) && !isBusy(status)) {
          void app.refreshGit();
          void app.refreshLimits();
        }
      },
    ),
  );

  // History is read fresh when it opens: chats started since the last poll belong in it.
  createEffect(
    on(dialog, (d) => {
      if (d === "history") void app.refreshSessions();
    }),
  );

  /** Text for the message, after what is in the composer, which then has the focus. */
  const appendToComposer = (text: string) => {
    if (!composer) return;
    const now = composer.plainText.trimEnd();
    composer.setText(now ? `${now}\n\n${text}` : text);
    composer.gotoBufferEnd();
    leave();
  };

  /** M-q: the text selected with the mouse, into the message as a quote. */
  const quoteSelection = () => {
    const text = renderer.getSelection()?.getSelectedText().trim() ?? "";
    if (!text) return flash("Select text with the mouse first, then M-q quotes it");
    renderer.clearSelection();
    appendToComposer(`${quoteText(text)}\n\n`);
    flash("Quoted into your message");
  };
  // A selection made: say what it is good for.
  const onSelection = () => {
    if (renderer.getSelection()?.getSelectedText().trim()) flash("M-q quotes the selection into your message");
  };
  renderer.on("selection", onSelection);
  onCleanup(() => renderer.off("selection", onSelection));

  /** The one-line shell commands in the chat's recent answers, newest first, each once. */
  const runnables = () => {
    const c = app.chat();
    const seen = new Set<string>();
    const out: Array<{ command: string; shell: Parameters<typeof app.runCommand>[1] }> = [];
    const answers = (c?.items ?? []).filter((i) => i.kind === "assistant" && i.text.includes("```")).slice(-6).reverse();
    for (const a of answers) {
      for (const block of codeBlocks((a as { text: string }).text)) {
        const run = runnable(block.lang, block.code);
        if (run && !seen.has(run.command)) {
          seen.add(run.command);
          out.push(run);
        }
      }
    }
    return out.slice(0, 20);
  };
  const runOne = async (command: string, shell: Parameters<typeof app.runCommand>[1]) => {
    setRunning({ command, result: null });
    const result = await app.runCommand(command, shell);
    if (!result) return setRunning(null);
    setRunning((r) => (r && r.command === command ? { command, result } : r));
  };

  /** Bring a tool call's turn into view: the rail's run and job rows open the call they came from. */
  const revealTool = (toolId: string) => {
    const c = app.chat();
    if (!c || !scroller) return flash("No transcript to show that call in");
    const index = turnOfTool(buildTurns(c.items, c.status), toolId);
    if (index === null) return flash("That call is no longer in this chat's transcript");
    // A call the reader cannot see is one inside folded work: show the work, then go to its turn.
    setShowWork(true);
    const tops = scroller.content.getChildren().map((child) => (child as { y: number }).y);
    const y = tops[index];
    if (y !== undefined) glideTo(scroller, y);
  };

  const leave = () => {
    setMode("insert");
    setFocus("composer");
    composer?.focus();
  };

  /** NORMAL mode: Esc's way out of the composer, keys for moving instead of typing. */
  const toNormal = () => {
    setMode("normal");
    vimPending = "";
    composer?.blur();
    // With no status bar to keep it on screen, NORMAL's keys show for a moment as it starts.
    flash(VIM_HELP, 4000);
  };

  const half = () => Math.max(3, Math.floor(size().height / 2));
  const runVim = (action: NonNullable<ReturnType<typeof vimKey>["action"]>) => {
    switch (action.kind) {
      case "scroll":
        return scroller?.scrollBy(action.lines);
      case "half":
        return glideBy(scroller, action.dir * half());
      case "page":
        return glideBy(scroller, action.dir * Math.max(3, size().height - 6));
      case "top":
        return glideTo(scroller, 0);
      case "bottom":
        return glideTo(scroller, scroller?.scrollHeight ?? 0);
      case "turn": {
        if (!scroller) return;
        const tops = scroller.content.getChildren().map((c) => (c as { y: number }).y);
        const by = turnOffset(tops, scroller.viewport.y, action.count);
        if (by !== null) glideBy(scroller, by);
        return;
      }
      case "folds":
        return setShowWork(action.open);
      case "insert":
        return leave();
      case "sidebar":
        setSidebar(true);
        setFocus("sidebar");
        return;
      case "palette":
        return setDialog("palette");
      case "history":
        return setDialog("history");
    }
  };

  /** Sets the shared chat width (config.yml's chat_width) and says which; a server that refuses it (a limited session) leaves its reason in the banner. */
  const pickWidth = async (width: (typeof CHAT_WIDTHS)[number]) => {
    if (await app.setChatWidth(width)) flash(`Chat width: ${chatWidthLabel(width)}`);
  };

  const runLeader = (name: string) => {
    switch (name) {
      case "b":
        setSidebar(!sidebar());
        if (!sidebar()) leave();
        return;
      case "s":
        setSidebar(true);
        setSideTab("sessions");
        setFocus("sidebar");
        composer?.blur();
        return;
      case "i":
        // Info is a tab of the side panel: C-x i shows it, and again goes back to the sessions.
        if (sidebar() && sideTab() === "info") return setSideTab("sessions");
        setSidebar(true);
        return setSideTab("info");
      case "n":
        app.newChat();
        return leave();
      case "a":
        app.newChat({ newTab: true });
        return leave();
      case "]":
        return app.stepTab(1);
      case "[":
        return app.stepTab(-1);
      case "w": {
        const { tabs, active } = app.tabs();
        if (active < 0 || tabs.length === 0) return flash("No tab to close");
        app.closeTab(active);
        return leave();
      }
      case "r":
        return setDialog("history");
      case "m":
        return setDialog("models");
      case "h":
        return setDialog("harness");
      case "t":
        return setDialog("thinking");
      case "c":
        return void app.compact();
      case "x":
        if (runnables().length === 0) return flash("No one-line shell command in the recent answers to run");
        return setDialog("run");
      case "d":
        if (!app.chat()) return flash("No chat to review");
        return setReviewing(true);
      case "j":
        if (!app.chat()) return flash("No chat to show delegated work for");
        return setDelegated({});
      case "k":
        return setBoard(true);
      case "p":
        if (!app.chat()) return flash("No chat for active work yet");
        return setRail(true);
      case "u":
        if (!app.chat()) return flash("No chat to read the git status of");
        return setGitting(true);
      case "z":
        if (!app.putBackable()) return flash("Nothing to put back: no files were undone here");
        return void app.putBack();
      case "f":
        setCompactChoice((v) => !(v ?? (app.chat()?.context?.percent ?? 0) >= 80));
        return;
      case "e":
        return setShowWork(!showWork());
      case "v": {
        const on = !vim();
        setVim(on);
        p.onVim?.(on);
        leave();
        return flash(on ? "Vim navigation on: Esc for NORMAL (j/k, gg/G, {/}, zR/zM, :), i to type" : "Vim navigation off");
      }
      case "g": {
        const on = !app.glass();
        app.setGlass(on);
        p.onGlass?.(on);
        return flash(on ? "Glass on: the terminal's background shows through" : "Glass off");
      }
      case "l":
        return void pickWidth(nextChatWidth(app.boot()?.ui.chatWidth ?? null));
      case "q":
        return p.onExit();
      default:
        flash(`${leader(name)} is undefined`);
    }
  };

  useKeyboard((key) => {
    if (dialog() || app.undoTurn() !== null || reviewing() || running() || delegated() !== null || rail() || board() || gitting() || hubbing()) return;
    if (key.meta && !key.ctrl && key.name === "q") {
      key.preventDefault();
      return quoteSelection();
    }
    // After C-x: the next key is a command; Esc or C-g (or C-x again) cancels, as in Emacs.
    if (leaderOn()) {
      key.preventDefault();
      setLeaderOn(false);
      if (key.name === "escape" || (key.ctrl && (key.name === "g" || key.name === "x"))) return;
      if (key.ctrl || key.meta) return flash(`${leader(`${key.ctrl ? "C-" : "M-"}${key.name}`)} is undefined`);
      return runLeader(key.name);
    }
    if (key.ctrl && key.name === "x") {
      key.preventDefault();
      setHint(null);
      return setLeaderOn(true);
    }
    if (key.ctrl && (key.name === "k" || key.name === "p")) {
      key.preventDefault();
      return setDialog("palette");
    }
    // The pickers directly, without the leader: C-r as a shell's history search, M-letter for the rest.
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      return setDialog("history");
    }
    // M-1 to M-9: that tab.
    if (key.meta && !key.ctrl && /^[1-9]$/.test(key.name)) {
      const index = Number(key.name) - 1;
      if (index < app.tabs().tabs.length) {
        key.preventDefault();
        void app.switchTab(index);
        return;
      }
    }
    if (key.meta && !key.ctrl) {
      const direct: Record<string, Dialog> = { h: "harness", m: "models", t: "thinking", r: "history" };
      const target = direct[key.name];
      if (target) {
        key.preventDefault();
        return setDialog(target);
      }
    }
    // Esc while editing a past prompt: the edit is dropped, the prompt stays as it was (before vim takes Esc for NORMAL).
    if (key.name === "escape" && app.editing() && !key.ctrl && !key.meta) {
      key.preventDefault();
      app.setEditing(null);
      composer?.clear();
      return flash("Edit cancelled");
    }
    // Vim: Esc leaves the composer for NORMAL (a second one still stops a run);
    // in NORMAL the keys move around, and anything else falls through.
    if (vim() && focus() === "composer" && !pending()) {
      // A bare "/command" being typed has the command menu open: its Esc closes that first.
      const menuOpen = /^\/\S*$/.test(composer?.plainText ?? "");
      if (mode() === "insert" && key.name === "escape" && !key.ctrl && !key.meta && !menuOpen) {
        key.preventDefault();
        toNormal();
        if (app.busy()) {
          lastEsc = Date.now();
          flash("NORMAL · Esc again to stop the agent");
        }
        return;
      }
      if (mode() === "normal" && key.name !== "escape") {
        const { action, pending: next } = vimKey(key, vimPending);
        vimPending = next;
        if (action) {
          key.preventDefault();
          return runVim(action);
        }
        // A count or a `g`/`z` waiting for its second key; a stray letter types nothing either.
        if (next || (!key.ctrl && key.sequence.length === 1)) {
          key.preventDefault();
          return;
        }
      }
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      const step = Math.max(3, Math.floor(size().height / 2));
      glideBy(scroller, key.name === "pageup" ? -step : step);
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (focus() === "composer" && composer && composer.plainText) return composer.clear();
      if (app.busy()) return app.stop();
      if (Date.now() - lastCtrlC < TWICE_MS) return p.onExit();
      lastCtrlC = Date.now();
      return flash("C-c again to quit (the chats keep running on the server)");
    }
    if (key.name === "escape" && focus() === "composer" && !pending() && app.busy()) {
      key.preventDefault();
      if (Date.now() - lastEsc < TWICE_MS) {
        lastEsc = 0;
        return app.stop();
      }
      lastEsc = Date.now();
      return flash("Esc again to stop the agent");
    }
  });

  const paletteItems = (): PaletteItem[] => {
    const items: PaletteItem[] = [];
    const c = app.chat();
    const boot = app.boot();
    const name = (id: string) => boot?.harnesses.find((h) => h.id === id)?.displayName ?? id;
    const idle = c ? c.status === "idle" || c.status === "error" : true;
    const add = (item: Omit<PaletteItem, "section"> & { section?: string }) => items.push({ section: "Actions", ...item });
    add({ id: "new", label: "New chat", hint: leader("n"), run: () => runLeader("n") });
    add({ id: "new-tab", label: "New chat in a new tab", hint: leader("a"), run: () => runLeader("a") });
    const open = app.tabs();
    if (open.tabs.length >= 2) {
      add({ id: "next-tab", label: "Next tab", hint: leader("]"), run: () => runLeader("]") });
      add({ id: "prev-tab", label: "Previous tab", hint: leader("["), searchOnly: true, run: () => runLeader("[") });
    }
    if (open.tabs.length > 0) add({ id: "close-tab", label: "Close this tab", hint: leader("w"), searchOnly: open.tabs.length < 2, run: () => runLeader("w") });
    open.tabs.forEach((tab, i) => {
      items.push({ id: `tab:${tab.key}`, section: "Tabs", label: tab.title || "New chat", hint: i < 9 ? `M-${i + 1}` : "", current: i === open.active, searchOnly: open.tabs.length < 2, run: () => void app.switchTab(i) });
    });
    if (c && app.busy()) add({ id: "stop", label: "Stop the agent", hint: "Esc Esc", run: app.stop });
    // The last prompt's actions (a click on any prompt offers the same for it).
    const prompts = c ? c.items.filter((i): i is UserItem => i.kind === "user" && !i.command) : [];
    const last = prompts[prompts.length - 1];
    if (c && last) {
      const through = prompts.length;
      const branch = idle && (c.capabilities.supportsRewind || through === 1 || c.capabilities.supportsFork);
      const why = idle ? "This harness cannot replace or branch from it" : "Wait until the agent is idle";
      add({ id: "retry", label: "Retry the last message", disabled: branch ? undefined : why, run: () => void app.rerun(through, last, last.text) });
      add({ id: "edit", label: "Edit the last message", disabled: branch ? undefined : why, run: () => app.setEditing({ through, item: last }) });
      if (c.checkpoints.includes(through)) add({ id: "undo", label: "Undo file changes from the last message…", disabled: idle ? undefined : "Wait until the agent is idle", run: () => app.setUndoTurn(through) });
      if (c.capabilities.supportsFork) add({ id: "fork", label: "Fork this chat into a new tab", searchOnly: true, disabled: idle ? undefined : "Wait until the agent is idle", run: () => void app.fork(through) });
    }
    if (c) {
      const changed = collectChanges(c.items, c.workspace.path).length;
      const noted = app.reviewComments(c.chatId).filter((thread) => thread.status === "open").length;
      add({
        id: "review",
        label: "Review changes",
        hint: noted > 0 ? `${noted} ${noted === 1 ? "comment" : "comments"}` : leader("d"),
        disabled: changed > 0 ? undefined : "No files changed yet",
        run: () => setReviewing(true),
      });
    }
    add({ id: "board", label: "Agents: every session, by column", hint: leader("k"), keywords: "dashboard kanban needs working done", run: () => runLeader("k") });
    if (c) {
      const workers = c.delegated ?? [];
      const git = app.git();
      add({ id: "delegated", label: "Delegated work: review a worker…", hint: leader("j"), disabled: workers.length > 0 ? undefined : "This chat has delegated nothing", run: () => runLeader("j") });
      add({ id: "active-work", label: "Active work: workers, jobs, questions, context", hint: leader("p"), run: () => runLeader("p") });
      add({ id: "git", label: "Git: stage, commit, and the diffs", hint: leader("u"), ...(git ? { keywords: git.branch ?? "detached" } : {}), run: () => setGitting(true) });
    }
    // The PR screen reads the project alone, so it is offered with no chat too.
    add({ id: "github", label: "GitHub: the pull request, its checks, and the stack", run: () => setHubbing(true) });
    if (c && runnables().length > 0) add({ id: "run", label: "Run a command from the answer…", hint: leader("x"), run: () => setDialog("run") });
    add({ id: "quote", label: "Quote the selection into the message", hint: "M-q", searchOnly: true, run: quoteSelection });
    if (app.putBackable()) add({ id: "put-back", label: "Put the undone files back", hint: leader("z"), run: () => void app.putBack() });
    add({ id: "history", label: "History: every session, by project…", hint: "C-r", run: () => setDialog("history") });
    add({ id: "sessions", label: "Browse sessions", hint: leader("s"), run: () => runLeader("s") });
    add({ id: "sidebar", label: sidebar() ? "Fold the side panel" : "Unfold the side panel", hint: leader("b"), run: () => runLeader("b") });
    add({ id: "panel", label: sidebar() && sideTab() === "info" ? "Show sessions" : "Show info: context, usage, git, limits", hint: leader("i"), run: () => runLeader("i") });
    add({ id: "work", label: showWork() ? "Fold the work" : "Show the work of every turn", hint: leader("e"), run: () => runLeader("e") });
    add({ id: "glass", label: app.glass() ? "Glass off: solid panels" : "Glass on: see the terminal through", hint: leader("g"), run: () => runLeader("g") });
    // The shared chat width (config.yml's chat_width), as the web UI's Settings dialog sets it: every device draws it (C-x l cycles).
    CHAT_WIDTHS.forEach((w) => add({ id: `width:${w}`, label: `Chat width: ${chatWidthLabel(w)}`, keywords: "column layout measure", current: (boot?.ui.chatWidth ?? null) === w, run: () => void pickWidth(w) }));
    if (c?.capabilities.supportsCompact) add({ id: "compact", label: "Compact context", hint: leader("c"), disabled: idle ? undefined : "Wait until the agent is idle", run: () => runLeader("c") });
    const caps = c?.capabilities ?? app.harness()?.capabilities;
    add({ id: "model", label: "Choose model…", hint: "M-m", disabled: caps?.supportsModelSelection ? undefined : "This harness has no models to pick", run: () => setDialog("models") });
    if (caps?.supportsThinkingLevel) add({ id: "thinking", label: "Choose thinking level…", hint: "M-t", run: () => setDialog("thinking") });
    add({ id: "refresh-models", label: "Refresh models", keywords: "reload default list", ...(idle ? {} : { disabled: "Wait until the agent is idle" }), run: () => void app.refreshModels() });
    add({ id: "harness", label: hasPrompt() ? "Choose harness, or hand this chat off…" : "Choose harness…", hint: "M-h", run: () => setDialog("harness") });
    add({ id: "quit", label: "Quit atui", hint: leader("q"), searchOnly: true, run: p.onExit });
    const sessions = app.overview().sessions;
    sessions.forEach((s, i) => {
      items.push({
        id: `s:${s.id}`,
        section: "Sessions",
        label: s.title || "New chat",
        hint: app.overview().workspaces.find((w) => w.id === s.workspaceId)?.name ?? "",
        keywords: name(s.harnessId),
        searchOnly: i >= 8,
        current: c !== null && (c.sessionId === s.id || s.liveChatId === c.chatId),
        run: () => void app.openSession(s),
      });
    });
    if (c?.capabilities.supportsThinkingLevel) {
      for (const level of c.config.thinkingLevels) {
        items.push({ id: `t:${level}`, section: "Thinking", label: `Thinking: ${level}`, searchOnly: true, current: level === c.config.thinkingLevel, disabled: idle ? undefined : "Wait until the agent is idle", run: () => void app.configure({ thinkingLevel: level }) });
      }
    }
    return items;
  };

  /** The models to offer: the chat's own list, else the start screen's catalog (which the first message's chat starts on). */
  const modelItems = (): PaletteItem[] => {
    const c = app.chat();
    const idle = !c || c.status === "idle" || c.status === "error";
    const current = app.chips().model?.key ?? null;
    return app.pickerModels().map((m) => ({
      id: m.key,
      section: m.provider,
      label: m.name,
      hint: m.provider,
      keywords: m.key,
      current: m.key === current,
      disabled: idle ? undefined : "Wait until the agent is idle",
      run: () => void app.pickModel(m.key),
    }));
  };

  /** With a conversation open, first the harnesses it can move to (the web UI's handoff), then the one for new chats. */
  const harnessItems = (): PaletteItem[] => {
    const harnesses = app.boot()?.harnesses ?? [];
    const c = app.chat();
    const moves: PaletteItem[] =
      c && hasPrompt()
        ? harnesses
            .filter((h) => h.id !== c.harnessId)
            .map((h) => ({
              id: `move:${h.id}`,
              section: "Hand off this chat to",
              label: h.displayName,
              // The picker's hint column is short: a copy of the turns, or a fresh chat briefed with a summary.
              hint: h.capabilities.supportsHandoff ? "keeps the turns" : "from a summary",
              disabled: h.available ? undefined : (h.reason ?? "Not available"),
              run: () => void app.handoff(h.id),
            }))
        : [];
    const fresh = harnesses.map((h) => ({
      id: h.id,
      section: "Harness for new chats",
      label: h.displayName,
      hint: h.version ?? "",
      current: h.id === app.harnessId(),
      disabled: h.available ? undefined : (h.reason ?? "Not available"),
      run: () => app.chooseHarness(h.id),
    }));
    return [...moves, ...fresh];
  };

  const thinkingItems = (): PaletteItem[] => {
    const c = app.chat();
    const caps = c?.capabilities ?? app.harness()?.capabilities;
    if (!caps?.supportsThinkingLevel) return [];
    const idle = !c || c.status === "idle" || c.status === "error";
    const current = app.chips().level;
    return app.pickerLevels().map((level) => ({
      id: level,
      section: "Thinking",
      label: level,
      current: level === current,
      disabled: idle ? undefined : "Wait until the agent is idle",
      run: () => void app.pickThinking(level),
    }));
  };

  /** Every session the server knows, newest first, under its project: the current project's first. */
  const historyItems = (): PaletteItem[] => {
    const { sessions, workspaces } = app.overview();
    const here = app.workspace()?.id;
    const c = app.chat();
    const name = (id: string) => app.boot()?.harnesses.find((h) => h.id === id)?.displayName ?? id;
    const project = (id: string | undefined) => workspaces.find((w) => w.id === id)?.name ?? "Other";
    const order = (id: string | undefined) => (id === here ? 0 : 1);
    return [...sessions]
      .sort((a, b) => order(a.workspaceId) - order(b.workspaceId) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map((s) => ({
        id: `h:${s.id}`,
        section: project(s.workspaceId),
        label: s.title || "New chat",
        hint: [isBusy(s.status ?? "idle") ? "working" : ago(s.updatedAt), name(s.harnessId)].filter(Boolean).join(" · "),
        keywords: `${name(s.harnessId)} ${project(s.workspaceId)}`,
        current: c !== null && (c.sessionId === s.id || s.liveChatId === c.chatId),
        run: () => void app.openSession(s),
      }));
  };

  /** The history picker's preview: the session's last prompt and answer, from the server. */
  const historyPreview = (item: PaletteItem): Promise<PreviewText | null> | null => {
    const s = app.overview().sessions.find((x) => `h:${x.id}` === item.id);
    if (!s) return null;
    const name = app.boot()?.harnesses.find((h) => h.id === s.harnessId)?.displayName ?? s.harnessId;
    return app.preview(s).then((view) =>
      view
        ? {
            head: [name, `${view.turns} ${view.turns === 1 ? "turn" : "turns"}`, ago(s.updatedAt)].filter(Boolean).join(" · "),
            body: [view.prompt ? `› ${view.prompt}` : "", view.answer ?? ""].filter(Boolean).join("\n\n"),
          }
        : null,
    );
  };

  // One line: a chat is titled from its first prompt, which can run to several.
  const title = () => {
    const g = ghost();
    if (g) return g.title.replace(/\s+/g, " ").trim();
    const c = app.chat();
    if (!c) return app.workspace()?.name ?? "atui";
    return c.title.replace(/\s+/g, " ").trim() || "New chat";
  };

  // The terminal's own title and tab progress follow the shown chat and the sessions that ask for you.
  const terminal = createMemo(() => terminalState({ title: title(), busy: app.busy(), asking: app.overview().sessions.filter((s) => s.asking).length }), undefined, {
    equals: (a, b) => a.title === b.title && a.progress === b.progress,
  });
  createEffect(() => p.onTerminal?.(terminal()));

  // A dialog takes the conversation's place rather than drawing over it: OpenTUI paints a bordered box's own body
  // after a sibling overlay, so a floating picker lets the cards behind it through.
  const sheet = () => dialog() !== null || reviewing() || app.undoTurn() !== null || running() !== null || delegated() !== null || rail() || board() || gitting() || hubbing();
  /** What the side panel leaves of the screen for a sheet. */
  const room = () => (sidebar() ? sideWidth() : RAIL_WIDTH);

  return (
    <AtuiContext.Provider value={app}>
      <box flexDirection="column" width="100%" height="100%">
        <box flexDirection="row" flexGrow={1}>
          <Show when={sidebar()} fallback={<SidebarRail onExpand={() => setSidebar(true)} />}>
            <Sidebar
              active={focus() === "sidebar" && !dialog()}
              width={sideWidth()}
              tab={sideTab()}
              onTab={setSideTab}
              onCollapse={() => {
                setSidebar(false);
                leave();
              }}
              onOpened={leave}
              onLeave={leave}
            />
          </Show>
          <box flexDirection="column" flexGrow={1}>
            <TabBar />
            <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} border={["bottom"]} borderColor={t().border}>
              <text flexGrow={1} fg={t().text} wrapMode="none" truncate>
                <b>{title()}</b>
              </text>
              <Show when={!ghost() && app.chat()}>
                {(c) => (
                  <text flexShrink={0}>
                    <span style={{ fg: accentOf(t(), app.harness()?.accent) }}>{`${harnessGlyph(c().harnessId)} ${app.harness()?.displayName ?? c().harnessId}`}</span>
                    {"  "}
                    <Show when={isBusy(c().status)} fallback={<span style={{ fg: c().status === "error" ? t().danger : t().muted }}>{STATUS_LABEL[c().status]}</span>}>
                      <Shimmer text={STATUS_LABEL[c().status]} base={t().accent} glow={t().text} />
                    </Show>
                    <span style={{ fg: t().muted }}>{`  ${c().workspace.name}`}</span>
                  </text>
                )}
              </Show>
            </box>
            <Show
              when={sheet()}
              fallback={
                <box flexDirection="column" flexGrow={1}>
                  <Show
                    when={ghost()}
                    fallback={
                      <Show
                        when={hasPrompt()}
                        fallback={<Splash question={`What should ${app.harness()?.displayName ?? "the agent"} do in ${app.workspace()?.name ?? "this project"}?`} subtitle="It runs with its normal tools, as you, in this folder." />}
                      >
                        <Transcript ref={(el) => (scroller = el as ScrollBoxRenderable)} showWork={showWork()} column={column} />
                      </Show>
                    }
                  >
                    {(g) => <SwitchGhost title={g().title} harnessId={g().harnessId} column={column} />}
                  </Show>
                  <Show when={app.banner()}>
                    {(b) => (
                      <box flexShrink={0} paddingLeft={2} paddingRight={2}>
                        <text fg={b().level === "error" ? t().danger : b().level === "warning" ? t().warn : t().info} wrapMode="word">
                          {b().text}
                        </text>
                      </box>
                    )}
                  </Show>
                  <Show when={app.chat()?.gone}>
                    {(gone) => (
                      <box flexShrink={0} paddingLeft={2}>
                        <text fg={t().warn}>{`${gone()} · ${leader("n")} for a new chat`}</text>
                      </box>
                    )}
                  </Show>
                  <Toasts />
                  <Show
                    when={pending()}
                    keyed
                    fallback={
                      <Composer
                        status={{ mode: vim() ? (normal() ? "normal" : "insert") : null, leader: leaderOn(), note: hint() }}
                        focused={focus() === "composer" && !dialog() && !normal() && app.undoTurn() === null && !reviewing() && !running()}
                        compactChoice={compactChoice()}
                        onCompactChoice={setCompactChoice}
                        onPick={setDialog}
                        onContext={() => setRail(true)}
                        column={column()}
                        ref={(el) => (composer = el)}
                      />
                    }
                  >
                    {(request) => <RequestCard request={request} more={(app.chat()?.pending.length ?? 1) - 1} active={focus() === "composer" && !dialog()} column={column()} />}
                  </Show>
                </box>
              }
            >
              <box flexDirection="column" flexGrow={1}>
                <Show when={dialog() === "palette"}>
                  <Picker title="Commands" placeholder="Search commands, sessions, thinking…" items={paletteItems()} onClose={() => setDialog(null)} side={room()} />
                </Show>
                <Show when={dialog() === "models"}>
                  <Picker title="Model" placeholder="Search models…" items={modelItems()} onClose={() => setDialog(null)} side={room()} />
                </Show>
                <Show when={dialog() === "harness"}>
                  <Picker title="Harness" placeholder="Search harnesses…" items={harnessItems()} onClose={() => setDialog(null)} firstHeading={hasPrompt()} side={room()} />
                </Show>
                <Show when={dialog() === "thinking"}>
                  <Picker title="Thinking" placeholder="Search levels…" items={thinkingItems()} onClose={() => setDialog(null)} side={room()} />
                </Show>
                <Show when={dialog() === "run"}>
                  <Picker
                    title="Run a command from the answer"
                    placeholder="Search commands…"
                    firstHeading
                    items={runnables().map((r, i) => ({
                      id: `run:${i}`,
                      section: `In ${app.chat()?.workspace.name ?? "the project"}, with ${r.shell}`,
                      label: `$ ${r.command}`,
                      run: () => void runOne(r.command, r.shell),
                    }))}
                    onClose={() => setDialog(null)}
                    side={room()}
                  />
                </Show>
                <Show when={running()}>
                  {(r) => (
                    <RunOutput
                      command={r().command}
                      result={r().result}
                      onAdd={() => {
                        const done = r().result;
                        // Close the sheet first: it stands where the composer does, so the composer is only there to fill once it goes.
                        setRunning(null);
                        if (done) appendToComposer(`${runForMessage(r().command, done.output, runStatus(done))}\n\n`);
                      }}
                      onClose={() => setRunning(null)}
                      side={room()}
                    />
                  )}
                </Show>
                <Show when={dialog() === "history"}>
                  <Picker title="History" placeholder="Search sessions, projects, harnesses…" items={historyItems()} onClose={() => setDialog(null)} firstHeading preview={historyPreview} side={room()} />
                </Show>
                <Show when={reviewing()}>
                  <ReviewView onClose={() => setReviewing(false)} />
                </Show>
                <Show when={gitting()}>
                  <GitView onClose={() => setGitting(false)} />
                </Show>
                <Show when={hubbing()}>
                  <GitHubView onClose={() => setHubbing(false)} />
                </Show>
                <Show when={delegated()}>
                  {(open) => (
                    <DelegatedView
                      initialTaskId={open().taskId ?? null}
                      onClose={() => setDelegated(null)}
                      onOpenChat={(chatId) => {
                        setDelegated(null);
                        void app.openChat(chatId);
                      }}
                    />
                  )}
                </Show>
                <Show when={rail()}>
                  <ContextRailView
                    onClose={() => setRail(false)}
                    onChat={(chatId) => {
                      setRail(false);
                      void app.openChat(chatId);
                    }}
                    onTask={(taskId) => {
                      setRail(false);
                      setDelegated({ taskId });
                    }}
                    onTool={(toolId) => {
                      setRail(false);
                      revealTool(toolId);
                    }}
                    onReview={() => {
                      setRail(false);
                      setReviewing(true);
                    }}
                    onUsage={() => {
                      setRail(false);
                      setSidebar(true);
                      setSideTab("info");
                      leave();
                    }}
                  />
                </Show>
                <Show when={board()}>
                  <BoardView
                    onClose={() => setBoard(false)}
                    onOpenSession={(session) => {
                      setBoard(false);
                      void app.openSession(session);
                    }}
                  />
                </Show>
                <Show when={app.undoTurn()}>{(turn) => <UndoDialog turn={turn()} onClose={() => app.setUndoTurn(null)} side={room()} />}</Show>
              </box>
            </Show>
          </box>
        </box>
        <Show when={leaderOn() && !dialog()}>
          <WhichKey
            state={{ b: sidebar() ? "on" : "off", i: sidebar() && sideTab() === "info" ? "on" : "off", e: showWork() ? "on" : "off", v: vim() ? "on" : "off", g: app.glass() ? "on" : "off" }}
            onPick={(k) => {
              setLeaderOn(false);
              runLeader(k);
            }}
          />
        </Show>
      </box>
    </AtuiContext.Provider>
  );
}
