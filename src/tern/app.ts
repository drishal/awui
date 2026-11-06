// awui's Tern client: atui's state (the same server calls and Solid signals,
// atui/state.ts) drawn as one Tern surface instead of a terminal grid. The
// surface is `inline`, so the chat lives in the pane's scrollback and stays
// there when the client quits: `main` holds the conversation, `dock` the
// composer Tern pins to the bottom, `layer` the menus. One Solid effect turns
// the state into a view and hands it to the SDK, which sends only what
// changed, under Tern's flow control. Keys come from the pty (Tern never
// edits our text); clicks and native edits come as events to the handlers the
// view attached. The keys are atui's: C-k commands, C-x then a letter.
import { appendFileSync } from "node:fs";
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup, untrack } from "solid-js";
import { span, ui, html, type Key, type Node, type Session, type Surface } from "@stencil-hq/tern";
import type { HarnessStatus, InteractionRequest, SavedPrompt, SlashCommand } from "../shared/protocol.js";
import type { ChatState } from "../web/chat-state.js";
import { buildTurns, ago as agoMs } from "../web/turns.js";
import { isBusy } from "../web/session-groups.js";
import { phaseDelay, workingPhase } from "../web/working-phase.js";
import { APP_COMMANDS, isSkill, mergeCommands, skillMenu, skillName, slashMenu } from "../web/commands.js";
import { sentPrompts, recallStep, type Recall } from "../web/prompt-history.js";
import { blanks, matchPrompts, nextBlank, promptGist } from "../web/prompt-blanks.js";
import type { Atui } from "../atui/state.js";
import { accentOf } from "../atui/theme.js";
import { applyMention, ghostCompletion, mentionAt, notifySequence } from "../atui/assist.js";
import { optionsOf } from "../atui/requests.js";
import { applyEdit, draftState, editKey, insert, lineStep, moveTo, setText, undo as undoDraft, type DraftState } from "./draft.js";
import { conversation, firstFailedCall, headNode, PAGE_ID, PAGE_KEY, TURN_WINDOW } from "./view.js";
import { ANSWER_ID, dock, EDITOR_ID, inputReady } from "./dock.js";
import { AT_CARET, filterItems, menuNode, moveSelection, sessionRows, SHEETS, type Menu, type MenuItem, type MenuKind } from "./overlays.js";
import { STYLESHEET, themeSheet } from "./look.js";
import { startExamples, startHeading, startSetup } from "../web/start-screen.js";

export interface TernOptions {
  /** The server, for links into the web UI. */
  url: string;
  version: string;
  /** The server's theme file's scheme, dark or light: its colours are the palette there (else Tern's own look, with the harness's colour). */
  polarity: "dark" | "light" | null;
  /** Write a sequence to the terminal outside TSP (a title, a notification, the clipboard). */
  write: (data: string) => void;
}

/** Two presses this close together are one gesture (Esc Esc stops, C-c C-c quits). */
const DOUBLE_MS = 800;

/** The C-x keys the Tern client has, in atui's table's words. */
const LEADER: Array<{ key: string; label: string }> = [
  { key: "s", label: "Sessions" },
  { key: "n", label: "New chat" },
  { key: "a", label: "New chat in a new tab" },
  { key: "]", label: "Next tab" },
  { key: "[", label: "Previous tab" },
  { key: "w", label: "Close tab" },
  { key: "m", label: "Model" },
  { key: "t", label: "Thinking" },
  { key: "h", label: "Harness or hand off" },
  { key: "c", label: "Compact the context" },
  { key: "z", label: "Put undone files back" },
  { key: "e", label: "Open or fold all work" },
  { key: "f", label: "Show failed calls" },
  { key: "y", label: "Copy the last answer" },
  { key: "q", label: "Quit" },
];

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

export function createTernApp(session: Session, app: Atui, opts: TernOptions) {
  return createRoot((dispose) => {
    const surface: Surface = session.open({ mode: "inline", title: "awui", role: "awui.chat" });

    // ---- local state: what only this pane holds -----------------------------------------
    const [draft, setDraft] = createSignal<DraftState>(draftState());
    const [typeahead, setTypeahead] = createSignal(true);
    const [answer, setAnswer] = createSignal<DraftState>(draftState());
    const [focus, setFocus] = createSignal<"editor" | "answer">("editor");
    const [menu, setMenu] = createSignal<Menu | null>(null);
    const [caretIndex, setCaretIndex] = createSignal(0);
    const [caretDismissed, setCaretDismissed] = createSignal(false);
    const [folds, setFolds] = createSignal<ReadonlyMap<string, boolean>>(new Map());
    const [allWork, setAllWork] = createSignal<boolean | null>(null);
    const [picked, setPicked] = createSignal<string | null>(null);
    const [shown, setShown] = createSignal(TURN_WINDOW);
    const [leader, setLeader] = createSignal(false);
    const [commands, setCommands] = createSignal<SlashCommand[] | null>(null);
    const [saved, setSaved] = createSignal<SavedPrompt[] | null>(null);
    const [files, setFiles] = createSignal<string[]>([]);
    const [notice, setNotice] = createSignal<{ n: number; text: string; tone: "success" | "info" | "error" } | null>(null);
    const [blobTick, setBlobTick] = createSignal(0);
    const [todosOpen, setTodosOpen] = createSignal(true);
    let recall: Recall | null = null;
    let lastEsc = 0;
    let lastCtrlC = 0;
    let noticeN = 0;
    let closed = false;
    let quit: () => void = () => undefined;

    const say = (text: string, tone: "success" | "info" | "error" = "info") => setNotice({ n: ++noticeN, text, tone });

    // AWUI_TERN_LOG=<file> keeps every key and event the client reads, Tern's errors, and any view that failed, one JSON line each.
    const log = process.env.AWUI_TERN_LOG ? (line: unknown) => appendFileSync(process.env.AWUI_TERN_LOG as string, `${JSON.stringify(line)}\n`) : null;

    // Timers' ages, kept per key (see ConversationCx.age); started over for each chat.
    const ages = new Map<string, number>();
    const ageOf = (key: string, at: number | undefined) => {
      if (at === undefined) return undefined;
      let a = ages.get(key);
      if (a === undefined) {
        a = Math.max(0, Date.now() - at);
        ages.set(key, a);
      }
      return a;
    };

    // Prompt images go to Tern once each, as blobs; a frame names them by id.
    const blobs = new Map<string, string | null>();
    const blobFor = (imageId: string, mimeType: string): string | null => {
      void blobTick();
      if (blobs.has(imageId)) return blobs.get(imageId) ?? null;
      blobs.set(imageId, null);
      void app.image(imageId).then((bytes) => {
        if (!bytes || closed) return;
        blobs.set(imageId, session.blob(bytes, mimeType));
        setBlobTick((n) => n + 1);
      });
      return null;
    };

    // What these effects follow, as memos: `on()` runs again whenever its source's signals change, and the chat
    // signal changes with every streamed event, so it must see a value that changes only when the thing does.
    const chatId = createMemo(() => app.chat()?.chatId);
    const requestId = createMemo(() => app.chat()?.pending[0]?.id);
    const mentionQuery = createMemo(() => mentionAt(draft().draft.text)?.query);
    const toastId = createMemo(() => app.toasts().at(-1)?.id);

    // A new chat starts its own folds, window, and timers.
    createEffect(
      on(
        chatId,
        () => {
          ages.clear();
          setFolds(new Map());
          setAllWork(null);
          setPicked(null);
          setShown(TURN_WINDOW);
          setCommands(null);
        },
      ),
    );

    // What the live turn is doing, held steady as the web UI's fold label is (useSteadyPhase): a new phase waits
    // until the last has been up PHASE_HOLD_MS, so a burst of fast calls does not flicker. The clock lives here,
    // not in the view, which is handed the phase shown.
    const wantedPhase = createMemo(() => {
      const c = app.chat();
      const turn = c && isBusy(c.status) ? buildTurns(c.items, c.status).at(-1) : undefined;
      return c && turn?.live ? workingPhase(turn, c.workspace.path) : "";
    });
    const [phase, setPhase] = createSignal("");
    let phaseAt = 0;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    createEffect(
      on(
        wantedPhase,
        (wanted) => {
          clearTimeout(phaseTimer);
          // No phase (the run is over) shows at once and starts the hold afresh, so the next run's first phase is not held back.
          const wait = wanted ? phaseDelay(phaseAt, Date.now()) : 0;
          const show = () => {
            phaseAt = wanted ? Date.now() : 0;
            setPhase(wanted);
          };
          if (wait === 0) show();
          else phaseTimer = setTimeout(show, wait);
        },
      ),
    );
    onCleanup(() => clearTimeout(phaseTimer));

    const harness = (): HarnessStatus | null => app.harness();

    // ---- the look: palette by theme and harness, the sheet once ---------------------------
    surface.stylesheet("awui", STYLESHEET);
    // Tern's appearance (a `theme` event when it switches): a theme file's scheme is used only in its own.
    const [dark, setDark] = createSignal(session.caps.dark);
    createEffect(() => {
      const h = harness();
      surface.stylesheet("awui-theme", themeSheet(app.theme(), accentOf(app.theme(), h?.accent), opts.polarity, dark()));
    });

    // The pane's title follows the chat, as the web UI's tab does.
    createEffect(() => {
      const c = app.chat();
      const asks = (c?.pending.length ?? 0) > 0;
      const title = `${asks ? "◆ " : isBusy(c?.status) ? "● " : ""}${c?.title || "awui"}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
      opts.write(`\x1b]2;${title}\x1b\\`);
    });

    // ---- the composer's menus: / and $ and # at the start, @ at the end -------------------
    const caretKind = createMemo((): MenuKind | null => {
      if (focus() !== "editor" || caretDismissed() || menu()) return null;
      const text = draft().draft.text;
      if (/^\/\S*$/.test(text)) return "slash";
      if (/^\$\S*$/.test(text) && (commands() ?? []).some(isSkill)) return "skill";
      if (/^#\S*$/.test(text) && (saved()?.length ?? 0) > 0) return "prompts";
      if (mentionAt(text) && files().length > 0) return "files";
      return null;
    });
    // The menu's text: a caret move alone keeps the row selected.
    const caretText = createMemo(() => caretKind() && draft().draft.text);
    // Commands and skills are asked for when / or $ is first typed; saved prompts on #.
    createEffect(() => {
      const text = draft().draft.text;
      const c = app.chat();
      if ((text.startsWith("/") || text.startsWith("$")) && untrack(commands) === null) {
        setCommands(mergeCommands([]));
        if (c) {
          app.server
            .call<{ commands: SlashCommand[] }>(`/api/chats/${c.chatId}/commands`)
            .then((r) => setCommands(mergeCommands(r.commands)))
            .catch(() => undefined);
        }
      }
      if (text.startsWith("#") && untrack(saved) === null) {
        setSaved([]);
        app.server
          .call<{ prompts: SavedPrompt[] }>("/api/prompts")
          .then((r) => setSaved(r.prompts))
          .catch(() => undefined);
      }
    });
    let fileTimer: ReturnType<typeof setTimeout> | undefined;
    createEffect(
      on(
        mentionQuery,
        (q) => {
          clearTimeout(fileTimer);
          if (q === undefined) return setFiles([]);
          fileTimer = setTimeout(() => void app.searchFiles(q).then((list) => mentionAt(draft().draft.text)?.query === q && setFiles(list.slice(0, 12))), 80);
        },
      ),
    );
    createEffect(
      on(
        caretText,
        () => setCaretIndex(0),
      ),
    );
    // A menu dismissed with Esc comes back once its trigger is typed again.
    createEffect(on(caretKind, (k) => k === null && setCaretDismissed(false)));

    const caretItems = createMemo((): MenuItem[] => {
      const k = caretKind();
      const text = draft().draft.text;
      const query = text.slice(1);
      const command = (c: SlashCommand, name: string): MenuItem => ({ id: name, label: name, ...(c.description ? { detail: c.description } : {}), ...(c.hint ? { value: c.hint } : {}) });
      if (k === "slash") return slashMenu(commands() ?? APP_COMMANDS, query).slice(0, 30).map((c) => command(c, `/${c.name}`));
      if (k === "skill") return skillMenu(commands() ?? [], query).slice(0, 30).map((c) => command(c, `$${skillName(c)}`));
      if (k === "prompts") return matchPrompts(saved() ?? [], query).slice(0, 30).map((p) => ({ id: p.name, label: `#${p.name}`, detail: promptGist(p) }));
      if (k === "files") return files().map((f) => ({ id: f, label: f, icon: "file" }));
      return [];
    });

    const ghost = () => {
      if (caretKind() !== "slash") return "";
      const best = caretItems()[caretIndex()];
      const c = best ? (commands() ?? APP_COMMANDS).find((x) => `/${x.name}` === best.id) : undefined;
      return ghostCompletion(draft().draft.text, c);
    };

    /** Put a saved prompt in the draft, its first blank selected to type over. */
    const putPrompt = (text: string) => {
      const first = blanks(text)[0];
      setDraft((s) => (first ? setText(s, text, first.end, first.start) : setText(s, text)));
    };

    const completeCaret = (item: MenuItem) => {
      const k = caretKind();
      const text = draft().draft.text;
      if (k === "prompts") {
        const p = (saved() ?? []).find((x) => x.name === item.id);
        if (p) putPrompt(p.text);
      } else if (k === "files") setDraft((s) => setText(s, applyMention(text, item.id)));
      else if (k === "skill") {
        const c = (commands() ?? []).find((x) => isSkill(x) && `$${skillName(x)}` === item.id);
        if (c) setDraft((s) => setText(s, `/${c.name} `));
      } else setDraft((s) => setText(s, `${item.id} `));
    };

    // ---- the explicit menus' rows --------------------------------------------------------
    const sessionItems = (): MenuItem[] =>
      sessionRows(app.overview(), { here: app.workspace()?.id ?? null, current: app.chat()?.sessionId ?? null, harnessName: (id) => app.boot()?.harnesses.find((h) => h.id === id)?.displayName ?? id });

    const modelItems = (): MenuItem[] => {
      const config = app.chat()?.config;
      if (!config) return [];
      return config.models.map((m) => ({ id: m.key, label: m.name, detail: m.id, group: m.provider, current: m.key === config.model || m.id === config.model, icon: "model" }));
    };

    const thinkingItems = (): MenuItem[] => {
      const config = app.chat()?.config;
      if (!config) return [];
      return config.thinkingLevels.map((l) => ({ id: l, label: l, current: l === config.thinkingLevel }));
    };

    const permissionItems = (): MenuItem[] => {
      const config = app.chat()?.config;
      if (!config?.permissionModes) return [];
      return config.permissionModes.map((m) => ({ id: m.id, label: m.label, detail: m.description, current: m.id === config.permissionMode, ...(m.caution ? { dot: "warning" } : {}) }));
    };

    const harnessItems = (): MenuItem[] =>
      (app.boot()?.harnesses ?? []).map((h) => ({
        id: h.id,
        label: h.displayName,
        detail: app.chat() && h.id !== harness()?.id ? "hand this chat off" : (h.version ?? ""),
        current: h.id === harness()?.id,
        ...(h.available ? {} : { disabled: h.reason ?? "Not available" }),
      }));

    const leaderItems = (): MenuItem[] => LEADER.map((k) => ({ id: k.key, label: k.label, value: `C-x ${k.key}` }));

    const paletteItems = (): MenuItem[] => {
      const c = app.chat();
      const idle = c ? !isBusy(c.status) : true;
      const items: MenuItem[] = [
        { id: "x:s", label: "Browse sessions", value: "C-x s", icon: "session" },
        { id: "x:n", label: "New chat", value: "C-x n", icon: "plus" },
        { id: "x:a", label: "New chat in a new tab", value: "C-x a", icon: "tabs-h" },
      ];
      if (app.tabs().tabs.length > 1) items.push({ id: "x:]", label: "Next tab", value: "C-x ]" }, { id: "x:[", label: "Previous tab", value: "C-x [" });
      if (app.tabs().tabs.length > 0) items.push({ id: "x:w", label: "Close this tab", value: "C-x w" });
      const caps = c?.capabilities ?? harness()?.capabilities;
      if (caps?.supportsModelSelection) items.push({ id: "x:m", label: "Change the model…", value: "C-x m", icon: "model" });
      if (caps?.supportsThinkingLevel) items.push({ id: "x:t", label: "Change the thinking level…", value: "C-x t", icon: "thinking" });
      if (c?.capabilities.supportsPermissionMode && c.config.permissionModes?.length) items.push({ id: "permission", label: "Change the permission mode…", icon: "shield" });
      items.push({ id: "x:h", label: c ? "Hand off to another harness…" : "Choose the harness…", value: "C-x h", icon: "handoff" });
      if (c?.capabilities.supportsCompact) items.push({ id: "x:c", label: "Compact the context", value: "C-x c", icon: "compaction", ...(idle ? {} : { disabled: "Wait until the agent is idle" }) });
      if (c && isBusy(c.status)) items.push({ id: "stop", label: "Stop the agent", value: "Esc Esc", icon: "stop" });
      items.push({ id: "x:e", label: allWork() ? "Fold all work" : "Open all work", value: "C-x e", icon: "expand" });
      if (c) items.push({ id: "x:f", label: "Show failed calls", value: "C-x f", icon: "x-circle", ...(c.items.some((i) => i.kind === "tool" && i.status === "error") ? {} : { disabled: "No call has failed in this chat" }) });
      if (c) items.push({ id: "x:y", label: "Copy the last answer", value: "C-x y", icon: "copy" });
      if (app.putBackable()) items.push({ id: "x:z", label: "Put the undone files back", value: "C-x z", icon: "undo" });
      if (c) items.push({ id: "web", label: "Copy this chat's link in the web UI", icon: "globe", keywords: "browser open" });
      items.push({ id: "x:q", label: "Quit (the chat keeps running on the server)", value: "C-x q", icon: "log-out" });
      return items;
    };

    const menuItems = createMemo((): MenuItem[] => {
      const m = menu();
      if (!m) return caretItems();
      const rows: Partial<Record<MenuKind, () => MenuItem[]>> = { palette: paletteItems, sessions: sessionItems, model: modelItems, thinking: thinkingItems, permission: permissionItems, harness: harnessItems, leader: leaderItems };
      const all = rows[m.kind]?.() ?? [];
      return SHEETS.has(m.kind) ? filterItems(all, m.query) : all;
    });

    const openMenu = (kind: MenuKind) => {
      setLeader(false);
      // The model and thinking pickers read the chat's config: a new chat is started on the server first.
      if ((kind === "model" || kind === "thinking") && !app.chat()) {
        void app.ensureChat().then((c) => c && openMenu(kind));
        return;
      }
      const items = kind === "model" ? modelItems() : kind === "thinking" ? thinkingItems() : kind === "permission" ? permissionItems() : kind === "harness" ? harnessItems() : [];
      const current = Math.max(0, items.findIndex((i) => i.current));
      setMenu({ kind, query: "", selected: current });
    };

    // ---- actions ---------------------------------------------------------------------------
    const copy = (text: string) => {
      opts.write(`\x1b]52;c;${base64(text)}\x1b\\`);
      say("Copied", "success");
    };

    const lastAnswer = (): string | null => {
      const c = app.chat();
      if (!c) return null;
      const turns = buildTurns(c.items, c.status);
      for (let i = turns.length - 1; i >= 0; i--) {
        const text = turns[i]?.answer?.text;
        if (text?.trim()) return text;
      }
      return null;
    };

    const toggleAllWork = () => {
      const next = !allWork();
      setAllWork(next);
      const c = app.chat();
      if (!c) return;
      const map = new Map<string, boolean>();
      for (const turn of buildTurns(c.items, c.status)) {
        for (let i = 0; i < 16; i++) map.set(`${turn.id}#${i}`, next);
        map.set(`${turn.id}#after`, next);
      }
      setFolds(map);
    };

    /** Opens the fold holding the first failed call of the latest turn that has one, and brings its row into view. */
    const showFailed = () => {
      const c = app.chat();
      const turns = c ? buildTurns(c.items, c.status) : [];
      const hit = firstFailedCall(turns, PAGE_ID);
      if (!hit) return say("No call has failed in this chat");
      // The fold and the turn's place in the window are drawn first: the op follows the frame that holds them, in order.
      setShown((n) => Math.max(n, turns.length - hit.turn));
      setFolds((m) => new Map(m).set(hit.fold, true));
      surface.reveal(hit.row, "start");
    };

    const runLeader = (key: string) => {
      setLeader(false);
      setMenu(null);
      const c = app.chat();
      switch (key) {
        case "s":
          void app.refreshSessions();
          return openMenu("sessions");
        case "n":
          return app.newChat();
        case "a":
          return app.newChat({ newTab: true });
        case "]":
          return app.stepTab(1);
        case "[":
          return app.stepTab(-1);
        case "w":
          return app.closeTab(app.tabs().active);
        case "m":
          return (c?.capabilities ?? harness()?.capabilities)?.supportsModelSelection ? openMenu("model") : say("This harness has no model choice here");
        case "t":
          return (c?.capabilities ?? harness()?.capabilities)?.supportsThinkingLevel ? openMenu("thinking") : say("This harness has no thinking levels here");
        case "h":
          return openMenu("harness");
        case "c":
          return void app.compact();
        case "z":
          return void app.putBack();
        case "e":
          return toggleAllWork();
        case "f":
          return showFailed();
        case "y": {
          const text = lastAnswer();
          return text ? copy(text) : say("No answer to copy yet");
        }
        case "q":
          return quit();
        default:
          return say(`C-x ${key} is not a key here (C-x lists them)`);
      }
    };

    const pick = (item: MenuItem) => {
      const m = menu();
      if (item.disabled) return say(item.disabled);
      if (!m) {
        completeCaret(item);
        return;
      }
      setMenu(null);
      switch (m.kind) {
        case "palette":
          if (item.id.startsWith("x:")) return runLeader(item.id.slice(2));
          if (item.id === "stop") return app.stop();
          if (item.id === "permission") return openMenu("permission");
          if (item.id === "web") {
            // A program cannot open a browser through Tern (links open on a click), so the link goes to the clipboard.
            const c = app.chat();
            if (c) {
              opts.write(`\x1b]52;c;${base64(`${opts.url}/#chat=${c.chatId}`)}\x1b\\`);
              say(`Copied the link: ${opts.url}/#chat=${c.chatId}`, "success");
            }
            return;
          }
          return;
        case "sessions": {
          const s = app.overview().sessions.find((x) => x.id === item.id);
          if (s) void app.openSession(s);
          return;
        }
        case "model":
          return void app.configure({ model: item.id });
        case "thinking":
          return void app.configure({ thinkingLevel: item.id });
        case "permission":
          return void app.configure({ permissionMode: item.id });
        case "harness":
          if (item.id === harness()?.id) return;
          return app.chat() ? void app.handoff(item.id) : app.chooseHarness(item.id);
        case "leader":
          return runLeader(item.id);
        default:
          return;
      }
    };

    const sendDraft = async (text = draft().draft.text) => {
      const c = app.chat();
      const editing = app.editing();
      if (editing && c) {
        if (!text.trim()) return;
        setDraft(draftState());
        app.setEditing(null);
        const ok = await app.rerun(editing.through, editing.item, text.trim());
        if (!ok) setDraft(draftState({ text, cursor: text.length, anchor: null }));
        return;
      }
      if (!text.trim()) return;
      setDraft(draftState());
      recall = null;
      const ok = await app.send(text);
      if (!ok) setDraft(draftState({ text, cursor: text.length, anchor: null }));
    };

    const answerRequest = (r: InteractionRequest, index: number) => {
      const o = optionsOf(r)[index];
      if (o) void app.answer(r.id, o.answer);
    };
    const submitText = (r: InteractionRequest) => {
      const value = answer().draft.text;
      setAnswer(draftState());
      setFocus("editor");
      void app.answer(r.id, r.kind === "editor" ? { kind: "editor", value } : { kind: "input", value });
    };
    const cancelRequest = (r: InteractionRequest) => {
      setAnswer(draftState());
      setFocus("editor");
      const opts = optionsOf(r);
      // An approval's Esc is its Deny; a question's is a skip.
      const deny = opts.length === 2 && opts[1]?.label === "Deny" ? opts[1].answer : null;
      void app.answer(r.id, deny ?? { kind: "cancel" });
    };

    const setChain = (steps: unknown[], resume = false) => {
      const c = app.chat();
      if (!c) return;
      app.server.call(`/api/chats/${c.chatId}/chain`, { method: "PUT", body: { steps, ...(resume ? { resume: true } : {}) } }).catch((e: unknown) => say(e instanceof Error ? e.message : String(e), "error"));
    };

    // A question that wants text takes the keys while it is shown.
    createEffect(
      on(
        requestId,
        () => {
          const r = app.chat()?.pending[0];
          const wantsText = r && (r.kind === "input" || r.kind === "editor");
          setAnswer(draftState(wantsText && r.prefill ? { text: r.prefill, cursor: r.prefill.length, anchor: null } : undefined));
          setFocus(wantsText ? "answer" : "editor");
        },
      ),
    );

    // An edit started from a prompt puts its text in the composer.
    createEffect(
      on(
        () => app.editing(),
        (e) => {
          if (e) setDraft((s) => setText(s, e.item.text));
        },
      ),
    );

    // The server's toasts (a background session finished or asks) as Tern's own toast.
    createEffect(
      on(
        toastId,
        () => {
          const t = app.toasts().at(-1);
          if (t) {
            setNotice({ n: ++noticeN, text: `${t.kind === "asking" ? "Needs you" : t.kind === "failed" ? "Failed" : "Done"}: ${t.title}`, tone: t.kind === "failed" ? "error" : "info" });
          }
        },
      ),
    );

    // ---- the view ---------------------------------------------------------------------------
    /**
     * The shown chat with the fields a server older than this client may not send (the chain,
     * checkpoints, todos) filled in empty, so a client newer than its server draws what there is.
     */
    const shownChat = createMemo((): ChatState | null => {
      const c = app.chat();
      if (!c) return null;
      return {
        ...c,
        queue: c.queue ?? { steering: [], followUp: [] },
        pending: c.pending ?? [],
        todos: c.todos ?? [],
        checkpoints: c.checkpoints ?? [],
        chain: c.chain ?? [],
        chainPaused: c.chainPaused ?? null,
      };
    });

    const view = () => {
      const c = shownChat();
      const h = harness();
      const tabs = app.tabs();
      const main: (Node | null)[] = [];
      if (tabs.tabs.length > 1) {
        main.push(
          ui.tabs({
            key: "tabs",
            role: "awui.tabs",
            active: tabs.tabs[tabs.active]?.key ?? "",
            items: tabs.tabs.map((t) => ({ id: t.key, label: t.unread ? [span(t.title || "New chat"), span(" ●", "accent")] : t.title || "New chat" })),
            onSelect: (e) => void app.switchTab(tabs.tabs.findIndex((t) => t.key === e.item)),
          }),
        );
      }
      const opening = app.opening();
      if (opening) {
        main.push(headNode(null, app.boot()?.harnesses.find((x) => x.id === opening.harnessId) ?? null, opening.title, false));
        main.push(ui.row({ key: "opening", gap: "sm", align: "center" }, ui.spinner({ key: "s" }), ui.shimmer({ key: "t", text: `Opening ${opening.title}…` })));
      } else if (c) {
        main.push(headNode(c, h, c.workspace.name, c.pending.length > 0));
        main.push(
          ...conversation({
            chat: c,
            harness: h,
            webUrl: opts.url,
            now: Date.now(),
            phase: phase(),
            age: ageOf,
            supports: (kind) => session.caps.kinds.includes(kind),
            shown: shown(),
            folds: folds(),
            picked: picked(),
            blob: blobFor,
            on: {
              fold: (key, open) => setFolds((m) => new Map(m).set(key, open)),
              pick: setPicked,
              showEarlier: () => setShown((n) => n + TURN_WINDOW),
              retry: (turn) => {
                if (turn.prompt) void app.rerun(turn.through, turn.prompt, turn.prompt.text);
                setPicked(null);
              },
              edit: (turn) => {
                if (turn.prompt) app.setEditing({ through: turn.through, item: turn.prompt });
                setPicked(null);
                setFocus("editor");
              },
              fork: (through) => {
                setPicked(null);
                void app.fork(through);
              },
              undo: (turn) => {
                setPicked(null);
                void app.checkpointPreview(turn.through).then((p) => {
                  if (!p) return;
                  if (p.files.length === 0) return say("Nothing to put back: the files are as they were");
                  void app.restoreFiles(turn.through, p.files.map((f) => f.path));
                });
              },
              copy,
            },
          }),
        );
      } else main.push(welcome());

      const banner = app.banner();
      const dockNode = dock({
        chat: c,
        harness: h,
        git: app.git(),
        limits: app.limits(),
        connected: app.conn() !== "reconnecting",
        version: opts.version,
        typeahead: typeahead(),
        project: app.workspace()?.path.replace(process.env.HOME ?? "\u0000", "~") ?? null,
        draft: draft().draft,
        ghost: ghost(),
        editing: app.editing()?.through ?? null,
        answer: answer().draft,
        leader: leader(),
        todosOpen: todosOpen(),
        on: {
          toggleTodos: setTodosOpen,
          send: () => void sendDraft(),
          stop: app.stop,
          answer: answerRequest,
          submitText,
          cancel: cancelRequest,
          pickHarness: () => openMenu("harness"),
          pickModel: () => openMenu("model"),
          pickThinking: () => openMenu("thinking"),
          pickPermission: () => openMenu("permission"),
          sessions: () => openMenu("sessions"),
          palette: () => openMenu("palette"),
          dropStep: (i) => setChain((c?.chain ?? []).filter((_, j) => j !== i).map(({ id: _id, ...rest }) => rest)),
          resumeChain: () => setChain((c?.chain ?? []).map(({ id: _id, ...rest }) => rest), true),
          focusEditor: () => setFocus("editor"),
          focusAnswer: () => setFocus("answer"),
          editDraft: (e) => setDraft((s) => applyEdit(s, e)),
          editAnswer: (e) => setAnswer((s) => applyEdit(s, e)),
          undoDraft: () => setDraft(undoDraft),
          sendText: (text) => void sendDraft(text),
        },
      });

      const layer: (Node | null)[] = [];
      const m = menu();
      const kind = m?.kind ?? caretKind();
      if (kind) {
        const items = menuItems();
        const shownMenu: Menu = m ?? { kind, query: "", selected: caretIndex() };
        layer.push(
          menuNode({
            menu: { ...shownMenu, selected: Math.min(shownMenu.selected, Math.max(0, items.length - 1)) },
            items,
            on: {
              pick,
              select: (i) => (m ? setMenu({ ...m, selected: i }) : setCaretIndex(i)),
              close: () => (m ? setMenu(null) : setCaretDismissed(true)),
            },
          }),
        );
      } else if (leader()) {
        layer.push(
          ui.overlay(
            { key: "leader", anchor: "bottom", size: "lg", head: "C-x" },
            ui.row(
              { key: "keys", gap: "lg", wrap: true },
              LEADER.map((k) =>
                ui.row(
                  {
                    key: `k${k.key}`,
                    gap: "xs",
                    align: "center",
                    onClick: () => {
                      runLeader(k.key);
                    },
                  },
                  ui.kbd({ key: "k", keys: [k.key] }),
                  ui.text({ key: "t" }, span(k.label, "muted")),
                ),
              ),
            ),
          ),
        );
      }
      const n = notice();
      if (n) layer.push(ui.toast({ key: `n${n.n}`, text: n.text, tone: n.tone === "error" ? "error" : n.tone === "success" ? "success" : "info" }));
      if (banner) layer.push(ui.toast({ key: `b${banner.text}`, text: banner.text, tone: banner.level === "error" ? "error" : "info" }));

      return {
        main: ui.col(ui.col({ key: PAGE_KEY, role: "awui.page" }, main)),
        dock: ui.col(dockNode),
        layer: ui.col(layer),
      };
    };

    /**
     * The empty chat: the web UI's start screen (its question, three things to try that fill the box), the
     * harness picked from the composer's chip; and, with no sidebar here, this project's recent sessions under it.
     */
    const welcome = (): Node => {
      const h = harness();
      const here = app.workspace();
      const recent = app.overview().sessions.filter((s) => s.workspaceId === here?.id && (!h || s.harnessId === h.id)).slice(0, 6);
      const heading = startHeading(startSetup(app.boot()?.harnesses ?? [], h?.id ?? null, here?.name ?? null, "", 0, false));
      const sub = h?.id === "awui" ? "It reads, searches, and computes — it never edits your files." : here ? "It runs with its normal tools, as you, in this folder." : "Start awui tern in a project folder to work there.";
      return ui.col(
        { key: "welcome", role: "awui.welcome" },
        ui.text({ key: "mark", role: "awui.brand", text: ">_" }),
        ui.text(
          { key: "ask", role: "awui.start-title" },
          heading.project ? [span(heading.before), span(heading.project, "accent"), span(heading.after)] : [span(heading.title)],
        ),
        ui.text({ key: "sub" }, span(sub, "muted")),
        ui.row(
          { key: "try", role: "awui.harnesses" },
          startExamples(h?.id ?? null).map((text, i) => html.button({ key: `x${i}`, class: "pick", text, title: "Put this in the box", onClick: () => void setDraft((s) => setText(s, text)) })),
        ),
        recent.length > 0
          ? ui.list(
              {
                key: "recent",
                role: "awui.recent",
                onActivate: (e) => {
                  const s = recent[Number(/\.s(\d+)$/.exec(e.item)?.[1] ?? -1)];
                  if (s) void app.openSession(s);
                },
                onSelect: (e) => {
                  const s = recent[Number(/\.s(\d+)$/.exec(e.item)?.[1] ?? -1)];
                  if (s) void app.openSession(s);
                },
              },
              recent.map((s, i) => ui.item({ key: `s${i}`, label: s.title || "Untitled", detail: app.boot()?.harnesses.find((x) => x.id === s.harnessId)?.displayName ?? s.harnessId, value: s.updatedAt ? agoMs(new Date(s.updatedAt).getTime()) : "", icon: "session" })),
            )
          : null,
        ui.text({ key: "keys" }, span("Enter sends · C-k commands · C-x s sessions · C-x q quits", "dim")),
      );
    };

    // The caret goes where the keys go, once the field it names is drawn (the same frame, after the view).
    let focused: string | null = null;
    createEffect(() => {
      if (closed) return;
      try {
        surface.render(view());
        // Tern holds what is typed until the client can take input for a real screen: connected, with the chat or
        // the start screen (and its data) what is drawn. That is cleared once, here, after the frame that shows it.
        if (untrack(typeahead) && inputReady({ chat: app.chat(), conn: app.conn(), booted: app.boot() !== null, opening: app.opening() !== null })) setTypeahead(false);
      } catch (error) {
        // A view that cannot be drawn says why, in place of the chat, and the keys still work (C-c C-c quits);
        // one failure must not take the pane and its terminal modes down with it.
        const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
        log?.({ t: Date.now(), renderError: text });
        surface.render({
          main: ui.col(ui.card({ key: "broken", tone: "error", head: [span("awui tern could not draw this chat", "error")] }, ui.code({ key: "e", text }))),
          dock: ui.col(ui.text({ key: "keys" }, span("C-c C-c quits · C-x s opens another session", "muted"))),
        });
      }
      const want = focus() === "answer" && app.chat()?.pending[0] ? ANSWER_ID : EDITOR_ID;
      if (want !== focused) {
        focused = want;
        surface.focus(want);
      }
    });

    // ---- keys ------------------------------------------------------------------------------
    const editText = (fn: (s: DraftState) => DraftState) => (focus() === "answer" ? setAnswer(fn) : setDraft(fn));

    const onMenuKey = (key: Key, m: Menu): boolean => {
      const items = menuItems();
      const { name, ctrl } = key;
      if (name === "escape" || (ctrl && name === "g")) return setMenu(null), true;
      if (name === "up" || (ctrl && name === "p")) return setMenu(moveSelection(m, items.length, -1)), true;
      if (name === "down" || (ctrl && name === "n") || (name === "tab" && !key.shift)) return setMenu(moveSelection(m, items.length, 1)), true;
      if (name === "tab" && key.shift) return setMenu(moveSelection(m, items.length, -1)), true;
      if (name === "page_down") return setMenu(moveSelection(m, items.length, 8)), true;
      if (name === "page_up") return setMenu(moveSelection(m, items.length, -8)), true;
      if (name === "enter") {
        const item = items[Math.min(m.selected, items.length - 1)];
        if (item) pick(item);
        return true;
      }
      if (m.kind === "leader" && !ctrl && key.text) return runLeader(key.text), true;
      if (!SHEETS.has(m.kind)) return true;
      if (name === "backspace") return setMenu({ ...m, query: m.query.slice(0, -1), selected: 0 }), true;
      if (ctrl && name === "u") return setMenu({ ...m, query: "", selected: 0 }), true;
      if (key.text && !ctrl && !key.alt && !key.meta) return setMenu({ ...m, query: m.query + key.text, selected: 0 }), true;
      if (name === "space") return setMenu({ ...m, query: `${m.query} `, selected: 0 }), true;
      return true;
    };

    const onCaretMenuKey = (key: Key): boolean => {
      const items = caretItems();
      if (items.length === 0) return false;
      const { name } = key;
      if (name === "escape") return setCaretDismissed(true), true;
      if (name === "up" || (key.ctrl && name === "p")) return setCaretIndex((i) => (i - 1 + items.length) % items.length), true;
      if (name === "down" || (key.ctrl && name === "n")) return setCaretIndex((i) => (i + 1) % items.length), true;
      const item = items[Math.min(caretIndex(), items.length - 1)];
      if (!item) return false;
      if (name === "tab" && !key.shift) return completeCaret(item), true;
      if (name === "enter" && !key.shift) {
        // A command typed in full that takes nothing runs on Enter; otherwise Enter completes it.
        const typed = draft().draft.text.trim();
        if (caretKind() === "slash" && item.id === typed && !item.value) return false;
        return completeCaret(item), true;
      }
      return false;
    };

    const onRequestKey = (key: Key, r: InteractionRequest): boolean => {
      const textual = r.kind === "input" || r.kind === "editor";
      if (textual && focus() === "answer") {
        if (key.name === "enter" && !key.shift && r.kind === "input") return submitText(r), true;
        if (key.name === "enter" && (key.ctrl || key.meta)) return submitText(r), true;
        if (key.name === "escape") return cancelRequest(r), true;
        if (key.name === "tab") return setFocus("editor"), true;
        return false;
      }
      // With an empty composer, digits answer and Esc skips (or denies).
      if (draft().draft.text !== "") return false;
      const n = Number(key.text);
      if (!key.ctrl && !key.alt && Number.isInteger(n) && n >= 1 && n <= 9 && optionsOf(r)[n - 1]) return answerRequest(r, n - 1), true;
      if (key.name === "escape") return cancelRequest(r), true;
      if (textual && key.name === "tab") return setFocus("answer"), true;
      return false;
    };

    const onKey = (raw: Key) => {
      // Tern takes Ctrl and ⌘ as one primary modifier and may report either; a ⌘ chord that reaches us is one
      // Tern left alone, so it reads as the Ctrl chord (C-k, C-x, the Emacs keys).
      const key: Key = raw.meta && !raw.ctrl ? { ...raw, ctrl: true, meta: false } : raw;
      const { name, ctrl, alt, shift, meta } = key;
      const now = Date.now();

      if (ctrl && name === "c") {
        if (menu()) return setMenu(null);
        if (draft().draft.text) return setDraft((s) => setText(s, ""));
        if (now - lastCtrlC < DOUBLE_MS * 2) return quit();
        lastCtrlC = now;
        return say("C-c again quits (the chat keeps running on the server)");
      }
      if (leader()) {
        if (name === "escape" || (ctrl && name === "g")) return setLeader(false);
        return runLeader(key.text ?? name);
      }
      const m = menu();
      if (m) return void onMenuKey(key, m);
      if (ctrl && name === "k") return openMenu("palette");
      if (ctrl && name === "x") return setLeader(true);
      if (ctrl && name === "r") return void app.refreshSessions(), openMenu("sessions");
      if (alt && !ctrl && /^[1-9]$/.test(name)) return void app.switchTab(Number(name) - 1);

      const r = app.chat()?.pending[0];
      if (r && onRequestKey(key, r)) return;
      if (focus() === "answer") {
        const next = editKey(answer(), key);
        if (next) setAnswer(next);
        return;
      }
      if (caretKind() && onCaretMenuKey(key)) return;

      if (name === "escape") {
        if (app.editing()) {
          app.setEditing(null);
          return setDraft(draftState());
        }
        if (picked()) return setPicked(null);
        if (isBusy(app.chat()?.status)) {
          if (now - lastEsc < DOUBLE_MS) {
            lastEsc = 0;
            return app.stop();
          }
          lastEsc = now;
          return say("Esc again stops the agent");
        }
        return;
      }
      if (name === "enter" && !shift && !alt && !ctrl && !meta) return void sendDraft();
      if (name === "enter" || (ctrl && name === "j")) return setDraft((s) => ({ ...s, draft: insert(s.draft, "\n"), last: "other", undo: [...s.undo, s.draft] }));
      if (ctrl && name === "d" && draft().draft.text === "") return quit();

      if ((name === "up" || name === "down") && !ctrl && !alt && !shift) {
        const d = draft().draft;
        const line = lineStep(d, name === "up" ? -1 : 1);
        if (line !== null) return setDraft((s) => ({ ...s, draft: moveTo(s.draft, line) }));
        const prompts = sentPrompts(app.chat()?.items ?? []);
        const step = recallStep(prompts, recall, name === "up" ? "up" : "down", d.text, d.cursor);
        if (step) {
          recall = step.recall;
          return setDraft((s) => setText(s, step.text));
        }
        return;
      }
      if (name === "tab") {
        const d = draft().draft;
        const blank = nextBlank(d.text, shift ? d.cursor : Math.max(d.cursor, d.anchor ?? 0), shift);
        if (blank) return setDraft((s) => ({ ...s, draft: { text: d.text, cursor: blank.end, anchor: blank.start } }));
        return;
      }
      const next = editKey(draft(), key);
      if (next) {
        // Typing into a recalled prompt makes it a draft: the walk ends there.
        recall = null;
        editText(() => next);
      }
    };


    /** Read keys and events until the client quits; resolves then. */
    const run = async (): Promise<void> => {
      const done = new Promise<void>((resolve) => {
        quit = () => {
          closed = true;
          resolve();
        };
      });
      const loop = (async () => {
        for await (const input of session) {
          if (closed) break;
          try {
            log?.({ t: Date.now(), ...input });
            // Events reach the handlers the view attached before this loop sees them; the rest need nothing.
            if (input.type === "key") onKey(input.key);
            else if (input.event.ev === "theme") setDark(input.event.dark);
          } catch (error) {
            say(error instanceof Error ? error.message : String(error), "error");
          }
        }
        closed = true;
      })();
      await Promise.race([done, loop]);
      dispose();
    };

    return { run, surface };
  });
}

/** A notification through the terminal, for a background session's news (Tern files it in its inbox). */
export const notify = (write: (s: string) => void) => (title: string, body: string) => write(notifySequence(process.env, title, body));
