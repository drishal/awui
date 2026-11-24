// atui's screen: a side panel on the left (Sessions and Info tabs, folding to
// a rail), the conversation and composer beside it, and no status bar: the
// composer's footer carries the vim style's mode, a waiting leader, a lost
// connection, and a passing hint; dialogs over it all. Two keybind styles,
// switched with C-x v (or SPC v in vim's) and remembered: the Emacs chords
// (C- is Ctrl, M- is Alt; C-k commands, C-r history, M-h/M-m/M-t the harness,
// model, and thinking pickers, C-x then a letter for the rest, which a
// which-key panel lists), or vim's NORMAL-first keys (j/k with counts, gg/G,
// {/}, gt tabs, : commands, / history, Space for the same action panel, i to
// type). Both styles: PageUp/PageDown scroll, Esc Esc stops the agent, C-c
// clears, stops, or (twice) quits. Jumps of more than a line glide; C-x g is
// glass mode (no fills, the terminal's background shows through); background
// sessions' news toasts in the corner, and the terminal's title and tab
// progress follow the chat.
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { ChatSearch, RunResult } from "../../shared/protocol.js";
import { runnable } from "../../web/code-blocks.js";
import { codeBlocks, quoteText, runForMessage, runStatus } from "../assist.js";
import { RunOutput } from "./runout.js";
import type { UserItem } from "../../shared/protocol.js";
import type { PaletteItem } from "../../web/palette.js";
import { isBusy } from "../../web/session-groups.js";
import { atuiColumn, chatWidthLabel, CHAT_WIDTHS, nextChatWidth } from "../../shared/chat-width.js";
import { ago, clip, STATUS_LABEL } from "../format.js";
import { actionKeys, leader, leaderPrefix, LEADER_KEYS, VIM_HELP, type KeybindStyle } from "../keys.js";
import { harnessGlyph } from "../neat.js";
import type { Atui } from "../state.js";
import { terminalState, type TerminalState } from "../terminal.js";
import { accentOf } from "../theme.js";
import { Composer } from "./composer.js";
import { AtuiContext } from "./context.js";
import { glideBy, glideTo, Shimmer } from "./fx.js";
import { findTurns } from "../../web/find.js";
import { turnMarkdown } from "../../web/turn-markdown.js";
import { SwitchGhost } from "./ghost.js";
import { Picker, type PickerItem, type PreviewText } from "./picker.js";
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
import { TerminalView } from "./terminal.js";
import { GitHubView } from "./github.js";
import { collectChanges } from "../../web/review.js";
import { Toasts } from "./toasts.js";
import { Transcript } from "./transcript.js";
import { WhichKey } from "./whichkey.js";
import { turnOffset, vimKey, pushJump, type Jump } from "../vim.js";
import { buildTurns, turnOfTool } from "../../web/turns.js";
import { atLabel, turnWaterfall } from "../../web/waterfall.js";
import { cacheShare, dollars, shortTokens, tokensOf } from "../../web/usage.js";

type Dialog = "palette" | "models" | "harness" | "thinking" | "permission" | "queue" | "timing" | "usage" | "history" | "find" | "chats" | "run" | null;

/**
 * The palette's headings, as Tern's palette groups its commands (Chats, Agent, View, Project, More): a flat list of
 * forty actions under one "Actions" word gave no way to scan it. An id not named here is "More".
 */
const PALETTE_GROUPS: Record<string, string> = {
  new: "Chats", "new-tab": "Chats", "next-tab": "Chats", "prev-tab": "Chats", "close-tab": "Chats", history: "Chats", find: "Chats", queue: "Chats", timing: "Chats", "copy-answer": "Chats", "copy-turn": "Chats", sessions: "Chats",
  retry: "Chats", edit: "Chats", undo: "Chats", fork: "Chats", "put-back": "Chats", quote: "Chats",
  stop: "Agent", review: "Agent", board: "Agent", delegated: "Agent", "active-work": "Agent", run: "Agent", compact: "Agent",
  model: "Agent", thinking: "Agent", permission: "Agent", "refresh-models": "Agent", harness: "Agent",
  sidebar: "View", panel: "View", work: "View", thoughts: "View", keybinds: "View", glass: "View",
  git: "Project", github: "Project", usage: "Project",
};
/** The headings' order; Tabs, Sessions and the thinking levels keep their own and follow. */
const PALETTE_ORDER = ["Chats", "Tabs", "Agent", "View", "Project", "More"];

const TWICE_MS = 1200;
/** A session that opens within this shows at once; one that takes longer gets the ghost thread meanwhile. */
const GHOST_AFTER_MS = 50;

export function App(p: {
  app: Atui;
  onExit: () => void;
  keybinds?: KeybindStyle;
  onKeybinds?: (style: KeybindStyle) => void;
  onGlass?: (on: boolean) => void;
  showThoughts: boolean;
  onShowThoughts: (on: boolean) => void;
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
  // The chip under a prompt asks for the Timing picker through the state; the dialog is this screen's.
  createEffect(() => {
    if (app.timingFor() !== null) setDialog("timing");
  });
  // The work shows, as neat-render draws it (nothing folds); C-x e folds every turn to its line.
  const thoughts = () => p.showThoughts;
  const [showWork, setShowWork] = createSignal(true);
  const [compactChoice, setCompactChoice] = createSignal<boolean | null>(null);
  const [reviewing, setReviewing] = createSignal(false);
  /** The delegated work panel, opened on one worker when a rail row named it. */
  const [delegated, setDelegated] = createSignal<{ taskId?: string } | null>(null);
  const [rail, setRail] = createSignal(false);
  const [board, setBoard] = createSignal(false);
  /** The git panel: the project's status, staging, and commits (C-x u). */
  const [gitting, setGitting] = createSignal(false);
  const [shell, setShell] = createSignal(false);
  /** The GitHub panel: the project's PR, its checks, and its stack (C-x p). */
  const [hubbing, setHubbing] = createSignal(false);
  /** A command run from an answer (C-x x), and what it gave once done. */
  const [running, setRunning] = createSignal<{ command: string; result: RunResult | null } | null>(null);
  const renderer = useRenderer();
  const [hint, setHint] = createSignal<string | null>(null);
  /** C-x was pressed: the which-key panel is open and the next key is a command. */
  const [leaderOn, setLeaderOn] = createSignal(false);
  const [keybinds, setKeybinds] = createSignal<KeybindStyle>(p.keybinds ?? "emacs");
  const [mode, setMode] = createSignal<"insert" | "normal">(p.keybinds === "vim" ? "normal" : "insert");
  const normal = () => keybinds() === "vim" && mode() === "normal";
  /** Keys typed toward a NORMAL command so far: a count, a `g`, `z` or `Z`. */
  let vimPending = "";
  /** The jumplist: reading positions left behind by jumps, and where in them we are. */
  let jumps: Jump[] = [];
  let jumpAt = -1;
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
    const index = turnOfTool(buildTurns(c.items, c.status, c.runStartedAt), toolId);
    if (index === null) return flash("That call is no longer in this chat's transcript");
    // A call the reader cannot see is one inside folded work: show the work, then go to its turn.
    setShowWork(true);
    const tops = scroller.content.getChildren().map((child) => (child as { y: number }).y);
    const y = tops[index];
    if (y !== undefined) glideTo(scroller, y);
  };

  // Where an action that finished elsewhere leaves the keys: typing, or (in the
  // vim style) back in NORMAL, the mode the reader was in.
  const leave = (into: "insert" | "keep" = "insert") => {
    const to = into === "keep" && keybinds() === "vim" ? "normal" : "insert";
    setMode(to);
    setFocus("composer");
    if (to === "insert") composer?.focus();
    else composer?.blur();
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
  // A jump leaves where it came from on the jumplist, so Ctrl+O can come back (Ctrl+I forward again).
  const mark = () => {
    if (scroller) ({ list: jumps, at: jumpAt } = pushJump(jumps, jumpAt, scroller.scrollTop));
  };
  const runVim = (action: NonNullable<ReturnType<typeof vimKey>["action"]>) => {
    switch (action.kind) {
      case "scroll":
        return scroller?.scrollBy(action.lines);
      case "half":
        return glideBy(scroller, action.dir * half());
      case "page":
        return glideBy(scroller, action.dir * Math.max(3, size().height - 6));
      case "top":
        mark();
        return glideTo(scroller, 0);
      case "bottom":
        mark();
        return glideTo(scroller, scroller?.scrollHeight ?? 0);
      case "turn": {
        if (!scroller) return;
        const tops = scroller.content.getChildren().map((c) => (c as { y: number }).y);
        const by = turnOffset(tops, scroller.viewport.y, action.count);
        if (by !== null) {
          mark();
          glideBy(scroller, by);
        }
        return;
      }
      // zz: the turn being read moves to the middle of the view, vim's way of settling a long scroll.
      case "view": {
        const box = scroller;
        if (!box) return;
        const tops = box.content.getChildren().map((c) => (c as { y: number }).y);
        const at = tops.find((y) => y >= box.viewport.y) ?? box.viewport.y;
        return glideTo(box, at - box.viewport.height / 2);
      }
      case "folds":
        return setShowWork(action.open);
      case "insert":
        // o is vim's "open below": a new chat of one's own, straight into INSERT.
        if (action.open) app.newChat();
        return leave();
      case "sidebar":
        setSidebar(true);
        setFocus("sidebar");
        return;
      // l from the session list is the other half of vim's h/l pair, handled in the sidebar itself.
      case "leave":
        return;
      case "tab": {
        const { tabs } = app.tabs();
        if (action.to !== undefined) {
          if (action.to < tabs.length) void app.switchTab(action.to);
        } else app.stepTab(action.step === -1 ? -1 : 1);
        return;
      }
      case "closeTab": {
        const { tabs, active } = app.tabs();
        if (active < 0 || tabs.length === 0) return flash("No tab to close");
        app.closeTab(active);
        return;
      }
      case "quit":
        return p.onExit();
      case "leader":
        setHint(null);
        return setLeaderOn(true);
      case "jump": {
        const dir: -1 | 1 = action.dir;
        const at = jumpAt + dir;
        if (at < 0 || at >= jumps.length) return flash(dir < 0 ? "Already where the jumps began" : "Already the newest jump");
        jumpAt = at;
        return glideTo(scroller, (jumps[at] as Jump).y);
      }
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
      case "o":
        p.onShowThoughts(!thoughts());
        flash(thoughts() ? `Reasoning visible (${leader("o", keybinds())} folds)` : `Reasoning folded (${leader("o", keybinds())} shows)`);
        return;
      case "u": {
        setGitting(true);
        void app.openGit();
        return;
      }
      case "z":
        if (!app.putBackable()) return flash("Nothing to put back: no files were undone here");
        return void app.putBack();
      case "f":
        setCompactChoice((v) => !(v ?? (app.chat()?.context?.percent ?? 0) >= 80));
        return;
      case "e":
        return setShowWork(!showWork());
      case "v": {
        const next: KeybindStyle = keybinds() === "vim" ? "emacs" : "vim";
        setKeybinds(next);
        p.onKeybinds?.(next);
        setMode(next === "vim" ? "normal" : "insert");
        if (next === "vim") composer?.blur();
        else composer?.focus();
        return flash(next === "vim" ? "Vim keybinds: NORMAL keys, SPC for actions, i to type (SPC v back)" : "Emacs keybinds: C-x for the rest (C-x v back to vim)");
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
        flash(`${leader(name, keybinds())} is undefined`);
    }
  };

  useKeyboard((key) => {
    if (dialog() || app.undoTurn() !== null || reviewing() || running() || delegated() !== null || rail() || board() || gitting() || hubbing() || shell()) return;
    if (key.meta && !key.ctrl && key.name === "q") {
      key.preventDefault();
      return quoteSelection();
    }
    // After the leader (C-x in the Emacs style, Space in vim's): the next key is a command;
    // Esc or C-g (or the leader again) cancels, as in Emacs.
    if (leaderOn()) {
      key.preventDefault();
      setLeaderOn(false);
      if (key.name === "escape" || (key.ctrl && (key.name === "g" || key.name === "x"))) return;
      if (key.ctrl || key.meta) return flash(`${leader(`${key.ctrl ? "C-" : "M-"}${key.name}`, keybinds())} is undefined`);
      return runLeader(key.name);
    }
    // Vim's keys: Esc leaves INSERT for NORMAL; in NORMAL the keys move and act.
    // The Emacs chords below are off in this style, but the universal keys (PageUp/Down,
    // C-c, the double-Esc stop) still see everything that falls through.
    if (keybinds() === "vim" && focus() === "composer" && !pending()) {
      if (key.ctrl && key.name === "x") {
        key.preventDefault();
        if (normal()) flash("Vim keybinds: Space is the leader, : the commands");
        return;
      }
      if (mode() === "insert") {
        // A bare "/command" being typed has the command menu open: its Esc closes that first,
        // and an edit of a past prompt keeps Esc for cancelling the edit.
        const menuOpen = app.editing() !== null || /^\/\S*$/.test(composer?.plainText ?? "");
        if (key.name === "escape" && !key.ctrl && !key.meta && !menuOpen) {
          key.preventDefault();
          toNormal();
          if (app.busy()) {
            lastEsc = Date.now();
            flash("NORMAL · Esc again to stop the agent");
          }
        }
        // Anything else types into the composer; the Emacs chords below are off in
        // this style, so only the universal keys see it.
      } else if (key.name !== "escape") {
        const { action, pending: next } = vimKey(key, vimPending);
        vimPending = next;
        if (action) {
          key.preventDefault();
          return runVim(action);
        }
        // A count or a `g`/`z`/`Z` waiting for its second key; a stray letter moves nothing either.
        if (next || (!key.ctrl && key.sequence.length <= 1)) return key.preventDefault();
      }
    }
    if (key.ctrl && key.name === "x") {
      key.preventDefault();
      setHint(null);
      return setLeaderOn(true);
    }
    // C-s: find in chat, in both styles (a ctrl chord, so vim's NORMAL keys are untouched).
    if (key.ctrl && !key.meta && key.name === "s" && app.chat()) {
      key.preventDefault();
      return setDialog("find");
    }
    // M-n / M-p: step through the turns the last find matched (a meta chord, so no typed letter or vim key is touched).
    if (key.meta && !key.ctrl && (key.name === "n" || key.name === "p") && landed()) {
      key.preventDefault();
      if (stepFind(key.name === "n" ? 1 : -1)) return;
    }
    if (keybinds() === "emacs" && key.ctrl && key.name === "t") {
      key.preventDefault();
      p.onShowThoughts(!thoughts());
      flash(thoughts() ? "Reasoning visible (C-t folds)" : "Reasoning folded (C-t shows)");
      return;
    }
    if (keybinds() === "emacs" && key.ctrl && (key.name === "k" || key.name === "p")) {
      key.preventDefault();
      return setDialog("palette");
    }
    // The pickers directly, without the leader: C-r as a shell's history search, M-letter for the rest.
    if (keybinds() === "emacs" && key.ctrl && key.name === "r") {
      key.preventDefault();
      return setDialog("history");
    }
    // M-1 to M-9: that tab.
    if (keybinds() === "emacs" && key.meta && !key.ctrl && /^[1-9]$/.test(key.name)) {
      const index = Number(key.name) - 1;
      if (index < app.tabs().tabs.length) {
        key.preventDefault();
        void app.switchTab(index);
        return;
      }
    }
    if (keybinds() === "emacs" && key.meta && !key.ctrl) {
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
    const keys = actionKeys(keybinds());
    const name = (id: string) => boot?.harnesses.find((h) => h.id === id)?.displayName ?? id;
    const idle = c ? c.status === "idle" || c.status === "error" : true;
    const add = (item: Omit<PaletteItem, "section"> & { section?: string }) => items.push({ section: PALETTE_GROUPS[item.id] ?? (item.id.startsWith("width:") ? "View" : "More"), ...item });
    add({ id: "new", label: "New chat", hint: leader("n", keybinds()), run: () => runLeader("n") });
    add({ id: "new-tab", label: "New chat in a new tab", hint: leader("a", keybinds()), run: () => runLeader("a") });
    const open = app.tabs();
    if (open.tabs.length >= 2) {
      add({ id: "next-tab", label: "Next tab", hint: leader("]", keybinds()), run: () => runLeader("]") });
      add({ id: "prev-tab", label: "Previous tab", hint: leader("[", keybinds()), searchOnly: true, run: () => runLeader("[") });
    }
    if (open.tabs.length > 0) add({ id: "close-tab", label: "Close this tab", hint: leader("w", keybinds()), searchOnly: open.tabs.length < 2, run: () => runLeader("w") });
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
        hint: noted > 0 ? `${noted} ${noted === 1 ? "comment" : "comments"}` : leader("d", keybinds()),
        disabled: changed > 0 ? undefined : "No files changed yet",
        run: () => setReviewing(true),
      });
    }
    add({ id: "board", label: "Agents: every session, by column", hint: leader("k", keybinds()), keywords: "dashboard kanban needs working done", run: () => runLeader("k") });
    if (c) {
      const workers = c.delegated ?? [];
      const git = app.git();
      add({ id: "delegated", label: "Delegated work: review a worker…", hint: leader("j", keybinds()), disabled: workers.length > 0 ? undefined : "This chat has delegated nothing", run: () => runLeader("j") });
      add({ id: "active-work", label: "Active work: workers, jobs, questions, context", hint: leader("p", keybinds()), run: () => runLeader("p") });
      add({ id: "git", label: "Git: stage, commit, and the diffs", hint: leader("u", keybinds()), ...(git ? { keywords: git.branch ?? "detached" } : {}), run: () => setGitting(true) });
    }
    // The PR screen reads the project alone, so it is offered with no chat too.
    add({ id: "github", label: "GitHub: the pull request, its checks, and the stack", run: () => setHubbing(true) });
    if (c && runnables().length > 0) add({ id: "run", label: "Run a command from the answer…", hint: leader("x", keybinds()), run: () => setDialog("run") });
    add({ id: "quote", label: "Quote the selection into the message", hint: "M-q", searchOnly: true, run: quoteSelection });
    if (app.putBackable()) add({ id: "put-back", label: "Put the undone files back", hint: leader("z", keybinds()), run: () => void app.putBack() });
    if (c && last) {
      const turns = buildTurns(c.items, c.status, c.runStartedAt);
      const done = [...turns].reverse().find((x) => x.prompt && x.answer?.text);
      if (done?.answer?.text) {
        const answer = done.answer.text;
        add({ id: "copy-answer", label: "Copy the last answer", searchOnly: true, run: () => { void renderer.copyToClipboardOSC52(answer); flash("Copied the last answer"); } });
        add({ id: "copy-turn", label: "Copy the last turn as Markdown", searchOnly: true, run: () => { void renderer.copyToClipboardOSC52(turnMarkdown(done, c.workspace.path)); flash("Copied the last turn as Markdown"); } });
      }
    }
    if (c && last) {
      const lastDone = [...buildTurns(c.items, c.status, c.runStartedAt)].reverse().find((x) => x.prompt && x.answer);
      if (lastDone?.prompt) add({ id: "timing", label: "Timing of the last turn", keywords: "waterfall slow speed duration steps calls", run: () => { app.setTimingFor(lastDone.prompt?.id ?? null); setDialog("timing"); } });
    }
    add({ id: "usage", label: "Usage across chats", keywords: "tokens cost spend cache models harnesses", run: () => setDialog("usage") });
    if (c) add({ id: "find", label: "Find in chat…", hint: "C-s", keywords: "search text turns", run: () => setDialog("find") });
    if (c && landed()) add({ id: "find-clear", label: "Clear find marks", hint: "M-n / M-p stop stepping", keywords: "find search unmark gutter", run: () => { setLanded(null); flash("Find marks cleared"); } });
    add({ id: "search-chats", label: "Search every chat…", keywords: "find text sessions history all projects harnesses grep", run: () => setDialog("chats") });
    add({ id: "history", label: "History: every session, by project…", hint: keys.history, run: () => setDialog("history") });
    add({ id: "sessions", label: "Browse sessions", hint: leader("s", keybinds()), run: () => runLeader("s") });
    add({ id: "sidebar", label: sidebar() ? "Fold the side panel" : "Unfold the side panel", hint: leader("b", keybinds()), run: () => runLeader("b") });
    add({ id: "panel", label: sidebar() && sideTab() === "info" ? "Show sessions" : "Show info: context, usage, git, limits", hint: leader("i", keybinds()), run: () => runLeader("i") });
    add({ id: "work", label: showWork() ? "Fold the work" : "Show the work of every turn", hint: leader("e", keybinds()), run: () => runLeader("e") });
    add({ id: "thoughts", label: thoughts() ? "Fold all reasoning" : "Show all reasoning", hint: keys.thoughts, run: () => { p.onShowThoughts(!thoughts()); setDialog(null); } });
    add({ id: "keybinds", label: keybinds() === "vim" ? "Emacs keybinds: the C-x chords" : "Vim keybinds: NORMAL keys, Space actions", keywords: "emacs vim keys mode style", hint: leader("v", keybinds()), run: () => runLeader("v") });
    add({ id: "glass", label: app.glass() ? "Glass off: solid panels" : "Glass on: see the terminal through", hint: leader("g", keybinds()), run: () => runLeader("g") });
    // The shared chat width (config.yml's chat_width), as the web UI's Settings dialog sets it: every device draws it (C-x l cycles).
    CHAT_WIDTHS.forEach((w) => add({ id: `width:${w}`, label: `Chat width: ${chatWidthLabel(w)}`, keywords: "column layout measure", current: (boot?.ui.chatWidth ?? null) === w, run: () => void pickWidth(w) }));
    if (c?.capabilities.supportsCompact) add({ id: "compact", label: "Compact context", hint: leader("c", keybinds()), disabled: idle ? undefined : "Wait until the agent is idle", run: () => runLeader("c") });
    const caps = c?.capabilities ?? app.harness()?.capabilities;
    add({ id: "model", label: "Choose model…", hint: keys.model, disabled: caps?.supportsModelSelection ? undefined : "This harness has no models to pick", run: () => setDialog("models") });
    if (caps?.supportsThinkingLevel) add({ id: "thinking", label: "Choose thinking level…", hint: keys.thinking, run: () => setDialog("thinking") });
    if (c?.capabilities.supportsPermissionMode && c.config.permissionModes?.length) add({ id: "permission", label: "Choose permission mode…", keywords: "approvals ask auto accept edits", run: () => setDialog("permission") });
    if (c) add({ id: "queue", label: "Edit queued messages…", keywords: "steering follow-up pending waiting", run: () => setDialog("queue") });
    add({ id: "refresh-models", label: "Refresh models", keywords: "reload default list", ...(idle ? {} : { disabled: "Wait until the agent is idle" }), run: () => void app.refreshModels() });
    add({ id: "harness", label: hasPrompt() ? "Choose harness, or hand this chat off…" : "Choose harness…", hint: keys.harness, run: () => setDialog("harness") });
    add({ id: "quit", label: "Quit atui", hint: leader("q", keybinds()), searchOnly: true, run: p.onExit });
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
    // Stable by heading, so each group is one run and the heading prints once.
    const place = (section: string) => { const at = PALETTE_ORDER.indexOf(section); return at < 0 ? PALETTE_ORDER.length : at; };
    return items.map((item, at) => ({ item, at })).sort((a, b) => place(a.item.section) - place(b.item.section) || a.at - b.at).map((x) => x.item);
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

  /** Bring one turn into view; its work opens first when the match is in it (a fold hides it). */
  const revealTurn = (index: number, inWork: boolean) => {
    if (inWork) setShowWork(true);
    // A fold that opens moves everything below it: measure after the next frame.
    setTimeout(() => {
      const box = scroller;
      if (!box) return;
      const y = box.content.getChildren().map((child) => (child as { y: number }).y)[index];
      if (y !== undefined) {
        mark();
        glideTo(box, y);
      }
    }, inWork ? 80 : 0);
  };

  /** A snippet without the project's own path: the whole of it where it appears, and the tail of it where the snippet's cut began in the middle of it ("…RXL/ws/alpha/src/a.ts"). */
  const plainPath = (snippet: string, root: string): string => {
    let out = snippet.split(root).join("");
    // A cut that ends on the project's folder, just before the file's own name: the folder says nothing, so it goes and the cut shows.
    const bare = root.replace(/\/$/, "");
    if (out.endsWith(bare + "…")) out = out.slice(0, -bare.length - 1) + "…";
    else if (out.includes(bare + "…")) out = out.replace(bare + "…", "…");
    for (let i = 1; i < root.length - 3; i++) {
      const tail = root.slice(i);
      const at = out.indexOf(tail);
      if (at >= 0 && at <= 1) {
        out = out.slice(at + tail.length);
        break;
      }
    }
    return out;
  };

  /** Find in chat: the turns that mention what is typed, each with a line around the first match; Enter goes to the turn. */
  const findItems = (query: string): PaletteItem[] => {
    const c = app.chat();
    if (!c) return [];
    const turns = buildTurns(c.items, c.status, c.runStartedAt);
    // A row is one line: a short radius keeps the match inside what the picker draws, and the project's own path is dropped as the transcript drops it.
    const root = `${c.workspace.path}/`;
    const hits = findTurns(turns, query, 30, c.workspace.path);
    return hits.map((m) => ({
      id: `find:${m.turnId}`,
      section: "Turns",
      // The match is what a find row is for, so it takes the whole label; the hint names the turn.
      label: plainPath(m.snippet, root),
      hint: `turn ${m.index + 1}${m.inWork ? " · work" : ""}${m.count > 1 ? ` · ${m.count}×` : ""}`,
      run: () => { setLanded({ query, turnId: m.turnId }); revealTurn(m.index, m.inWork); if (hits.length > 1) flash(`match ${hits.indexOf(m) + 1} of ${hits.length} · M-n next · M-p previous`, 8000); },
    }));
  };

  /** The find that last landed (its words and the turn it landed on): M-n and M-p step to the next and previous turn that matches, as a browser's find does, without reopening the sheet. */
  const [landed, setLanded] = createSignal<{ query: string; turnId: string } | null>(null);
  // A find belongs to the chat it was made in: another chat starts without its marks, and M-n / M-p do nothing there until a new find lands.
  createEffect(on(() => app.chat()?.chatId, () => setLanded(null), { defer: true }));
  const stepFind = (by: 1 | -1) => {
    const found = landed();
    const c = app.chat();
    if (!found || !c) return false;
    const hits = findTurns(buildTurns(c.items, c.status, c.runStartedAt), found.query, 30, c.workspace.path);
    if (hits.length === 0) { setLanded(null); return false; }
    const at = hits.findIndex((m) => m.turnId === found.turnId);
    const next = hits[at < 0 ? (by === 1 ? 0 : hits.length - 1) : (at + by + hits.length) % hits.length] as (typeof hits)[number];
    setLanded({ query: found.query, turnId: next.turnId });
    revealTurn(next.index, next.inWork);
    flash(`match ${hits.indexOf(next) + 1} of ${hits.length} · M-n next · M-p previous`, 8000);
    return true;
  };

  /** Search every chat: the server's bounded read of every session (the web's Search chats), one row per chat with its first hit. Results arrive after a short pause; a row opens its chat with the words landed in the first turn that has them. */
  const [chatHits, setChatHits] = createSignal<{ q: string; items: PaletteItem[] }>({ q: "", items: [] });
  let chatSearchSeq = 0;
  let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(chatSearchTimer));
  const chatItems = (query: string): PaletteItem[] => {
    const q = query.trim();
    const have = chatHits();
    if (q.length < 2) return [];
    if (have.q !== q) {
      const mine = ++chatSearchSeq;
      clearTimeout(chatSearchTimer);
      chatSearchTimer = setTimeout(() => {
        void app.server
          .call<ChatSearch>(`/api/sessions/search?q=${encodeURIComponent(q)}`)
          .then((found) => {
            if (mine !== chatSearchSeq) return;
            const names = new Map(found.workspaces.map((w) => [w.id, w.name]));
            setChatHits({
              q,
              items: found.results.map((r) => {
                const hit = r.hits.find((h) => h.kind !== "title") ?? r.hits[0];
                return {
                  id: `chats:${r.session.harnessId}:${r.session.id}`,
                  section: "Chats",
                  label: hit?.snippet ?? (r.session.title || "New chat"),
                  hint: `${clip(r.session.title || "New chat", 22)} · ${names.get(r.session.workspaceId) ?? ""}${r.more > 0 ? ` · +${r.more}` : ""}`,
                  run: () => void app.openSession(r.session).then(() => {
                    // The chat is on screen: the first turn with the words is where the find lands, as it does from Ctrl+S.
                    setTimeout(() => {
                      const c = app.chat();
                      const first = c ? findTurns(buildTurns(c.items, c.status, c.runStartedAt), q, 30, c.workspace.path)[0] : undefined;
                      if (first) { setLanded({ query: q, turnId: first.turnId }); revealTurn(first.index, first.inWork); }
                    }, 150);
                  }),
                };
              }),
            });
          })
          .catch(() => mine === chatSearchSeq && setChatHits({ q, items: [] }));
      }, 220);
      return [];
    }
    return have.items;
  };

  /** The Timing picker's scale: the waterfall's own ticks as fractions of its axis, so the bars read against a time. */
  const timingAxis = (): Array<{ at: number; label: string }> | undefined => {
    const c = app.chat();
    const id = app.timingFor();
    if (!c || id === null) return undefined;
    const turn = buildTurns(c.items, c.status, c.runStartedAt).find((x) => x.prompt?.id === id);
    if (!turn) return undefined;
    const fall = turnWaterfall(turn, c.workspace.path, Date.now());
    return fall.total > 0 ? fall.ticks.map((tick) => ({ at: tick.ms / fall.total, label: tick.label.replace(" ", "") })) : undefined;
  };

  /** The title over Timing's figures: the start and the duration, over the tail "slowest" takes when a step is it. */
  const timingHead = (): string => {
    const c = app.chat();
    const id = app.timingFor();
    const turn = c && id !== null ? buildTurns(c.items, c.status, c.runStartedAt).find((x) => x.prompt?.id === id) : undefined;
    const anySlow = turn && c ? turnWaterfall(turn, c.workspace.path, Date.now()).rows.some((r) => r.slowest) : false;
    return `${"start".padStart(6)}  ${"took".padStart(6)}${anySlow ? " ".repeat(9) : ""}`;
  };

  /** The Timing picker's rows: each model step, call and subagent run of one turn, where it started and how long it took (the web's waterfall, as a list). */
  const timingItems = (): PickerItem[] => {
    const c = app.chat();
    const id = app.timingFor();
    if (!c || id === null) return [];
    const turn = buildTurns(c.items, c.status, c.runStartedAt).find((x) => x.prompt?.id === id);
    if (!turn) return [];
    const fall = turnWaterfall(turn, c.workspace.path, Date.now());
    const unit = (ms: number) => atLabel(ms).replace(" ", "");
    /** "slowest" is a fixed tail on every row when any step is it, so the figures keep one right edge. */
    const anySlow = fall.rows.some((r) => r.slowest);
    const slowTail = (slowest: boolean) => (anySlow ? (slowest ? "  slowest" : " ".repeat(9)) : "");
    /** A time as a figure in one column: the number right-aligned, its unit in a fixed two-cell tail, so 1ms, 164ms and 1.1s line up on the digits. */
    const fig = (ms: number) => {
      const m = /^([\d.]+)(ms|s)$/.exec(unit(ms));
      return m ? `${(m[1] ?? "").padStart(4)}${(m[2] ?? "").padEnd(2)}` : unit(ms).padStart(6);
    };
    const section = fall.total > 0 ? `This turn took ${unit(fall.span)}` : "No times reported";
    const rows = fall.rows.map((row) => ({
      id: `timing:${row.id}`,
      section,
      label: `${"  ".repeat(row.depth)}${row.label}${row.running ? "  running" : ""}${row.extra ? `  ${row.extra}` : ""}`,
      hint: `${fig(row.start)}  ${fig(row.end - row.start)}${slowTail(row.slowest)}`,
      bar: fall.total > 0 ? ([row.start / fall.total, row.end / fall.total] as [number, number]) : undefined,
      run: () => {},
    }));
    // Time before the first step (a request waiting for an answer, a slow start) has no step of its own: name it, so the rows add up to the turn.
    const first = fall.rows.reduce((least, row) => Math.min(least, row.start), Number.POSITIVE_INFINITY);
    if (fall.total > 0 && Number.isFinite(first) && first >= 400) {
      rows.unshift({ id: "timing:before", section, label: "Before the first step", hint: `${fig(0)}  ${fig(first)}${slowTail(false)}`, bar: [0, first / fall.total], run: () => {} });
    }
    // And the time after the last step (the closing reply, the settle), so the rows add up to the turn's total.
    const last = fall.rows.reduce((most, row) => Math.max(most, row.end), 0);
    if (fall.total > 0 && fall.span - last >= 400) {
      rows.push({ id: "timing:after", section, label: "After the last step", hint: `${fig(last)}  ${fig(fall.span - last)}${slowTail(false)}`, bar: [last / fall.total, fall.span / fall.total], run: () => {} });
    }
    return rows;
  };

  /** Usage across every chat, the web dialog's figures as a list: totals, then by harness, model and the chats that used the most. */
  const [usageDays, setUsageDays] = createSignal(7);
  const [usage] = createResource(
    () => (dialog() === "usage" ? usageDays() : undefined),
    (days) => app.usageReport(days).catch(() => null),
  );
  const usageItems = (): PickerItem[] => {
    const r = usage();
    if (!r) return [];
    const head = `Last ${r.days} days`;
    type Figures = Parameters<typeof tokensOf>[0] & { cost: number; unpriced: number; calls: number };
    // One grammar down the sheet: tokens, then cost. Only the first row spells the word out.
    const fig = (t: Figures) => `${shortTokens(tokensOf(t))} · ${dollars(t.cost, t.calls > t.unpriced)}`;
    const words = (t: Figures) => `${shortTokens(tokensOf(t))} tokens · ${dollars(t.cost, t.calls > t.unpriced)}`;
    const share = cacheShare(r.totals);
    const row = (section: string, label: string, hint: string, bar?: [number, number], run?: () => void): PickerItem => ({ id: `usage:${section}:${label}`, section, label, hint, bar, run: run ?? (() => {}), ...(run ? {} : { inert: true }) });
    const tallest = Math.max(1, ...r.byDay.map((d) => tokensOf(d.totals)));
    const dayName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    // A run of days with nothing is one line, not a column of empty tracks.
    const days: PickerItem[] = [];
    const dayTokens = new Map<string, number>();
    const dayCost = new Map<string, number>();
    let idle: string[] = [];
    const flush = () => {
      if (idle.length === 0) return;
      // One short label (a range in the same month shares its month name) with the count as the hint, so a narrow sheet never cuts a date mid-word.
      const from = dayName(idle[0] as string);
      const to = dayName(idle[idle.length - 1] as string);
      const span = idle.length === 1 ? from : from.split(" ")[0] === to.split(" ")[0] ? `${from}–${to.split(" ")[1]}` : `${from}–${to}`;
      days.push(row("By day", `No use ${span}`, idle.length === 1 ? "" : `${idle.length} days`, [0, 0]));
      idle = [];
    };
    for (const d of r.byDay) {
      const total = tokensOf(d.totals);
      if (total === 0) idle.push(d.day);
      else {
        flush();
        const item = row("By day", dayName(d.day), fig(d.totals), [0, total / tallest]);
        dayTokens.set(item.id, total);
        dayCost.set(item.id, d.totals.cost);
        days.push(item);
      }
    }
    flush();
    // Rows are capped, but never silently: the oldest days past the cap fold into one line that says how many and how much, so the head's range is what the rows add up to.
    const MAX_DAY_ROWS = 14;
    if (days.length > MAX_DAY_ROWS) {
      const folded = days.splice(0, days.length - (MAX_DAY_ROWS - 1));
      days.unshift(row("By day", `Earlier days (${folded.length} rows)`, `${shortTokens(folded.reduce((n, f) => n + (dayTokens.get(f.id) ?? 0), 0))} · ${dollars(folded.reduce((n, f) => n + (dayCost.get(f.id) ?? 0), 0), true)}`, [0, 0]));
    }
    return [
      row(head, `${r.totals.sessions} ${r.totals.sessions === 1 ? "chat" : "chats"} · ${r.totals.calls} ${r.totals.calls === 1 ? "call" : "calls"}`, words(r.totals)),
      ...(share === null || share < 0.01 ? [] : [row(head, "Served from the prompt cache", `${Math.round(share * 100)}%`)]),
      ...days,
      // As the web dialog's bars: each harness and model's share of the busiest one, under the name the header and the composer use.
      ...r.byHarness.map((h) => row("By harness", app.boot()?.harnesses.find((x) => x.id === h.harnessId)?.displayName ?? h.harnessId, fig(h.totals), [0, tokensOf(h.totals) / Math.max(1, ...r.byHarness.map((x) => tokensOf(x.totals)))])),
      ...r.byModel.slice(0, 8).map((m) => row("By model", m.model, fig(m.totals), [0, tokensOf(m.totals) / Math.max(1, ...r.byModel.slice(0, 8).map((x) => tokensOf(x.totals)))])),
      // As the web's rows: the chat's harness, project and age beside its figures, and its share of the busiest chat as a bar.
      ...r.top.slice(0, 8).map((x) => {
        const meta = [app.boot()?.harnesses.find((h) => h.id === x.session.harnessId)?.displayName ?? x.session.harnessId, app.overview().workspaces.find((w) => w.id === x.session.workspaceId)?.name ?? "", ago(x.session.updatedAt)].filter(Boolean).join(" · ");
        // The provenance rides with the name, so every figure at the right is short and the tracks run long, whatever the chat.
        return row("Most used chats", `${clip(x.session.title || x.session.id, 22)} · ${meta}`, fig(x.totals), [0, tokensOf(x.totals) / Math.max(1, ...r.top.slice(0, 8).map((y) => tokensOf(y.totals)))], () => void app.openSession(x.session));
      }),
    ];
  };

  /** What waits in the harness's queue, steering first: Enter takes a message back into the composer to edit, and it leaves the queue. */
  const queueItems = (): PaletteItem[] => {
    const q = app.chat()?.queue;
    if (!q) return [];
    const row = (field: "steering" | "followUp", text: string, index: number): PaletteItem => ({
      id: `queue:${field}:${index}`,
      section: field === "steering" ? "Steering: sent at the next step" : "Follow-ups: sent when the run ends",
      label: text.replace(/\s+/g, " "),
      run: () => void app.dropQueued(field, index, true),
    });
    return [...q.steering.map((x, i) => row("steering", x, i)), ...q.followUp.map((x, i) => row("followUp", x, i))];
  };

  /** The harness's permission modes (Claude Code's acceptEdits, Codex's approval policy…), the mode in force checked; one that asks nothing is marked. */
  const permissionItems = (): PaletteItem[] => {
    const c = app.chat();
    if (!c?.capabilities.supportsPermissionMode) return [];
    return (c.config.permissionModes ?? []).map((m) => ({
      id: m.id,
      section: "Permission mode",
      label: m.caution ? `${m.label} ⚠` : m.label,
      hint: m.description,
      current: m.id === c.config.permissionMode,
      run: () => void app.configure({ permissionMode: m.id }),
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
  const sheet = () => reviewing() || app.undoTurn() !== null || running() !== null || delegated() !== null || rail() || board() || gitting() || hubbing() || shell();
  /** What the side panel leaves of the screen for a sheet. */
  const room = () => (sidebar() ? sideWidth() : RAIL_WIDTH);

  return (
    <AtuiContext.Provider value={app}>
      <box flexDirection="column" width="100%" height="100%">
        <box flexDirection="row" flexGrow={1}>
          <Show when={sidebar()} fallback={<SidebarRail asking={app.overview().sessions.filter((s) => s.asking).length} onExpand={() => setSidebar(true)} />}>
            <Sidebar
              active={focus() === "sidebar" && !dialog()}
              width={sideWidth()}
              tab={sideTab()}
              onTab={setSideTab}
              onCollapse={() => {
                setSidebar(false);
                leave();
              }}
              onOpened={() => leave("insert")}
              onLeave={() => leave("keep")}
              onProject={() => setDialog("history")}
              onTerminal={() => setShell(true)}
              vim={keybinds() === "vim"}
            />
          </Show>
          <box flexDirection="column" flexGrow={1}>
            <TabBar width={size().width - room()} />
            <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} border={["bottom"]} borderColor={t().border}>
              <text selectable={false} flexGrow={1} fg={t().text} wrapMode="none" truncate>
                <b>{title()}</b>
              </text>
              <Show when={!ghost() && app.chat()}>
                {(c) => (
                  <text selectable={false} flexShrink={0}>
                    <span style={{ fg: accentOf(t(), app.harness()?.accent) }}>{`${harnessGlyph(c().harnessId)} ${app.harness()?.displayName ?? c().harnessId}`}</span>
                    {"  "}
                    <span style={{ fg: c().pending.length > 0 ? t().warn : c().status === "error" ? t().danger : isBusy(c().status) ? t().accent : t().ok }}>{c().pending.length > 0 ? "▲ " : "● "}</span>
                    <Show when={c().pending.length > 0}>
                      <span style={{ fg: t().warn }}>Waiting for you</span>
                    </Show>
                    <Show when={c().pending.length === 0 && isBusy(c().status)} fallback={c().pending.length > 0 ? null : <span style={{ fg: c().status === "error" ? t().danger : t().muted }}>{STATUS_LABEL[c().status]}</span>}>
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
                        fallback={<Splash column={column()} keybinds={keybinds()} question={`What should ${app.harness()?.displayName ?? "the agent"} do in ${app.workspace()?.name ?? "this project"}?`} subtitle="It runs with its normal tools, as you, in this folder." />}
                      >
                        <Transcript ref={(el) => (scroller = el as ScrollBoxRenderable)} showWork={showWork()} column={column} found={landed} />
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
                        <text fg={t().warn}>{`${gone()} · ${leader("n", keybinds())} for a new chat`}</text>
                      </box>
                    )}
                  </Show>
                  <Toasts />
                  {/* A picker floats over the chat (the transcript stays drawn behind it) rather than taking its place. */}
                  <Show when={dialog() !== null}>
                    <box position="absolute" top={0} left={0} right={0} flexDirection="column" backgroundColor={app.glass() ? undefined : t().bg}>
                <Show when={dialog() === "palette"}>
                  <Picker title="Commands" placeholder="Search commands, sessions, thinking…" items={paletteItems()} onClose={() => setDialog(null)} firstHeading side={room()} />
                </Show>
                <Show when={dialog() === "models"}>
                  <Picker title="Model" placeholder="Search models…" items={modelItems()} onClose={() => setDialog(null)} side={room()} />
                </Show>
                <Show when={dialog() === "harness"}>
                  <Picker title="Harness" placeholder="Search harnesses…" items={harnessItems()} onClose={() => setDialog(null)} firstHeading={hasPrompt()} side={room()} />
                </Show>
                <Show when={dialog() === "find"}>
                  <Picker title="Find in chat" placeholder="Type to find text in this chat…" items={[]} search={findItems} noun={["turn", "turns"]} onClose={() => setDialog(null)} side={room()} />
                </Show>
                <Show when={dialog() === "chats"}>
                  <Picker title="Search every chat" placeholder="Type to search every chat's words…" items={[]} search={chatItems} noun={["chat", "chats"]} onClose={() => setDialog(null)} side={room()} />
                </Show>
                <Show when={dialog() === "permission"}>
                  <Picker title="Permission mode" placeholder="Search modes…" items={permissionItems()} onClose={() => setDialog(null)} side={room()} />
                </Show>
                <Show when={dialog() === "timing"}>
                  <Picker title="Timing" placeholder="Search steps…" items={timingItems()} axis={timingAxis()} axisHead={timingHead()} firstHeading info onClose={() => { setDialog(null); app.setTimingFor(null); }} side={room()} />
                </Show>
                <Show when={dialog() === "usage"}>
                  <Picker softBars title="Usage across chats" tabHint={`Tab ${usageDays() === 7 ? "30" : usageDays() === 30 ? "90" : "7"} days`} placeholder={usage.loading ? "Reading every session…" : "Search usage…"} items={usageItems()} firstHeading onTab={() => setUsageDays((d) => (d === 7 ? 30 : d === 30 ? 90 : 7))} onClose={() => setDialog(null)} side={room()} />
                </Show>
                <Show when={dialog() === "queue"}>
                  <Picker title="Queued messages · x removes" placeholder="Search queued messages…" empty="No queued messages: a steering or follow-up message parks here" items={queueItems()} firstHeading onRowKey={(key, item) => { const m = /^queue:(steering|followUp):(\d+)$/.exec(item?.id ?? ""); if (key !== "x" || !m) return false; void app.dropQueued(m[1] as "steering" | "followUp", Number(m[2]), false); return true; }} onClose={() => setDialog(null)} side={room()} />
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
                <Show when={dialog() === "history"}>
                  <Picker title="History" placeholder="Search sessions, projects, harnesses…" items={historyItems()} onClose={() => setDialog(null)} firstHeading preview={historyPreview} side={room()} />
                </Show>
                    </box>
                  </Show>
                  <Show
                    when={pending()}
                    keyed
                    fallback={
                      <Composer
                        status={{ mode: keybinds() === "vim" ? (normal() ? "normal" : "insert") : null, leader: leaderOn() ? leaderPrefix(keybinds()) : null, note: hint() }}
                        focused={focus() === "composer" && !dialog() && !normal() && app.undoTurn() === null && !reviewing() && !running()}
                        compactChoice={compactChoice()}
                        onCompactChoice={setCompactChoice}
                        onPick={setDialog}
                        onGit={() => { setGitting(true); void app.openGit(); }}
                        onContext={() => setRail(true)}
                        column={column()}
                        keybinds={keybinds()}
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
                <Show when={reviewing()}>
                  <ReviewView onClose={() => setReviewing(false)} />
                </Show>
                <Show when={gitting()}>
                  <GitView onClose={() => setGitting(false)} />
                </Show>
                <Show when={shell()}>
                  <TerminalView onClose={() => setShell(false)} />
                </Show>
                <Show when={hubbing()}>
                  <GitHubView onClose={() => setHubbing(false)} />
                </Show>
                <Show when={delegated()}>
                  {(open) => (
                    <DelegatedView
                      side={room()}
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
                    side={room()}
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
                    side={room()}
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
            state={{ o: thoughts() ? "shown" : "folded", b: sidebar() ? "on" : "off", i: sidebar() && sideTab() === "info" ? "on" : "off", e: showWork() ? "on" : "off", v: keybinds() === "vim" ? "emacs" : "vim", g: app.glass() ? "on" : "off" }}
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
