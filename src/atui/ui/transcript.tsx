// The conversation, turn by turn, drawn as neat-render (the pi extension)
// draws Pi's: the prompt behind a `❯` on a fill strip, the work shown rather
// than folded (a lone call a bulleted row with its outcome on a `└` line and
// an edit's first changed lines under it, calls fired together hung off one
// tree with each outcome at the end of its line, thinking as one `◇ Thinking`
// line), the answer marked with an accent `●`, and a Σ line of what the turn
// did. Replies the agent wrote between tool calls show in order. C-x e folds
// every turn to a "Worked for …" line (the web UI's), and a running turn keeps
// that line, with its spinner, over its work. A clicked call is framed
// omp-style (command, Output, outcome in the bottom edge). The column stops at
// config.yml's chat_width inside what the side panel leaves and centres: 104
// characters (comfortable), 160 (wide), or the pane's whole width (full); a gutter on the right maps
// every turn and scrolls on a click, and the prompt of the turn you are reading stays pinned
// at the top.
import { createEffect, createMemo, createResource, createSignal, For, Index, Match, on, onCleanup, Show, Switch, type Accessor } from "solid-js";
import { BoxRenderable, type Renderable, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import type { AssistantItem, ChatItem, ImageRef, NoticeItem, RequestItem, SubagentRun, ToolItem, UserItem } from "../../shared/protocol.js";
import { buildTurns, formatDuration, latestThought, modelName, modelSwitches, relativePath, saysSomething, workAfterSegment, workCounts, workSegments, type Turn, type WorkSegment } from "../../web/turns.js";
import { clip, fileUrl, foldLabel, outputTail, unifiedDiff } from "../format.js";
import { easeOut, flashAt, mix, unrollCounts } from "../fx.js";
import { filetypeOf, taskBoxes, withCaret } from "../markdown.js";
import { minimapCells, pinnedTurn, rowToScroll, turnTone, type TurnTone } from "../minimap.js";
import { latestThoughtLine, neatRow, sigmaFacts, thinkingMeta, workRuns, type WorkRun } from "../neat.js";
import { accentOf, categoryTone, type Theme } from "../theme.js";
import { highlightPreview } from "../words.js";
import { useAtui, useTheme } from "./context.js";
import { glideTo, Shimmer, Spinner, usePaced } from "./fx.js";
import { syntaxFor } from "./syntax.js";
import { tick } from "./ticker.js";

const OUTPUT_LINES = 14;
/** A running command's last lines, shown under its row while it works. */
const LIVE_LINES = 3;
/** From this terminal width an edit's frame shows its diff side by side. */
const SPLIT_DIFF_WIDTH = 150;
/** Lines of a prompt's image, drawn with the terminal's image protocol or half blocks. */
const IMAGE_ROWS = 8;

/** Half-period of a running row's pulse, in ticks of 100 ms (neat-render's 450 ms). */
const PULSE_TICKS = 4.5;
const pulseOn = () => Math.floor(tick() / PULSE_TICKS) % 2 === 0;

/** The row's bullet, neat-render's: the category's colour when it settles, red on failure, filled and hollow in turn while it runs. */
function Bullet(p: { status: "running" | "done" | "error"; failedOutput?: boolean; category: ToolItem["category"] }) {
  const t = useTheme();
  const on = () => p.status !== "running" || pulseOn();
  const color = () => (p.status === "error" || p.failedOutput ? t().danger : p.status === "running" ? (on() ? t().warn : t().muted) : categoryTone(t(), p.category));
  return <span style={{ fg: color() }}>{on() ? "● " : "○ "}</span>;
}

/**
 * Markdown blocks atui draws its own way: a top heading over an accent rule,
 * a quote behind a bar, a code block on a tinted panel. Everything else is
 * OpenTUI's default.
 */
function nodeRenderer(theme: Theme) {
  return (token: { type: string; depth?: number }, ctx: { defaultRender: () => Renderable | null }): Renderable | null | undefined => {
    if (token.type !== "heading" && token.type !== "blockquote" && token.type !== "code") return undefined;
    const inner = ctx.defaultRender();
    if (!inner) return inner;
    if (token.type === "heading" && (token.depth ?? 1) > 2) return inner;
    const options =
      token.type === "heading"
        ? { width: "100%" as const, border: ["bottom" as const], borderColor: mix(theme.bg, theme.accent, 0.55) }
        : token.type === "blockquote"
          ? { border: ["left" as const], borderColor: mix(theme.bg, theme.thinking, 0.7), paddingLeft: 1 }
          : { width: "100%" as const, backgroundColor: mix(theme.bg, theme.surface2, 0.6), paddingLeft: 1, paddingRight: 1 };
    // OpenTUI zeroes a custom block's bottom margin, so the gap after it rides as the outer box's padding
    // (a code block's is decided after this runs, so it always keeps one line).
    const gap = Math.max(token.type === "code" ? 1 : 0, typeof inner.marginBottom === "number" ? inner.marginBottom : 0);
    inner.marginBottom = 0;
    const panel = new BoxRenderable(inner.ctx, { flexDirection: "column", ...options });
    panel.add(inner);
    const outer = new BoxRenderable(inner.ctx, { flexDirection: "column", width: "100%", paddingBottom: gap });
    outer.add(panel);
    return outer;
  };
}

const renderers = new Map<string, ReturnType<typeof nodeRenderer>>();
const rendererFor = (theme: Theme) => {
  const key = `${theme.bg}${theme.accent}${theme.thinking}`;
  let hit = renderers.get(key);
  if (!hit) renderers.set(key, (hit = nodeRenderer(theme)));
  return hit;
};

/** How long the stream's cursor shows, then hides, in ticks of 100 ms. */
const CARET_ON = 6;
const CARET_OFF = 4;

/** Markdown as atui draws it: revealed at a steady pace while it streams (a blinking cursor where it writes), task lists as boxes, tables in rounded borders. */
function Md(p: { text: string; streaming: boolean; fg: string }) {
  const t = useTheme();
  const renderer = useRenderer();
  const paced = usePaced(
    () => p.text,
    () => p.streaming,
  );
  // The clock is read only while streaming: a finished answer is not drawn again every tick.
  const content = () => {
    const text = taskBoxes(paced());
    if (!p.streaming) return text;
    return tick() % (CARET_ON + CARET_OFF) < CARET_ON ? withCaret(text) : text;
  };
  return (
    <markdown
      content={content()}
      syntaxStyle={syntaxFor(t(), renderer.nativeScene)}
      fg={p.fg}
      conceal
      streaming={p.streaming || paced().length < p.text.length}
      tableOptions={{ borders: true, borderStyle: "rounded", borderColor: t().border, cellPaddingX: 1 }}
      renderNode={rendererFor(t()) as never}
    />
  );
}

/** One of a prompt's images: drawn in the terminal (kitty's protocol in kitty and Ghostty, sixel, else half blocks), its number on a chip below. */
function PromptImage(p: { image: ImageRef; n: number }) {
  const app = useAtui();
  const t = useTheme();
  const [bytes] = createResource(
    () => p.image.id,
    (id) => app.image(id),
  );
  return (
    <box flexDirection="column" marginRight={2}>
      <Show when={app.imageMode && bytes()}>{(b) => <image source={b()} fit="fit" protocol={app.imageMode ?? "blocks"} width={IMAGE_ROWS * 2 + 4} height={IMAGE_ROWS} />}</Show>
      <text fg={t().muted}>
        <span style={{ fg: t().text2, bg: t().surface2 }}>{` ▣ #${p.n} `}</span>
        <span>{` ${p.image.mimeType.replace("image/", "")}`}</span>
      </text>
    </box>
  );
}

/** One action under a prompt: a chip that runs on a click. */
function Chip(p: { label: string; onPress: () => void; tone?: string }) {
  const t = useTheme();
  return (
    <box flexShrink={0} marginRight={1} paddingLeft={1} paddingRight={1} backgroundColor={mix(t().bg, t().surface2, 0.9)} onMouseDown={p.onPress}>
      <text fg={p.tone ?? t().text2}>{p.label}</text>
    </box>
  );
}

/**
 * What a past prompt offers, under its card once clicked (the web UI's hover
 * row): Retry and Edit (in place where the harness can, else in a branch),
 * Undo files where it has a checkpoint, Fork, and Copy, each only where the
 * chat and the harness allow it, and only while the agent is idle.
 */
function PromptActions(p: { item: UserItem; through: number; onDone: () => void }) {
  const app = useAtui();
  const t = useTheme();
  const renderer = useRenderer();
  const c = () => app.chat();
  const idle = () => c()?.status === "idle" || c()?.status === "error";
  const inPlace = () => c()?.capabilities.supportsRewind ?? false;
  const canFork = () => c()?.capabilities.supportsFork ?? false;
  const canBranch = () => idle() && (inPlace() || p.through === 1 || canFork());
  const hasCheckpoint = () => (c()?.checkpoints ?? []).includes(p.through);
  const run = (action: () => void) => () => {
    p.onDone();
    action();
  };
  return (
    <box flexDirection="row" flexWrap="wrap" marginTop={0} paddingLeft={1}>
      <Show when={canBranch()}>
        <Chip label="↻ Retry" onPress={run(() => void app.rerun(p.through, p.item, p.item.text))} />
        <Chip label="✎ Edit" onPress={run(() => app.setEditing({ through: p.through, item: p.item }))} />
      </Show>
      <Show when={idle() && hasCheckpoint()}>
        <Chip label="↶ Undo files" tone={t().warn} onPress={run(() => app.setUndoTurn(p.through))} />
      </Show>
      <Show when={idle() && canFork() && p.through > 1}>
        <Chip label="⑂ Fork before" onPress={run(() => void app.fork(p.through - 1))} />
      </Show>
      <Chip label="⧉ Copy" onPress={run(() => void renderer.copyToClipboardOSC52(p.item.text))} />
      <Show when={!idle()}>
        <text fg={t().muted}>{" Retry and Edit wait until the agent is idle"}</text>
      </Show>
    </box>
  );
}

/**
 * The prompt as neat-render quotes it: a `❯` over a fill strip the column's
 * width, the text as Markdown. `glow` (0 to 1) lights the `❯` in the
 * harness's colour as a run ends; a click shows what the prompt offers.
 */
function UserPrompt(p: { item: UserItem; glow: number; through: number }) {
  const t = useTheme();
  const app = useAtui();
  const [actions, setActions] = createSignal(false);
  return (
    <box flexDirection="column">
      <box
        onMouseDown={() => p.through > 0 && setActions(!actions())}
        backgroundColor={app.glass() ? undefined : t().surface}
        paddingRight={1}
        marginTop={1}
        flexDirection="row"
      >
        <text flexShrink={0} fg={p.glow > 0 ? mix(t().muted, accentOf(t(), app.harness()?.accent), p.glow) : t().muted}>
          {"❯ "}
        </text>
        <box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Md text={p.item.text} streaming={false} fg={t().text} />
          <Show when={p.item.imageCount && !p.item.images?.length}>
            <text fg={t().muted}>{`[${p.item.imageCount} ${p.item.imageCount === 1 ? "image" : "images"}]`}</text>
          </Show>
          <Show when={p.item.images?.length}>
            <box flexDirection="row" flexWrap="wrap" marginTop={1}>
              <Index each={p.item.images ?? []}>{(image, i) => <PromptImage image={image()} n={i + 1} />}</Index>
            </box>
          </Show>
        </box>
      </box>
      <Show when={actions()}>
        <PromptActions item={p.item} through={p.through} onDone={() => setActions(false)} />
      </Show>
    </box>
  );
}

/**
 * A thought as one line, neat-render's: `◇ Thinking 2.1s ~140 tokens`. While it
 * streams the marker fills to `◆` on every other beat and the line rolls with
 * the newest thought; a click opens the reasoning, hung under its label.
 */
function Thought(p: { item: AssistantItem }) {
  const t = useTheme();
  const [open, setOpen] = createSignal(false);
  const live = () => p.item.streaming && !p.item.text;
  // A live thought's time runs on the clock; a finished one is read once.
  const meta = () => {
    if (live()) void tick();
    return thinkingMeta(p.item);
  };
  const latest = () => (live() && !open() ? latestThoughtLine(p.item.thinking) : "");
  return (
    <box flexDirection="column" onMouseDown={() => setOpen(!open())}>
      <text wrapMode="none" truncate>
        <span style={{ fg: live() && pulseOn() ? t().warn : t().muted }}>{live() && pulseOn() ? "◆ " : "◇ "}</span>
        <span style={{ fg: t().thinking }}>Thinking</span>
        <span style={{ fg: t().muted }}>{` ${meta()}`}</span>
        <Show when={latest()}>
          <span style={{ fg: t().border }}>{" │ "}</span>
          <span style={{ fg: t().muted }}>{latest()}</span>
        </Show>
      </text>
      <Show when={open()}>
        <box paddingLeft={2}>
          <text fg={t().muted} wrapMode="word">
            <i>{p.item.thinking.trim()}</i>
          </text>
        </box>
      </Show>
    </box>
  );
}

/**
 * A clicked call, framed the way omp draws it: the call, an Output rule, what
 * it printed (or an edit's diff, highlighted for its language and side by
 * side on a wide terminal), and the outcome set into the bottom edge. The
 * frame is quiet when done, accent while running, red on failure.
 */
function ToolDetails(p: { item: ToolItem; workspace: string }) {
  const t = useTheme();
  const renderer = useRenderer();
  const size = useTerminalDimensions();
  const row = createMemo(() => neatRow(p.item, p.workspace));
  const tone = () => (p.item.status === "running" ? t().accent : p.item.status === "error" ? t().danger : t().border);
  const file = () => relativePath(p.item.paths[0] ?? p.item.summary, p.workspace);
  const diff = createMemo(() => (p.item.diff && (p.item.category === "edit" || p.item.category === "write") ? unifiedDiff(file(), p.item.diff) : null));
  const command = () => (p.item.category === "command" && row().detail?.startsWith("$ ") ? (row().detail as string).slice(2) : null);
  const output = createMemo(() => {
    const lines = p.item.output.replace(/\n+$/, "").split("\n");
    const shown = lines.slice(-OUTPUT_LINES).join("\n");
    return lines.length > OUTPUT_LINES ? `… ${lines.length - OUTPUT_LINES} lines above\n${shown}` : shown;
  });
  const status = () => (p.item.status === "running" ? "running…" : row().facts.join(" · "));
  return (
    <box border borderStyle="rounded" borderColor={tone()} bottomTitle={status() ? ` ${status()} ` : undefined} flexDirection="column" paddingLeft={1} paddingRight={1} marginTop={1} marginBottom={1}>
      <Show when={command()}>
        {(c) => (
          <text wrapMode="word">
            <span style={{ fg: t().muted }}>$ </span>
            <span style={{ fg: t().link }}>{c()}</span>
          </text>
        )}
      </Show>
      <Show
        when={diff()}
        fallback={
          <Show when={output()}>
            <Show when={command()}>
              <box border={["top"]} borderColor={tone()} title=" Output " titleColor={t().text2} />
            </Show>
            <text fg={t().text2} wrapMode="char">
              {output()}
            </text>
          </Show>
        }
      >
        {(d) => (
          <diff
            diff={d()}
            view={size().width >= SPLIT_DIFF_WIDTH ? "split" : "unified"}
            filetype={filetypeOf(file())}
            syntaxStyle={syntaxFor(t(), renderer.nativeScene)}
            showLineNumbers
            wrapMode="word"
            fg={t().text}
            addedBg={mix(t().bg, t().ok, 0.16)}
            removedBg={mix(t().bg, t().danger, 0.16)}
            addedContentBg={mix(t().bg, t().ok, 0.16)}
            removedContentBg={mix(t().bg, t().danger, 0.16)}
            addedSignColor={t().ok}
            removedSignColor={t().danger}
            lineNumberFg={t().muted}
            addedLineNumberBg={mix(t().bg, t().ok, 0.24)}
            removedLineNumberBg={mix(t().bg, t().danger, 0.24)}
          />
        )}
      </Show>
    </box>
  );
}

/** A delegation call's agents as a live tree: what each is doing, how long, and how it ended. */
function AgentTree(p: { runs: SubagentRun[] }) {
  const t = useTheme();
  const mark = (r: SubagentRun) =>
    r.status === "done" ? (
      <span style={{ fg: t().ok }}>✓</span>
    ) : r.status === "failed" ? (
      <span style={{ fg: t().danger }}>✗</span>
    ) : r.status === "stopped" ? (
      <span style={{ fg: t().warn }}>■</span>
    ) : r.status === "running" ? (
      <Spinner />
    ) : (
      <span style={{ fg: t().muted }}>○</span>
    );
  const doing = (r: SubagentRun) => {
    if (r.status === "running") return r.activity?.[r.activity.length - 1] ?? clip(r.task, 60);
    if (r.status === "failed") return r.error ?? "failed";
    return [r.toolCount !== undefined ? `${r.toolCount} ${r.toolCount === 1 ? "call" : "calls"}` : "", r.durationMs !== undefined ? formatDuration(r.durationMs) : ""].filter(Boolean).join(" · ") || clip(r.task, 60);
  };
  return (
    <box flexDirection="column" paddingLeft={2}>
      <Index each={p.runs}>
        {(r, i) => (
          <text wrapMode="none" truncate>
            <span style={{ fg: t().border }}>{i === p.runs.length - 1 ? "└─ " : "├─ "}</span>
            {mark(r())}
            <b style={{ fg: t().text2 }}>{` ${r().agent}`}</b>
            <span style={{ fg: t().muted }}>{`  ${doing(r())}`}</span>
          </text>
        )}
      </Index>
    </box>
  );
}

/**
 * One call as neat-render draws it:
 *
 *   # the model's remark, when the command opened with one
 *   ● Bash $ npm test                ● Bash · running…
 *     └ exit 2 · 14 lines              └ $ npm test -- --run …
 *
 * An edit shows its first changed lines under the outcome, a delegation its
 * agents as a tree, and a path links to its file. A click frames it.
 */
function ToolRow(p: { item: ToolItem; workspace: string }) {
  const t = useTheme();
  const [open, setOpen] = createSignal(false);
  const row = createMemo(() => neatRow(p.item, p.workspace));
  const preview = createMemo(() => (row().diff ? highlightPreview(row().diff ?? []) : null));
  const running = () => p.item.status === "running";
  const failed = () => p.item.status === "error";
  const bad = (f: string) => failed() || /^(?:[1-9]\d* failed|exit [1-9])/.test(f);
  const factColor = (f: string) => (bad(f) ? t().danger : t().muted);
  // A running command moves to its own wrapped `└ $` lines, so you can read what is executing.
  const wraps = () => running() && p.item.category === "command" && Boolean(row().detail);
  // What it prints meanwhile shows under it, a few lines, until the outcome takes their place.
  const tail = createMemo(() => (running() && p.item.category === "command" ? outputTail(p.item.output, LIVE_LINES) : []));
  // A path in the row is a link to the file (where the terminal supports links).
  const href = () => (p.item.paths[0] ? fileUrl(p.item.paths[0], p.workspace) : null);
  return (
    <box flexDirection="column">
      <Show when={row().note}>
        {(note) => (
          <text fg={t().muted} wrapMode="none" truncate>
            <i>{`# ${note()}`}</i>
          </text>
        )}
      </Show>
      <box flexDirection="column" onMouseDown={() => setOpen(!open())}>
        <text wrapMode="none" truncate>
          <Bullet status={p.item.status} failedOutput={row().failed} category={p.item.category} />
          <b style={{ fg: t().text }}>{row().label}</b>
          <Show when={!wraps()}>
            <Show when={row().detail}>
              {(d) => (
                <Show when={href()} fallback={<span style={{ fg: t().text2 }}>{`${row().glue}${d()}`}</span>}>
                  {(url) => (
                    <a href={url()} style={{ fg: t().text2 }}>
                      {`${row().glue}${d()}`}
                    </a>
                  )}
                </Show>
              )}
            </Show>
          </Show>
          <Show when={running()}>
            <span style={{ fg: t().muted }}> · running…</span>
          </Show>
        </text>
        <Show when={wraps() && row().detail}>
          {(d) => (
            <box flexDirection="row" paddingLeft={2} maxHeight={3} overflow="hidden">
              <text fg={t().muted} flexShrink={0}>
                {"└ "}
              </text>
              <text fg={t().text2} wrapMode="word">
                {d()}
              </text>
            </box>
          )}
        </Show>
        <Show when={tail().length > 0}>
          <box flexDirection="column" paddingLeft={4}>
            <box flexDirection="column" border={["left"]} borderColor={t().border} paddingLeft={1}>
              <Index each={tail()}>
                {(line) => (
                  <text fg={t().muted} wrapMode="none" truncate>
                    {line()}
                  </text>
                )}
              </Index>
            </box>
          </box>
        </Show>
        <Show when={!running() && row().facts.length > 0}>
          <box paddingLeft={2}>
            <text wrapMode="none" truncate>
              <span style={{ fg: t().muted }}>└ </span>
              <Index each={row().facts}>
                {(f, i) => (
                  <>
                    <Show when={i > 0}>
                      <span style={{ fg: t().muted }}> · </span>
                    </Show>
                    {/* A failure is underlined as well as red, so it reads without colour too. */}
                    <Show when={bad(f())} fallback={<span style={{ fg: factColor(f()) }}>{f()}</span>}>
                      <u style={{ fg: factColor(f()) }}>{f()}</u>
                    </Show>
                  </>
                )}
              </Index>
            </text>
          </box>
        </Show>
        <Show when={p.item.subagents?.runs.length}>
          <AgentTree runs={p.item.subagents?.runs ?? []} />
        </Show>
        <Show when={!open() && preview()}>
          {(lines) => (
            <box flexDirection="column" paddingLeft={4}>
              <Index each={lines()}>
                {(l) => {
                  const color = () => (l().marker === "+" ? t().ok : l().marker === "-" ? t().danger : t().muted);
                  // The words that changed stand out on a tinted ground; the rest of a changed line is a softer tone.
                  return (
                    <text wrapMode="none" truncate>
                      <span style={{ fg: color() }}>{`${l().marker} `}</span>
                      <Index each={l().segments}>
                        {(seg) => (
                          <span
                            style={{
                              fg: l().marker === " " ? t().muted : seg().changed ? color() : mix(color(), t().muted, 0.45),
                              bg: seg().changed && l().segments.length > 1 ? mix(t().bg, color(), 0.28) : undefined,
                            }}
                          >
                            {seg().text}
                          </span>
                        )}
                      </Index>
                    </text>
                  );
                }}
              </Index>
              <Show when={row().more}>{(n) => <text fg={t().muted}>{`… ${n()} more`}</text>}</Show>
            </box>
          )}
        </Show>
      </box>
      <Show when={open()}>
        <ToolDetails item={p.item} workspace={p.workspace} />
      </Show>
    </box>
  );
}

/**
 * One call of a tree, neat-render's batch: connector, bullet, verb and target,
 * the outcome at the end of the line (the tree already gives the rows their
 * shape, so there is no `└` line, and no diff under an edit). A running
 * command's last lines, or the call opened by a click, hang on the trunk.
 */
function TreeRow(p: { item: ToolItem; workspace: string; first: boolean; last: boolean }) {
  const t = useTheme();
  const [open, setOpen] = createSignal(false);
  const row = createMemo(() => neatRow(p.item, p.workspace));
  const running = () => p.item.status === "running";
  const bad = (f: string) => p.item.status === "error" || /^(?:[1-9]\d* failed|exit [1-9])/.test(f);
  const tail = createMemo(() => (running() && p.item.category === "command" ? outputTail(p.item.output, LIVE_LINES) : []));
  const href = () => (p.item.paths[0] ? fileUrl(p.item.paths[0], p.workspace) : null);
  // A remark above the call takes the top corner, so the call under it joins the trunk with a tee.
  const fork = () => (p.last ? "└─ " : p.first && !row().note ? "┌─ " : "├─ ");
  return (
    <box flexDirection="column">
      <Show when={row().note}>
        {(note) => (
          <text wrapMode="none" truncate>
            <span style={{ fg: t().border }}>{p.first ? "┌  " : "│  "}</span>
            <i style={{ fg: t().muted }}>{`# ${note()}`}</i>
          </text>
        )}
      </Show>
      <box flexDirection="row" onMouseDown={() => setOpen(!open())}>
        <text flexShrink={1} minWidth={0} wrapMode="none" truncate>
          <span style={{ fg: t().border }}>{fork()}</span>
          <Bullet status={p.item.status} failedOutput={row().failed} category={p.item.category} />
          <b style={{ fg: t().text }}>{row().label}</b>
          <Show when={row().detail}>
            {(d) => (
              <Show when={href()} fallback={<span style={{ fg: t().link }}>{` ${d()}`}</span>}>
                {(url) => (
                  <a href={url()} style={{ fg: t().link }}>
                    {` ${d()}`}
                  </a>
                )}
              </Show>
            )}
          </Show>
          <Show when={running()}>
            <span style={{ fg: t().muted }}> · running…</span>
          </Show>
        </text>
        <Show when={!running() && row().facts.length > 0}>
          <box flexGrow={1} minWidth={2} />
          <text flexShrink={0} wrapMode="none">
            <Index each={row().facts}>
              {(f, i) => (
                <>
                  <Show when={i > 0}>
                    <span style={{ fg: t().muted }}> · </span>
                  </Show>
                  <Show when={bad(f())} fallback={<span style={{ fg: t().muted }}>{f()}</span>}>
                    <u style={{ fg: t().danger }}>{f()}</u>
                  </Show>
                </>
              )}
            </Index>
          </text>
        </Show>
      </box>
      <Show when={tail().length > 0 || open()}>
        <box flexDirection="column" border={p.last ? [] : ["left"]} borderColor={t().border} paddingLeft={p.last ? 3 : 2}>
          <Index each={tail()}>
            {(line) => (
              <text fg={t().muted} wrapMode="none" truncate>
                {line()}
              </text>
            )}
          </Index>
          <Show when={open()}>
            <ToolDetails item={p.item} workspace={p.workspace} />
          </Show>
        </box>
      </Show>
    </box>
  );
}

function Notice(p: { item: NoticeItem }) {
  const t = useTheme();
  const color = () => (p.item.level === "error" ? t().danger : p.item.level === "warning" ? t().warn : t().info);
  const text = () => (p.item.detail ? (p.item.title ?? p.item.text) : p.item.text);
  return (
    <text fg={color()} wrapMode="word">
      {p.item.level === "info" ? "ℹ " : "! "}
      <Show when={p.item.level === "error"} fallback={<span style={{ fg: p.item.level === "info" ? t().muted : color() }}>{text()}</span>}>
        <u style={{ fg: color() }}>{text()}</u>
      </Show>
    </text>
  );
}

function Request(p: { item: RequestItem }) {
  const t = useTheme();
  const denied = () => /Denied|Cancelled|Dismissed/.test(p.item.outcome ?? "");
  return (
    <text fg={p.item.outcome ? (denied() ? t().warn : t().muted) : t().warn} wrapMode="word">
      {p.item.outcome ? (denied() ? "✗ " : "✓ ") : "? "}
      <span style={{ fg: t().text2 }}>{clip(p.item.request.title, 80)}</span>
      <span style={{ fg: t().muted }}>{` → ${p.item.outcome ?? "waiting for you"}`}</span>
    </text>
  );
}

/** One item of the work. `thoughtOnly`: an assistant item's text is a reply drawn after the fold, so only its thought is here. */
function ProcessItem(p: { item: ChatItem; workspace: string; thoughtOnly?: boolean }) {
  const t = useTheme();
  return (
    <Switch>
      <Match when={p.item.kind === "tool" && (p.item as ToolItem)}>{(item) => <ToolRow item={item()} workspace={p.workspace} />}</Match>
      <Match when={p.item.kind === "assistant" && (p.item as AssistantItem)}>
        {(item) => (
          <box flexDirection="column">
            <Show when={item().thinking.trim()}>
              <Thought item={item()} />
            </Show>
            <Show when={!p.thoughtOnly && saysSomething(item().text)}>
              <Md text={item().text} streaming={item().streaming} fg={t().text2} />
            </Show>
          </box>
        )}
      </Match>
      <Match when={p.item.kind === "notice" && (p.item as NoticeItem)}>{(item) => <Notice item={item()} />}</Match>
      <Match when={p.item.kind === "request" && (p.item as RequestItem)}>{(item) => <Request item={item()} />}</Match>
    </Switch>
  );
}

type Place = "first" | "middle" | "last";

/** The fold's line. `fade` (0 to 1), just after the turn ends: its words come up from the background. */
function Fold(p: { turn: Turn; open: boolean; onToggle: () => void; part?: { counts: Turn["counts"]; place: Place }; fade?: number }) {
  const t = useTheme();
  const live = () => p.turn.live && (!p.part || p.part.place === "last");
  const label = () => {
    void tick();
    return foldLabel(p.turn, Date.now(), p.part);
  };
  const thought = () => (live() && !p.open ? latestThought(p.turn) : null);
  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row" onMouseDown={p.onToggle}>
        <text fg={p.fade === undefined ? t().muted : mix(t().bg, t().muted, p.fade)}>
          <Show when={live()} fallback={`${p.open ? "▾ " : "▸ "}${label()}`}>
            <Spinner />
            {" "}
            <Shimmer text={label()} />
          </Show>
        </text>
      </box>
      <Show when={thought()}>
        {(line) => (
          <box paddingLeft={2}>
            <text fg={t().muted} wrapMode="word">
              {`✻ ${line()}`}
            </text>
          </box>
        )}
      </Show>
    </box>
  );
}

/** How long a finished turn's flash lasts, and a frame of it. */
const FLASH_MS = 900;
const FLASH_FRAME_MS = 40;

/** Frames a fold takes to unroll, and how long each lasts. */
const UNROLL_FRAMES = 4;
const UNROLL_MS = 35;

/**
 * Some work's items, the answer's own thought at `answerAt` (where the answer
 * came, before any work that followed it). Opened, they unroll over a few
 * frames rather than appear at once; rows that arrive later, as a run goes on,
 * just appear.
 */
function WorkItems(p: { items: ChatItem[]; answerAt: number; answer: AssistantItem | null; workspace: string; thoughtOnly?: boolean }) {
  const rows = createMemo(() => {
    const cut = p.answerAt < 0 ? p.items.length : p.answerAt;
    const thought = p.answerAt >= 0 && p.answer?.thinking.trim() ? [{ thought: p.answer }] : [];
    const rows: Array<{ item: ChatItem } | { thought: AssistantItem }> = [...p.items.slice(0, cut).map((item) => ({ item })), ...thought, ...p.items.slice(cut).map((item) => ({ item }))];
    return rows;
  });
  const steps = unrollCounts(rows().length, UNROLL_FRAMES);
  const [shown, setShown] = createSignal(steps[0] ?? 0);
  let step = 0;
  const timer = setInterval(() => {
    if (++step >= steps.length) {
      clearInterval(timer);
      setShown(Number.POSITIVE_INFINITY);
    } else setShown(steps[step] as number);
  }, UNROLL_MS);
  onCleanup(() => clearInterval(timer));
  type Row = { item: ChatItem } | { thought: AssistantItem };
  // Calls one after another hang off one tree, neat-render's way; anything else stands alone.
  const runs = createMemo(() => workRuns<Row>(rows().slice(0, shown()), (row) => ("item" in row && row.item.kind === "tool" ? row.item : null)));
  return (
    <box flexDirection="column" marginTop={1}>
      <Index each={runs()}>
        {(run, n) => (
          <Switch>
            <Match when={run().kind === "tree" && (run() as Extract<WorkRun<Row>, { kind: "tree" }>).calls}>
              {(calls) => (
                <box flexDirection="column">
                  <Index each={calls()}>{(call, i) => <TreeRow item={call()} workspace={p.workspace} first={i === 0} last={i === calls().length - 1} />}</Index>
                </box>
              )}
            </Match>
            <Match when={run().kind === "one" && (run() as Extract<WorkRun<Row>, { kind: "one" }>).row}>
              {(row) => (
                <Switch>
                  {/* The answer's own reasoning belongs to the answer: a blank line keeps it off the work above. */}
                  <Match when={"thought" in row() && (row() as { thought: AssistantItem }).thought}>
                    {(answer) => (
                      <box marginTop={n > 0 ? 1 : 0}>
                        <Thought item={answer()} />
                      </box>
                    )}
                  </Match>
                  <Match when={"item" in row() && (row() as { item: ChatItem }).item}>{(item) => <ProcessItem item={item()} workspace={p.workspace} thoughtOnly={p.thoughtOnly} />}</Match>
                </Switch>
              )}
            </Match>
          </Switch>
        )}
      </Index>
    </box>
  );
}

/**
 * A turn whose agent wrote replies between its tool calls, in the order it
 * happened: each stretch of work in its own fold (one that is only thinking
 * sits inline), each reply after it, as the web UI draws it. While the turn
 * runs on after a reply, a live fold follows for what comes next.
 */
function SegmentedWork(p: { turn: Turn; segments: WorkSegment[]; open: boolean; onToggle: () => void; workspace: string; fade?: number }) {
  const t = useTheme();
  const all = createMemo(() => {
    // A live fold follows the last reply for what comes next — unless the work after the answer
    // already owns the spinner below it.
    const ended = p.segments[p.segments.length - 1]?.reply != null;
    return p.turn.live && ended && p.turn.workAfter.length === 0 ? [...p.segments, { key: `${p.turn.id}#live`, items: [], reply: null, counts: {}, answerAt: -1 }] : p.segments;
  });
  const live = (n: number) => p.turn.live && n === all().length - 1 && p.turn.workAfter.length === 0;
  const shape = (n: number) => {
    const s = all()[n] as WorkSegment;
    return s.items.length === 0 && !live(n) ? "none" : s.items.every((item) => item.kind === "assistant") && !live(n) ? "thought" : "fold";
  };
  // The first fold carries how long the turn took, the live one the spinner.
  const firstFold = () => all().findIndex((_, n) => shape(n) === "fold");
  const place = (n: number): Place => (live(n) ? "last" : n === firstFold() ? "first" : "middle");
  return (
    <Index each={all()}>
      {(segment, n) => (
        <>
          <Switch>
            <Match when={shape(n) === "thought"}>
              <WorkItems items={segment().items} answerAt={segment().answerAt} answer={p.turn.answer} workspace={p.workspace} thoughtOnly />
            </Match>
            <Match when={shape(n) === "fold"}>
              <Show when={!p.open || live(n)}>
                <Fold turn={p.turn} open={p.open} onToggle={p.onToggle} part={{ counts: segment().counts, place: place(n) }} fade={p.fade} />
              </Show>
              <Show when={p.open && segment().items.length > 0}>
                <WorkItems items={segment().items} answerAt={segment().answerAt} answer={p.turn.answer} workspace={p.workspace} thoughtOnly />
              </Show>
            </Match>
          </Switch>
          <Show when={segment().reply}>
            {(reply) => (
              <box flexDirection="column" marginTop={1}>
                <Md text={reply().text} streaming={reply().streaming} fg={t().text} />
              </box>
            )}
          </Show>
        </>
      )}
    </Index>
  );
}

/** The answer, neat-render's: its first line marked with the accent `●` once it is written, the rest in the same two-column gutter. */
function Answer(p: { item: AssistantItem }) {
  const t = useTheme();
  return (
    <box flexDirection="column" marginTop={1}>
      <Show when={p.item.text.trim()}>
        <box flexDirection="row">
          <text flexShrink={0} fg={t().accent}>
            {p.item.streaming ? "  " : "● "}
          </text>
          <box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Md text={p.item.text} streaming={p.item.streaming} fg={t().text} />
          </box>
        </box>
      </Show>
      <Show when={p.item.error && p.item.error !== "Stopped"}>
        <text fg={t().danger} wrapMode="word">
          {"✗ "}
          <u>{p.item.error}</u>
        </text>
      </Show>
      <Show when={p.item.error === "Stopped"}>
        <text fg={t().warn}>■ Stopped</text>
      </Show>
    </box>
  );
}

function TurnView(p: { turn: Accessor<Turn>; workspace: string; open: boolean; onToggle: () => void; switchedTo: string | null; column: number }) {
  const t = useTheme();
  const hasProcess = () => p.turn().process.length > 0 || Boolean(p.turn().answer?.thinking.trim());
  // Work the agent did after writing its reply draws below it, as its own fold.
  const afterWork = () => workAfterSegment(p.turn());
  const segments = createMemo(() => workSegments(p.turn()));
  const split = () => segments().some((s) => s.reply);
  // A run that ends while you watch: the prompt's edge flashes in the harness's colour once, and "Worked for" comes up.
  const [since, setSince] = createSignal<number | null>(null);
  let flashTimer: ReturnType<typeof setInterval> | undefined;
  createEffect(
    on(
      () => p.turn().live,
      (live, was) => {
        if (!was || live) return;
        clearInterval(flashTimer);
        const start = Date.now();
        setSince(0);
        flashTimer = setInterval(() => {
          const k = (Date.now() - start) / FLASH_MS;
          if (k >= 1) {
            clearInterval(flashTimer);
            setSince(null);
          } else setSince(k);
        }, FLASH_FRAME_MS);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearInterval(flashTimer));
  const glow = () => (since() === null ? 0 : flashAt(since() as number));
  const fade = () => (since() === null ? undefined : easeOut(Math.min(1, (since() as number) * 2.5)));
  const files = () => p.turn().changedFiles.map((f) => relativePath(f, p.workspace));
  // A finished turn closes with what it did, neat-render's Σ line: calls, time, reasoning, failures.
  const sigma = createMemo(() => sigmaFacts(p.turn()));
  const sigmaShown = () => p.open && !p.turn().live && Boolean(p.turn().prompt) && (sigma().facts.length > 0 || sigma().failed !== null);
  const FILES_SHOWN = 4;
  return (
    <box flexDirection="column" width="100%" maxWidth={p.column}>
      <Show when={p.switchedTo}>
        {(name) => (
          <box flexDirection="row" marginTop={1}>
            <text fg={t().muted}>{`──── Switched to ${name()} ────`}</text>
          </box>
        )}
      </Show>
      <Show when={p.turn().prompt}>{(prompt) => <UserPrompt item={prompt()} glow={glow()} through={p.turn().through} />}</Show>
      <Show
        when={split()}
        fallback={
          <Show when={hasProcess() || p.turn().live}>
            {/* Shown work needs no line over it (neat-render folds nothing); a folded turn, or one still working, has one. */}
            <Show when={!p.open || p.turn().live}>
              <Fold turn={p.turn()} open={p.open} onToggle={p.onToggle} part={afterWork() ? { counts: workCounts(p.turn().process), place: "first" } : undefined} fade={fade()} />
            </Show>
            <Show when={p.open}>
              <WorkItems items={p.turn().process} answerAt={p.turn().answerAt} answer={p.turn().answer} workspace={p.workspace} />
            </Show>
          </Show>
        }
      >
        <SegmentedWork turn={p.turn()} segments={segments()} open={p.open} onToggle={p.onToggle} workspace={p.workspace} fade={fade()} />
      </Show>
      <Show when={p.turn().answer}>{(a) => <Answer item={a()} />}</Show>
      <Show when={afterWork()}>
        {(segment) => (
          <>
            <Show when={!p.open || p.turn().live}>
              <Fold turn={p.turn()} open={p.open} onToggle={p.onToggle} part={{ counts: segment().counts, place: "last" }} fade={fade()} />
            </Show>
            <Show when={p.open}>
              <WorkItems items={segment().items} answerAt={-1} answer={null} workspace={p.workspace} />
            </Show>
          </>
        )}
      </Show>
      <For each={p.turn().errors}>{(item) => <Notice item={item} />}</For>
      <Show when={sigmaShown()}>
        <box marginTop={1}>
          <text fg={t().muted} wrapMode="word">
            <span style={{ fg: t().muted }}>{"Σ "}</span>
            {sigma().facts.join(" · ")}
            <Show when={sigma().failed}>
              {(failed) => (
                <>
                  {sigma().facts.length > 0 ? " · " : ""}
                  <span style={{ fg: t().danger }}>{failed()}</span>
                </>
              )}
            </Show>
          </text>
        </box>
      </Show>
      <Show when={files().length > 0 && !p.turn().live}>
        <box marginTop={sigmaShown() ? 0 : 1}>
          <text fg={t().muted} wrapMode="word">
            <span style={{ fg: t().ok }}>{"✎ "}</span>
            {`Changed ${files().length} ${files().length === 1 ? "file" : "files"} · `}
            {/* Each name is a link to its file, where the terminal has links. */}
            <Index each={files().slice(0, FILES_SHOWN)}>
              {(f, i) => (
                <>
                  <Show when={i > 0}>{", "}</Show>
                  <a href={fileUrl(f(), p.workspace)} style={{ fg: t().text2 }}>
                    {f()}
                  </a>
                </>
              )}
            </Index>
            <Show when={files().length > FILES_SHOWN}>
              <span style={{ fg: t().text2 }}>{` +${files().length - FILES_SHOWN}`}</span>
            </Show>
          </text>
        </box>
      </Show>
      <For each={p.turn().after}>{(item) => <Notice item={item} />}</For>
    </box>
  );
}

interface Geometry {
  /** Where each turn starts, in lines from the top of the transcript. */
  tops: number[];
  content: number;
  top: number;
  height: number;
}

const sameGeometry = (a: Geometry, b: Geometry) => a.content === b.content && a.top === b.top && a.height === b.height && a.tops.length === b.tops.length && a.tops.every((v, i) => v === b.tops[i]);

/** The gutter: a tick per turn in its tone, the visible stretch as a brighter track; a click jumps there. */
function Minimap(p: { geometry: Geometry; tones: TurnTone[]; onJump: (to: number) => void }) {
  const t = useTheme();
  const cells = createMemo(() =>
    minimapCells(
      p.geometry.tops.map((top, i) => ({ top, tone: p.tones[i] ?? "plain" })),
      p.geometry.content,
      p.geometry.top,
      p.geometry.height,
      p.geometry.height,
    ),
  );
  const toneColor = (tone: TurnTone) => ({ live: t().accent, failed: t().danger, edited: t().ok, rendered: t().thinking, plain: t().text2 })[tone];
  return (
    <box flexDirection="column" width={1} flexShrink={0}>
      <Index each={cells()}>
        {(cell, row) => (
          <text
            fg={cell().tone ? toneColor(cell().tone as TurnTone) : cell().inView ? mix(t().muted, t().text, 0.35) : t().border}
            onMouseDown={() => p.onJump(rowToScroll(row, cells().length, p.geometry.content, p.geometry.height))}
          >
            {cell().tone ? (cell().tone === "live" ? "◆" : "●") : cell().inView ? "┃" : "│"}
          </text>
        )}
      </Index>
    </box>
  );
}

export function Transcript(p: { ref?: (el: unknown) => void; showWork: boolean; column: Accessor<number> }) {
  const app = useAtui();
  const t = useTheme();
  const turns = createMemo(() => {
    const c = app.chat();
    return c ? buildTurns(c.items, c.status) : [];
  });
  const switches = createMemo(() => modelSwitches(turns()));
  const [overrides, setOverrides] = createSignal<Record<string, boolean>>({});
  // Opening or folding every turn (C-x e, vim's zR/zM) wins over turns opened or folded one by one.
  createEffect(on(() => p.showWork, () => setOverrides({}), { defer: true }));
  const isOpen = (turn: Turn) => overrides()[turn.id] ?? (p.showWork || turn.live);
  const workspace = () => app.chat()?.workspace.path ?? "";
  const models = () => app.chat()?.config.models ?? [];

  // Where the turns are and what is on screen, read on the clock: the gutter and the pinned prompt follow it.
  let scroller: ScrollBoxRenderable | undefined;
  const [geometry, setGeometry] = createSignal<Geometry>({ tops: [], content: 0, top: 0, height: 0 }, { equals: sameGeometry });
  createEffect(
    on(tick, () => {
      if (!scroller) return;
      const base = scroller.content.y;
      setGeometry({
        tops: scroller.content.getChildren().map((c) => (c as { y: number }).y - base),
        content: scroller.scrollHeight,
        top: scroller.scrollTop,
        height: scroller.viewport.height,
      });
    }),
  );
  const tones = createMemo(() => turns().map(turnTone));
  const scrollable = () => geometry().content > geometry().height + 1;
  const pinned = createMemo(() => {
    const at = pinnedTurn(geometry().tops, geometry().top);
    return at === null ? null : (turns()[at]?.prompt ?? null);
  });

  return (
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" flexGrow={1}>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => {
            scroller = el;
            p.ref?.(el);
          }}
          flexGrow={1}
          stickyScroll
          stickyStart="bottom"
          paddingLeft={2}
          paddingRight={2}
          paddingBottom={1}
          contentOptions={{ alignItems: "center" }}
          verticalScrollbarOptions={{ visible: false }}
        >
          <Index each={turns()}>
            {(turn) => (
              <TurnView
                turn={turn}
                workspace={workspace()}
                open={isOpen(turn())}
                onToggle={() => setOverrides((o) => ({ ...o, [turn().id]: !isOpen(turn()) }))}
                switchedTo={switches().has(turn().id) ? modelName(switches().get(turn().id) as string, models()) : null}
                column={p.column()}
              />
            )}
          </Index>
        </scrollbox>
        <Show when={pinned()}>
          {(prompt) => (
            <box position="absolute" top={0} left={0} width="100%" flexDirection="row" justifyContent="center" backgroundColor={app.glass() ? undefined : t().bg} zIndex={5}>
              <box width="100%" maxWidth={p.column()} paddingLeft={2} paddingRight={2} flexDirection="row">
                <text fg={t().muted} wrapMode="none" truncate>
                  <span style={{ fg: t().ok }}>{"↑ "}</span>
                  {clip(prompt().text, p.column())}
                </text>
              </box>
            </box>
          )}
        </Show>
      </box>
      <Show when={scrollable()}>
        <Minimap geometry={geometry()} tones={tones()} onJump={(to) => glideTo(scroller, to)} />
      </Show>
    </box>
  );
}
