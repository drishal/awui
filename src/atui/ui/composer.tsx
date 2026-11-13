// The composer (OpenCode's prompt box, with the web UI's chips): Enter sends,
// Shift+Enter or Ctrl+J adds a line; while the agent works Enter steers. A
// "/" opens the command menu, with the best match's rest shown dim after the
// cursor; an "@" opens the project's files. C-v attaches an image from
// the clipboard, and image files dropped on the terminal (pasted as their
// paths) attach too: numbered thumbnails above the box, Backspace in an
// empty box takes the last one off. The line under it names the
// harness, model and thinking level, the context used (with its recent
// history as a sparkline, green to amber to red as it fills, and a sweep while
// it compacts), whether the next message compacts first, and while the agent
// writes, how fast (tokens a second, with their own sparkline).
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show } from "solid-js";
import { createHostClipboard, decodePasteBytes, type HostClipboardService, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/solid";
import { IMAGE_MIME_TYPES, MAX_IMAGES, type SavedPrompt, type SlashCommand } from "../../shared/protocol.js";
import { APP_COMMANDS, isSkill, mergeCommands, skillMenu, skillName, slashMenu } from "../../web/commands.js";
import { blanks, matchPrompts, nextBlank, promptGist } from "../../web/prompt-blanks.js";
import { levelTitle } from "../../web/config-summary.js";
import { applyMention, ghostCompletion, mentionAt } from "../assist.js";
import { streamedChars, tokens } from "../format.js";
import { mix, shimmer, sparkline, streamRate } from "../fx.js";
import { attachmentFrom, attachmentFromFile, byteSize, clipboardImageByTool, imagePathsFromPaste, type PendingImage } from "../images.js";
import { harnessGlyph } from "../neat.js";
import { accentOf, contextTone } from "../theme.js";
import { useAtui, useTheme } from "./context.js";
import { Shimmer } from "./fx.js";
import { tick } from "./ticker.js";

/** From this share of the context the composer offers to compact first, and from this one it starts on. */
export const COMPACT_OFFER = 50;
export const COMPACT_DEFAULT = 80;

/** The rate is measured over this much of the stream, and its sparkline keeps a sample every half second. */
const RATE_WINDOW_MS = 2000;
const RATE_EVERY_TICKS = 5;
const RATE_SAMPLES = 12;

/** Cells in the sweep drawn while the context compacts. */
const SWEEP_CELLS = 8;

/** While compacting: a band of light running right to left over a bar, as the history is pressed down. */
function CompactSweep() {
  const t = useTheme();
  const colors = () => shimmer(SWEEP_CELLS, tick(), mix(t().bg, t().border, 0.8), t().accent, 3).reverse();
  return <Index each={colors()}>{(c) => <span style={{ fg: c() }}>━</span>}</Index>;
}

/** The host clipboard (Wayland, X11, macOS), opened on the first C-v. */
let clipboard: HostClipboardService | null = null;

export function Composer(p: {
  focused: boolean;
  compactChoice: boolean | null;
  onCompactChoice: (on: boolean | null) => void;
  /** A click on the footer's harness, model, or thinking level opens its picker. */
  onPick: (picker: "harness" | "models" | "thinking") => void;
  /** A click on the context figure (or the rate beside it) opens the active-work panel, as C-x p does. */
  onContext: () => void;
  /** What the status bar used to say, now in the footer: vim's mode, a waiting C-x, a passing hint. */
  status: { mode: "normal" | "insert" | null; leader: boolean; note: string | null };
  /** The conversation's column: the card draws at it, while the footer under it stays the pane's status line. */
  column: number;
  ref: (el: TextareaRenderable) => void;
}) {
  const app = useAtui();
  const t = useTheme();
  let area: TextareaRenderable | undefined;

  // Images waiting to go with the next message.
  const [images, setImages] = createSignal<PendingImage[]>([]);
  const warn = (text: string) => app.setBanner({ level: "warning", text });
  const addImages = (found: Array<PendingImage | string>) => {
    const ok = found.filter((f): f is PendingImage => typeof f !== "string");
    const why = found.find((f): f is string => typeof f === "string");
    if (why) warn(why);
    if (ok.length === 0) return;
    if (images().length + ok.length > MAX_IMAGES) warn(`At most ${MAX_IMAGES} images go with one message`);
    setImages((list) => [...list, ...ok].slice(0, MAX_IMAGES));
  };
  // A paste that is image files (a drop) or image bytes attaches them; anything else is text, as usual.
  usePaste((event) => {
    if (!p.focused) return;
    if (event.metadata?.kind === "binary" && event.metadata.mimeType?.startsWith("image/")) {
      event.preventDefault();
      addImages([attachmentFrom(event.bytes)]);
      return;
    }
    const files = imagePathsFromPaste(decodePasteBytes(event.bytes), app.workspace()?.path ?? process.cwd());
    if (!files) return;
    event.preventDefault();
    void Promise.all(files.map(attachmentFromFile)).then(addImages);
  });
  const pasteClipboardImage = async () => {
    clipboard ??= createHostClipboard();
    const read = await clipboard.read({ preferredTypes: [...IMAGE_MIME_TYPES] as [string, ...string[]] }).catch(() => null);
    if (read?.status === "read" && read.representation.mimeType.startsWith("image/")) return addImages([attachmentFrom(read.representation.bytes)]);
    // OpenTUI's reader is not in every build: wl-paste or xclip then.
    const byTool = read?.status === "empty" || read?.status === "read" ? "empty" : await clipboardImageByTool(process.env);
    if (byTool instanceof Uint8Array) addImages([attachmentFrom(byTool)]);
    else if (byTool === "empty") warn("No image on the clipboard (paste text with C-S-v)");
    else warn("Cannot read the clipboard: install wl-clipboard (Wayland) or xclip (X11)");
  };

  // The "/" menu: open while the first word is typed; ↑/↓ move, Tab completes, Esc closes.
  // "$" is the skills' own (where the harness has any), "#" the saved prompts (the server's, shared with the browser).
  const [text, setText] = createSignal("");
  const [commands, setCommands] = createSignal<SlashCommand[] | null>(null);
  const [saved, setSaved] = createSignal<SavedPrompt[] | null>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const slash = () => /^\/(\S*)$/.exec(text())?.[1];
  const skillQuery = () => /^\$(\S*)$/.exec(text())?.[1];
  const promptQuery = () => /^#(\S*)$/.exec(text())?.[1];
  const kind = (): "slash" | "skill" | "prompt" | null => {
    if (!p.focused || dismissed()) return null;
    if (slash() !== undefined) return "slash";
    if (skillQuery() !== undefined && (commands() ?? []).some(isSkill)) return "skill";
    if (promptQuery() !== undefined && (saved()?.length ?? 0) > 0) return "prompt";
    return null;
  };
  const menuOpen = () => kind() !== null;
  const promptMatches = createMemo(() => (kind() === "prompt" ? matchPrompts(saved() ?? [], promptQuery() ?? "").slice(0, 8) : []));
  const menu = createMemo(() => {
    const k = kind();
    if (k === "slash") return slashMenu(commands() ?? APP_COMMANDS, slash() ?? "").slice(0, 8);
    if (k === "skill") return skillMenu(commands() ?? [], skillQuery() ?? "").slice(0, 8);
    if (k === "prompt") return promptMatches().map((sp): SlashCommand => ({ name: sp.name, description: promptGist(sp), source: "saved" }));
    return [];
  });
  // A memo, not the chat itself: `on()` runs on every change of its source's signals, and the chat changes with
  // each streamed event, which emptied the list mid-run (the / menu fell back to awui's own commands).
  const chatId = createMemo(() => app.chat()?.chatId);
  createEffect(on(chatId, () => setCommands(null)));
  // Asked for once each is first wanted: the commands (and skills), and the saved prompts.
  const wantsCommands = () => p.focused && (slash() !== undefined || skillQuery() !== undefined);
  createEffect(
    on(
      () => p.focused && promptQuery() !== undefined,
      (want) => {
        if (!want || saved() !== null) return;
        app.server
          .call<{ prompts: SavedPrompt[] }>("/api/prompts")
          .then((r) => setSaved(r.prompts))
          .catch(() => setSaved([]));
      },
    ),
  );
  createEffect(
    on(wantsCommands, (open) => {
      const c = app.chat();
      if (!open || commands() !== null) return;
      if (!c) return setCommands(mergeCommands([]));
      app.server
        .call<{ commands: SlashCommand[] }>(`/api/chats/${c.chatId}/commands`)
        .then((r) => setCommands(mergeCommands(r.commands)))
        .catch(() => setCommands(mergeCommands([])));
    }),
  );
  createEffect(
    on([slash, skillQuery, promptQuery], ([a, b, c]) => {
      setMenuIndex(0);
      if (a === undefined && b === undefined && c === undefined) setDismissed(false);
    }),
  );
  /** A saved prompt in place of the draft, its first blank selected to type over. */
  const insertPrompt = (value: string) => {
    area?.setText(value);
    const first = blanks(value)[0];
    if (first) area?.setSelection(first.start, first.end);
    else area?.gotoBufferEnd();
  };
  const complete = (c: SlashCommand) => {
    if (kind() === "prompt") {
      const sp = promptMatches().find((x) => x.name === c.name);
      if (sp) insertPrompt(sp.text);
      return;
    }
    area?.setText(`/${c.name} `);
    area?.gotoLineTextEnd();
  };
  const menuName = (c: SlashCommand) => (kind() === "skill" ? `$${skillName(c)}` : kind() === "prompt" ? `#${c.name}` : `/${c.name}`);
  const ghost = () => (kind() === "slash" && menu().length > 0 && !text().includes("\n") ? ghostCompletion(text(), menu()[menuIndex()]) : "");

  // The "@" menu: the project's files matching what follows the @, asked for as you type.
  const mention = () => (p.focused ? mentionAt(text()) : null);
  const [files, setFiles] = createSignal<string[]>([]);
  const [fileIndex, setFileIndex] = createSignal(0);
  const [filesDismissed, setFilesDismissed] = createSignal(false);
  let fileTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => mention()?.query,
      (q) => {
        clearTimeout(fileTimer);
        setFileIndex(0);
        if (q === undefined) {
          setFiles([]);
          setFilesDismissed(false);
          return;
        }
        fileTimer = setTimeout(() => {
          void app.searchFiles(q).then((list) => {
            if (mention()?.query === q) setFiles(list.slice(0, 8));
          });
        }, 80);
      },
    ),
  );
  onCleanup(() => clearTimeout(fileTimer));
  const fileMenu = () => (mention() && !filesDismissed() ? files() : []);
  const pickFile = (file: string) => {
    area?.setText(applyMention(text(), file));
    area?.gotoBufferEnd();
  };

  useKeyboard((key) => {
    if (!p.focused || key.defaultPrevented) return;
    if (key.ctrl && !key.meta && key.name === "v") {
      key.preventDefault();
      void pasteClipboardImage();
    } else if (key.name === "backspace" && images().length > 0 && !(area?.plainText ?? "")) {
      key.preventDefault();
      setImages((list) => list.slice(0, -1));
    }
  });
  useKeyboard((key) => {
    if (fileMenu().length === 0 || key.defaultPrevented) return;
    const list = fileMenu();
    if (key.name === "escape") {
      key.preventDefault();
      setFilesDismissed(true);
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setFileIndex((i) => (i + (key.name === "down" ? 1 : -1) + list.length) % list.length);
    } else if (key.name === "tab" || (key.name === "return" && !key.shift)) {
      key.preventDefault();
      const file = list[fileIndex()];
      if (file) pickFile(file);
    }
  });
  useKeyboard((key) => {
    if (!menuOpen() || key.defaultPrevented || menu().length === 0) return;
    if (key.name === "escape") {
      key.preventDefault();
      setDismissed(true);
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setMenuIndex((i) => (i + (key.name === "down" ? 1 : -1) + menu().length) % menu().length);
    } else if (key.name === "tab") {
      key.preventDefault();
      const c = menu()[menuIndex()];
      if (c) complete(c);
    } else if (key.name === "return" && !key.shift) {
      const c = menu()[menuIndex()];
      // A command typed in full that takes nothing runs on Enter; otherwise Enter completes it.
      if (c && !(kind() === "slash" && c.name === slash() && !c.hint)) {
        key.preventDefault();
        complete(c);
      }
    }
  });

  // A saved prompt's blanks: Tab to the next, Shift+Tab back (unless the only one is already selected).
  useKeyboard((key) => {
    if (!p.focused || key.defaultPrevented || menuOpen() || key.name !== "tab" || !area) return;
    const value = area.plainText;
    const at = area.cursorOffset;
    const blank = nextBlank(value, key.shift ? Math.max(0, at - 1) : at, key.shift);
    if (!blank || (blank.end === at && blanks(value).length === 1)) return;
    key.preventDefault();
    area.setSelection(blank.start, blank.end);
  });

  const percent = () => app.chat()?.context?.percent ?? null;
  const offer = createMemo(() => {
    const c = app.chat();
    return Boolean(c && c.capabilities.supportsCompact && c.context?.tokens != null && (percent() ?? 0) >= COMPACT_OFFER && !app.busy());
  });
  const compactFirst = () => offer() && (p.compactChoice ?? (percent() ?? 0) >= COMPACT_DEFAULT);

  // Edit on a past prompt: its text comes in here, and Enter replaces the prompt with what is then typed.
  createEffect(
    on(app.editing, (e) => {
      if (!e || !area) return;
      area.setText(e.item.text);
      area.gotoBufferEnd();
      // Edit was a click in the transcript, which took the focus: the typing that follows is for here.
      area.focus();
    }),
  );

  const submit = async () => {
    const text = area?.plainText ?? "";
    const attached = images();
    const editing = app.editing();
    if (editing) {
      if (!text.trim()) return;
      area?.clear();
      if (await app.rerun(editing.through, editing.item, text)) app.setEditing(null);
      else if (area && !area.plainText) area.setText(text);
      return;
    }
    if (!text.trim() && attached.length === 0) return;
    area?.clear();
    setImages([]);
    const ok = await app.send(text, { ...(compactFirst() ? { compactFirst: true } : {}), ...(attached.length > 0 ? { images: attached } : {}) });
    if (ok) p.onCompactChoice(null);
    else {
      if (area && !area.plainText) area.setText(text);
      if (images().length === 0) setImages(attached);
    }
  };

  const placeholder = () => {
    const c = app.chat();
    if (!c) return `Ask ${app.harness()?.displayName ?? "the agent"} to…`;
    if (c.status === "running") return c.capabilities.supportsSteer ? "Steer the agent (Enter) · Esc Esc stops" : "Queue a follow-up (Enter) · Esc Esc stops";
    return "Message the agent…";
  };

  const tone = () => contextTone(t(), percent() ?? 0);
  // What waits to go: steering and follow-ups the harness holds. A count, since the queue itself is its own picker.
  const queued = () => (app.chat()?.queue.steering.length ?? 0) + (app.chat()?.queue.followUp.length ?? 0);
  /** A repo's state in one word: what is uncommitted, or nothing. */
  const gitWord = (g: NonNullable<ReturnType<typeof app.git>>) =>
    g.counts.conflicts > 0 ? `${g.counts.conflicts} conflicted` : g.files.length === 0 ? "clean" : `${g.files.length} changed`;

  // How fast the agent writes: what the turn has streamed, sampled on the clock while it runs.
  const [rate, setRate] = createSignal<number | null>(null);
  const [rates, setRates] = createSignal<number[]>([]);
  let samples: Array<[number, number]> = [];
  let sampled: string | null = null;
  createEffect(
    on(tick, (n) => {
      const c = app.chat();
      // Another chat shown: its rate starts over.
      if (c?.chatId !== sampled) samples = [];
      sampled = c?.chatId ?? null;
      if (!c || c.status !== "running") {
        if (samples.length > 0 || rate() !== null) {
          samples = [];
          setRate(null);
          setRates([]);
        }
        return;
      }
      const now = Date.now();
      samples.push([now, streamedChars(c.items)]);
      samples = samples.filter(([at]) => now - at <= RATE_WINDOW_MS);
      const r = streamRate(samples);
      setRate(r);
      if (r !== null && n % RATE_EVERY_TICKS === 0) setRates((h) => [...h, r].slice(-RATE_SAMPLES));
    }),
  );

  // The chips' words: the chat's model and level, else the start screen's catalog default (web/model-label.ts).
  const caps = () => app.chat()?.capabilities ?? app.harness()?.capabilities;
  const words = () => app.chips();

  return (
    <box flexDirection="column" flexShrink={0} marginLeft={2} marginRight={2}>
      <Show when={menu().length > 0}>
        <box flexDirection="column" width={p.column} alignSelf="center" border borderStyle="rounded" borderColor={t().border} backgroundColor={t().surface} paddingLeft={1} paddingRight={1}>
          <Show when={kind() !== "slash"}>
            <text fg={kind() === "skill" ? t().thinking : t().accent}>
              <b>{kind() === "skill" ? "Skills" : "Saved prompts"}</b>
            </text>
          </Show>
          <For each={menu()}>
            {(c, i) => (
              <box flexDirection="row" backgroundColor={i() === menuIndex() ? t().selection : undefined} onMouseDown={() => complete(c)}>
                <text flexShrink={0} fg={i() === menuIndex() ? t().text : kind() === "skill" ? t().thinking : kind() === "prompt" ? t().accent : t().text2}>
                  {menuName(c)}
                  <span style={{ fg: t().muted }}>{c.hint ? ` ${c.hint}` : ""}</span>
                </text>
                <text flexGrow={1} fg={t().muted} wrapMode="none" truncate>
                  {c.description ? `  ${c.description}` : ""}
                </text>
                <text flexShrink={0} fg={t().muted}>{` ${c.source}`}</text>
              </box>
            )}
          </For>
          <text fg={t().muted}>
            {kind() === "prompt" ? "↑↓ move · Tab or Enter puts it in · Esc closes" : "↑↓ move · Tab completes · Esc closes"}
            <Show when={kind() === "slash" && (commands() ?? []).some(isSkill) && !(slash() ?? "").startsWith("skill")}>
              <span style={{ fg: t().thinking }}>{`  · ${(commands() ?? []).filter(isSkill).length} skills under $`}</span>
            </Show>
          </text>
        </box>
      </Show>
      <Show when={images().length > 0}>
        <box flexDirection="row" flexWrap="wrap" paddingLeft={1} width={p.column} alignSelf="center">
          <For each={images()}>
            {(image, i) => (
              <box flexDirection="column" marginRight={2}>
                <Show when={app.imageMode}>{(protocol) => <image source={image.bytes} fit="fit" protocol={protocol()} width={10} height={4} />}</Show>
                <box flexDirection="row">
                  <text fg={t().muted}>
                    <span style={{ fg: t().text2, bg: t().surface2 }}>{` ▣ #${i() + 1} `}</span>
                    {` ${image.mimeType.replace("image/", "")} ${byteSize(image.bytes.byteLength)} `}
                  </text>
                  <text fg={t().danger} onMouseDown={() => setImages((list) => list.filter((x) => x !== image))}>
                    ×
                  </text>
                </box>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={fileMenu().length > 0}>
        <box flexDirection="column" width={p.column} alignSelf="center" border borderStyle="rounded" borderColor={t().border} backgroundColor={t().surface} paddingLeft={1} paddingRight={1}>
          <For each={fileMenu()}>
            {(file, i) => {
              const cut = file.lastIndexOf("/") + 1;
              return (
                <box flexDirection="row" backgroundColor={i() === fileIndex() ? t().selection : undefined} onMouseDown={() => pickFile(file)}>
                  <text wrapMode="none" truncate fg={t().muted}>
                    {"@"}
                    {file.slice(0, cut)}
                    <span style={{ fg: i() === fileIndex() ? t().text : t().text2 }}>{file.slice(cut)}</span>
                  </text>
                </box>
              );
            }}
          </For>
          <text fg={t().muted}>↑↓ move · Tab or Enter inserts · Esc closes</text>
        </box>
      </Show>
      <box
        width={p.column}
        alignSelf="center"
        border
        borderStyle="rounded"
        borderColor={p.focused ? accentOf(t(), app.harness()?.accent) : t().border}
        backgroundColor={app.glass() ? undefined : t().surface}
        paddingLeft={1}
        paddingRight={1}
      >
        <textarea
          ref={(el: TextareaRenderable) => {
            area = el;
            p.ref(el);
          }}
          focused={p.focused}
          placeholder={placeholder()}
          placeholderColor={t().muted}
          textColor={t().text}
          focusedTextColor={t().text}
          backgroundColor={app.glass() ? undefined : t().surface}
          focusedBackgroundColor={app.glass() ? undefined : t().surface}
          cursorColor={t().accent}
          wrapMode="word"
          minHeight={1}
          maxHeight={8}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "kpenter", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "return", meta: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onSubmit={() => void submit()}
          onContentChange={() => setText(area?.plainText ?? "")}
        />
        <Show when={ghost()}>
          {(rest) => (
            <box position="absolute" top={0} left={1 + text().length}>
              <text fg={t().muted}>{rest()}</text>
            </box>
          )}
        </Show>
      </box>
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" flexGrow={1} overflow="hidden">
          <Show when={p.status.mode}>
            {(mode) => (
              <text flexShrink={0} wrapMode="none" fg={mode() === "normal" ? t().accent : t().muted}>
                <b>{mode() === "normal" ? "-- NORMAL -- " : "-- INSERT -- "}</b>
              </text>
            )}
          </Show>
          <Show when={p.status.leader}>
            <text flexShrink={0} wrapMode="none" fg={t().accent}>
              <b>{"C-x- "}</b>
            </text>
          </Show>
          <Show when={app.conn() !== "connected" && app.conn() !== "idle"}>
            <text flexShrink={0} wrapMode="none" fg={t().warn}>
              {"◌ reconnecting  "}
            </text>
          </Show>
          <text flexShrink={0} wrapMode="none" fg={accentOf(t(), app.harness()?.accent)} onMouseDown={() => p.onPick("harness")}>
            {`${harnessGlyph(app.harness()?.id ?? "")} ${app.harness()?.displayName ?? "—"} ▾`}
          </text>
          <Show when={caps()?.supportsModelSelection}>
            <text flexShrink={1} wrapMode="none" truncate fg={t().text2} onMouseDown={() => p.onPick("models")}>
              {`  ${words().name} ▾`}
            </text>
          </Show>
          <Show when={caps()?.supportsThinkingLevel ? words().level : null}>
            {(level) => (
              <text flexShrink={0} wrapMode="none" fg={t().muted} onMouseDown={() => p.onPick("thinking")}>
                {`  ${levelTitle(level())} ▾`}
              </text>
            )}
          </Show>
          <Show when={app.editing() !== null}>
            <text flexShrink={0} wrapMode="none" fg={t().accent}>
              {`  ✎ editing message ${app.editing()?.through ?? ""} · Enter replaces it · Esc cancels`}
            </text>
          </Show>
          <Show when={p.status.note}>
            {(note) => (
              // A narrow footer cuts the hint before the model's name.
              <text flexShrink={100} wrapMode="none" truncate fg={t().warn}>
                {`  ${note()}`}
              </text>
            )}
          </Show>
        </box>
        <text flexShrink={0} onMouseDown={() => p.onContext()}>
          {"  "}
          <Show when={queued() > 0}>
            <span style={{ fg: t().accent }}>{`+${queued()} queued  `}</span>
          </Show>
          {/* The project's git state, as the web UI's composer row has it: the branch, its distance from the upstream, what is uncommitted. */}
          <Show when={app.git()}>
            {(g) => (
              <>
                <span style={{ fg: t().accent }}>{g().branch ?? `detached ${g().head ?? ""}`}</span>
                <Show when={g().upstream && (g().ahead > 0 || g().behind > 0)}>
                  <span style={{ fg: t().muted }}>{` ${g().ahead > 0 ? `↑${g().ahead}` : ""}${g().behind > 0 ? `↓${g().behind}` : ""}`}</span>
                </Show>
                <Show when={g().added + g().removed > 0}>
                  <span style={{ fg: t().ok }}>{` +${g().added}`}</span>
                  <span style={{ fg: t().danger }}>{` −${g().removed}`}</span>
                </Show>
                <span style={{ fg: g().counts.conflicts > 0 ? t().danger : g().files.length === 0 ? t().muted : t().text2 }}>{` ${gitWord(g())}  `}</span>
              </>
            )}
          </Show>
          {/* Gone the moment the run ends, not at the next sample. */}
          <Show when={app.chat()?.status === "running" && (rate() ?? 0) >= 1}>
            <span style={{ fg: t().muted }}>{`~${Math.round(rate() ?? 0)} tok/s `}</span>
            <Show when={rates().length > 1}>
              <span style={{ fg: t().text2 }}>{`${sparkline(rates())}  `}</span>
            </Show>
          </Show>
          <Show when={offer()}>
            <span style={{ fg: compactFirst() ? t().warn : t().muted }}>{`${compactFirst() ? "compact first" : "full history"} ${tokens(app.chat()?.context?.tokens ?? 0)} (C-x f)  `}</span>
          </Show>
          <Show
            when={app.chat()?.status === "compacting"}
            fallback={
              <>
                {/* The last dozen samples: enough to see the trend without taking the hint's room. */}
                <Show when={app.contextHistory().length > 1}>
                  <span style={{ fg: tone() }}>{`${sparkline(app.contextHistory().slice(-12), 100)} `}</span>
                </Show>
                <Show when={percent() !== null}>
                  <span style={{ fg: tone() }}>{`ctx ${Math.round(percent() ?? 0)}%`}</span>
                </Show>
              </>
            }
          >
            <Shimmer text="compacting " />
            <CompactSweep />
          </Show>
        </text>
      </box>
    </box>
  );
}
