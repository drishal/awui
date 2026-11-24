// The agent dashboard (the web UI's Agents board, in a terminal): every session in three columns —
// Needs you, Working, Done — with a delegated child nested under the parent it runs for. The
// grouping is web/dashboard.ts's (boardCards), so a card sits in the same column in both clients;
// this file draws it and maps Enter to opening the chat. C-x k opens it. ←/→ a column, ↑/↓ a card,
// Enter opens the chat, f narrows to one project, r to a pull-request state, Esc closes.
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { SessionPreview } from "../../shared/protocol.js";
import { previewLine } from "../../web/preview-line.js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { ProjectSession, SessionsOverview } from "../../shared/protocol.js";
import {
  BOARD_COLUMNS,
  BOARD_EMPTY,
  BOARD_TITLES,
  boardCards,
  boardCounts,
  boardProjects,
  childHost,
  PR_FILTERS,
  PR_FILTER_LABELS,
  prBadge,
  prStateOf,
  type BoardCard,
  type BoardColumn,
  type PrFilter,
  type PrState,
  type PullRequestShape,
} from "../../web/dashboard.js";
import { isBusy } from "../../web/session-groups.js";
import { plainTitle } from "../../web/plain-title.js";
import { fitHints } from "../footer.js";
import { agentStatusText } from "../../web/agent-status.js";
import { ago, clip } from "../format.js";
import { workerRow } from "../worker-row.js";
import { harnessGlyph } from "../neat.js";
import { moveRow } from "../delegated.js";
import { accentOf } from "../theme.js";
import { useAtui, useTheme } from "./context.js";

/** How many projects' pull requests are read when the board opens: gh is slow and a badge is decoration. */
const PR_READS = 8;
/** Rows the selected card's detail takes under the columns: its rule, title line, prompt, up to three of the answer, and its files. */
const DETAIL_ROWS = 8;

/** One column's cards, the cursor kept inside the column's own list. */
const clampCursor = (cards: BoardCard[], at: number): number => (cards.length === 0 ? 0 : Math.min(at, cards.length - 1));

export function BoardView(p: { onClose: () => void; onOpenSession: (s: ProjectSession) => void; side?: number }) {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const harnessName = (id: string) => app.boot()?.harnesses.find((h) => h.id === id)?.displayName ?? id;
  const harnessAccent = (id: string) => accentOf(t(), app.boot()?.harnesses.find((h) => h.id === id)?.accent);
  const projectName = (id: string) => app.overview().workspaces.find((w) => w.id === id)?.name ?? "";

  const [project, setProject] = createSignal<string | null>(null);
  const [pr, setPr] = createSignal<PrFilter>("any");
  const [prs, setPrs] = createSignal<Record<string, PullRequestShape | null>>({});
  const [column, setColumn] = createSignal<BoardColumn>("needs");
  const [cursor, setCursor] = createSignal(0);
  const [note, setNote] = createSignal<string | null>(null);
  /** The sessions are being read: an empty board says so rather than claiming nothing is running. */
  const [reading, setReading] = createSignal(true);

  const overview = (): SessionsOverview => app.overview();
  const projects = createMemo(() => boardProjects(overview()));
  const prStates = createMemo(() => {
    const out: Record<string, PrState> = {};
    for (const [id, value] of Object.entries(prs())) out[id] = prStateOf(value);
    return out;
  });
  const cards = createMemo(() => boardCards(overview(), { project: project(), pr: pr(), prStates: prStates(), working: (s) => isBusy(s.status) }));
  const counts = createMemo(() => boardCounts(cards()));
  const here = (): BoardCard | undefined => cards()[column()][clampCursor(cards()[column()], cursor())];
  // The card under the cursor says what its session last said (the web dashboard's card line), read once per version of the session.
  const [previews, setPreviews] = createSignal<Record<string, SessionPreview | null>>({});
  const readPreview = (s: ProjectSession) => {
    const key = `${s.id}@${s.updatedAt ?? ""}`;
    if (key in previews()) return;
    setPreviews((all) => ({ ...all, [key]: null }));
    const q = new URLSearchParams({ harnessId: s.harnessId, workspaceId: s.workspaceId, sessionId: s.id });
    void app.server.call<SessionPreview>(`/api/sessions/preview?${q}`).then((r) => setPreviews((all) => ({ ...all, [key]: r }))).catch(() => undefined);
  };
  // The cursor's card and its delegated workers: the card's detail line and each worker's model ("which seat runs what").
  createEffect(() => {
    const card = here();
    if (!card) return;
    readPreview(card.session);
    for (const child of card.children) readPreview(child);
  });
  // Every worker row shows its model, so the others' are read too (cached per version, bounded).
  createEffect(() => {
    let left = 24;
    for (const column of Object.values(cards())) for (const card of column) for (const child of card.children) if (left-- > 0) readPreview(child);
  });
  const previewOf = (s: ProjectSession): SessionPreview | null => previews()[`${s.id}@${s.updatedAt ?? ""}`] ?? null;
  const full = () => {
    const s = here()?.session;
    return s ? previewOf(s) : null;
  };
  const preview = () => previewLine(full());
  /** What the card's session last said, as one line (the detail wraps it to at most three rows). */
  const said = () => (full()?.answer ? previewLine({ ...(full() as SessionPreview), prompt: null }) ?? "—" : full() ? "No answer yet" : "");

  onMount(() => {
    void app.refreshSessions().finally(() => setReading(false));
    // Each project's pull request, once: a failure leaves the project without one, which reads as
    // "no pull request", as the browser's badge does.
    const wanted = projects().slice(0, PR_READS).map((w) => w.id);
    void (async () => {
      const read: Record<string, PullRequestShape | null> = {};
      for (const id of wanted) {
        read[id] = await app.server.call<{ pr: PullRequestShape | null }>(`/api/workspaces/${id}/github/pr`).then((a) => a.pr, () => null);
      }
      setPrs(read);
    })();
  });

  // The cursor starts on the first column that holds something, so Enter opens a card at once.
  let placed = false;
  createEffect(() => {
    if (placed) return;
    const all = cards();
    const first = BOARD_COLUMNS.find((id) => all[id].length > 0);
    if (!first) return;
    placed = true;
    setColumn(first);
    setCursor(0);
  });

  // A card that finishes while the board is open leaves the column the cursor stood in: when that column empties, the cursor follows to the first one that holds something instead of standing on nothing.
  let heldHere = 0;
  createEffect(() => {
    const all = cards();
    const now = (all[column()] ?? []).length;
    const emptied = heldHere > 0 && now === 0;
    heldHere = now;
    if (!emptied) return;
    const first = BOARD_COLUMNS.find((id) => all[id].length > 0);
    if (first) {
      setColumn(first);
      setCursor(0);
    }
  });

  /** A filter change can empty the column the cursor stood in: it moves to the first column that still has a
      card, so Enter always has one to open. */
  const reclamp = () => {
    const all = cards();
    if ((all[column()] ?? []).length === 0) {
      const first = BOARD_COLUMNS.find((id) => all[id].length > 0);
      if (first) setColumn(first);
    }
    setCursor(0);
  };
  const cycleProject = () => {
    const list: Array<string | null> = [null, ...projects().map((w) => w.id)];
    const next = list[(list.indexOf(project()) + 1) % list.length] ?? null;
    setProject(next);
    reclamp();
    setNote(null);
  };
  const cyclePr = () => {
    const next = PR_FILTERS[(PR_FILTERS.indexOf(pr()) + 1) % PR_FILTERS.length] ?? "any";
    setPr(next);
    reclamp();
    setNote(null);
  };
  const step = (by: 1 | -1) => {
    const i = BOARD_COLUMNS.indexOf(column()) + by;
    const next = BOARD_COLUMNS[Math.max(0, Math.min(BOARD_COLUMNS.length - 1, i))] as BoardColumn;
    setColumn(next);
    setCursor(clampCursor(cards()[next], cursor()));
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    key.preventDefault();
    if (key.name === "escape" || key.name === "q") return p.onClose();
    if (key.name === "left" || key.name === "h") return step(-1);
    if (key.name === "right" || key.name === "l") return step(1);
    if (key.name === "up" || key.name === "k") return setCursor((i) => moveRow(cards()[column()].length, i, -1));
    if (key.name === "down" || key.name === "j") return setCursor((i) => moveRow(cards()[column()].length, i, 1));
    if (key.name === "f") return cycleProject();
    if (key.name === "r") return cyclePr();
    if (key.name === "return") {
      const card = here();
      if (card) return p.onOpenSession(card.session);
      return setNote("Nothing in this column to open");
    }
  });

  const width = () => Math.max(30, size().width - (p.side ?? 0) - 4);
  /** The columns share the frame's whole inside: two of a third each, the last the rest, so the cards end where the head does. */
  const columnWidth = (last: boolean) => Math.max(18, last ? width() - 2 * Math.floor(width() / 3) : Math.floor(width() / 3));
  /** Lines a card takes: its title and meta, an agent's status, a pull request, a child per line, and the blank line above it. */
  const cardLines = (card: BoardCard) => 3 + (card.session.agentStatus ? 1 : 0) + (prBadge(card.session, prs() ? { [card.session.workspaceId]: prs()[card.session.workspaceId] ?? null } : undefined) ? 1 : 0) + card.children.length;
  /** The cards a column draws: from the first that keeps the cursor's card in view, as many as the frame's inside holds, leaving a line for "earlier" and "more". */
  const windowOf = (list: readonly BoardCard[], cur: number) => {
    const budget = Math.max(3, boxHeight() - 8 - DETAIL_ROWS);
    const span = (from: number, to: number) => list.slice(from, to).reduce((n, c) => n + cardLines(c), 0);
    let from = 0;
    while (from < cur && span(from, cur + 1) > budget) from++;
    let to = from;
    while (to < list.length && span(from, to + 1) <= budget) to++;
    return { from, to: Math.max(to, Math.min(list.length, cur + 1)) };
  };
  // Each filter wears the key that changes it (f, r), so narrowing the board is findable without the key line, which drops hints on a narrow pane.
  const filterLine = () => `f ${project() ? projectName(project() as string) : `Every project (${counts().needs + counts().working + counts().done})`} · r ${PR_FILTER_LABELS[pr()]}`;
  /** The frame takes the room the sheet stands in: the columns above, the selected card's detail under them, so the pane is one surface and not a small box over blank rows. */
  const boxHeight = () => Math.max(9 + DETAIL_ROWS, size().height - 7);

  return (
    <box
      /* A full-pane view like Review, Git and GitHub: its own header row and no frame, so there is no box floating over blank rows. */
      flexGrow={1}
      flexDirection="column"
      backgroundColor={app.glass() ? undefined : t().bg}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text flexGrow={1} fg={t().muted} wrapMode="none" truncate>
          <b style={{ fg: t().text }}>Agents</b>
          {`   ${filterLine()}`}
        </text>
        <text flexShrink={0} marginLeft={2} fg={note() ? t().warn : t().muted} wrapMode="none" truncate>
          {note() ?? fitHints(["↑↓ card", "Enter open", "←→ column", "Esc close"], width() - 15 - filterLine().length)}
        </text>
      </box>
      <box flexDirection="row" flexShrink={0} overflow="hidden" marginTop={1}>
        <For each={BOARD_COLUMNS}>
          {(id) => {
            const columnCards = () => cards()[id];
            const active = () => column() === id;
            const at = () => (active() ? clampCursor(columnCards(), cursor()) : -1);
            const win = () => windowOf(columnCards(), Math.max(0, at()));
            return (
              <box flexDirection="column" width={columnWidth(id === BOARD_COLUMNS[BOARD_COLUMNS.length - 1])} flexShrink={0} paddingRight={1}>
                <text flexShrink={0} fg={active() ? (id === "needs" && counts()[id] > 0 ? t().warn : t().accent) : t().muted} wrapMode="none" truncate>
                  <b>{BOARD_TITLES[id]}</b>
                  <span style={{ fg: t().muted }}>{` ${counts()[id]}`}</span>
                </text>
                <Show when={columnCards().length > 0} fallback={<text flexShrink={0} fg={t().muted} wrapMode="word">{reading() ? "Reading this server's sessions…" : BOARD_EMPTY[id]}</text>}>
                  <box flexDirection="column" overflow="hidden">
                    <Show when={win().from > 0}>
                      <text flexShrink={0} fg={t().muted}>{`${win().from} earlier`}</text>
                    </Show>
                    <For each={columnCards().slice(win().from, win().to)}>
                      {(card, k) => {
                        const i = () => win().from + k();
                        return (
                        <box flexDirection="column" flexShrink={0} marginTop={i() === 0 ? 0 : 1} backgroundColor={i() === at() ? t().selection : undefined} onMouseDown={() => { setColumn(id); setCursor(i()); }}>
                          <text wrapMode="none" truncate>
                            <span style={{ fg: i() === at() ? t().accent : t().border }}>{i() === at() ? "▌" : " "}</span>
                            <span style={{ fg: harnessAccent(card.session.harnessId) }}>{`${harnessGlyph(card.session.harnessId)} `}</span>
                            <span style={{ fg: card.session.asking ? t().warn : isBusy(card.session.status) ? t().accent : card.session.liveChatId ? t().ok : t().muted }}>{card.session.asking ? "▲ " : "● "}</span>
                            <b>{plainTitle(card.session.title) || "Untitled"}</b>
                          </text>
                          <text fg={i() === at() ? t().text2 : t().muted} wrapMode="none" truncate>
                            {`     ${projectName(card.session.workspaceId)} · ${card.session.updatedAt ? ago(card.session.updatedAt) : ""}${card.session.asking ? " · needs you" : ""}${card.session.origin === "agent" ? ` · ${card.session.lineage?.role ? `delegated as ${card.session.lineage.role}` : "delegated"}` : ""}`}
                          </text>
                          <Show when={card.session.agentStatus}>
                            {(status) => <text fg={t().text2} wrapMode="none" truncate>{`     ${agentStatusText(status())}`}</text>}
                          </Show>
                          <Show when={prBadge(card.session, prs() ? { [card.session.workspaceId]: prs()[card.session.workspaceId] ?? null } : undefined)}>
                            {(badge) => <text fg={t().link} wrapMode="none" truncate>{`   ${badge().words}`}</text>}
                          </Show>
                          <For each={card.children}>
                            {(child) => {
                              // The row is measured, not left to the renderer's middle cut: the title clips at its end and the extras leave whole.
                              const state = () => (child.asking ? " needs you" : isBusy(child.status) ? " working" : "");
                              const parts = () => workerRow({ title: plainTitle(child.lineage?.taskTitle || child.title) || "Untitled", role: child.lineage?.role, host: childHost(child), model: previewOf(child)?.model, state: state() }, columnWidth(id === BOARD_COLUMNS[BOARD_COLUMNS.length - 1]) - 1 - 7);
                              const quiet = () => (i() === at() ? t().text2 : t().muted);
                              return (
                                <text wrapMode="none" truncate onMouseDown={() => p.onOpenSession(child)}>
                                  <span style={{ fg: i() === at() ? t().text2 : t().border }}>{"   └ "}</span>
                                  <span style={{ fg: child.asking ? t().warn : isBusy(child.status) ? t().accent : child.liveChatId ? t().ok : t().muted }}>{child.asking ? "▲ " : "● "}</span>
                                  <Show when={parts().host}>{(host) => <span style={{ fg: quiet() }}>{host()}</span>}</Show>
                                  <Show when={parts().model}>{(model) => <span style={{ fg: quiet() }}>{`${parts().host ? " · " : ""}${model()}`}</span>}</Show>
                                  <Show when={parts().role}>{(role) => <span style={{ fg: t().text2 }}>{`${parts().host || parts().model ? " · " : ""}${role()}`}</span>}</Show>
                                  <Show when={parts().title}>{(title) => <span style={{ fg: quiet() }}>{`${parts().role || parts().host || parts().model ? " · " : ""}${title()}`}</span>}</Show>
                                  <Show when={state()} fallback={<span style={{ fg: t().ok }}>{" ✓"}</span>}>
                                    <span style={{ fg: child.asking ? t().warn : t().accent }}>{state()}</span>
                                  </Show>
                                </text>
                              );
                            }}
                          </For>
                        </box>
                        );
                      }}
                    </For>
                    <Show when={columnCards().length > win().to}>
                      <text flexShrink={0} fg={t().muted}>{`${columnCards().length - win().to} more`}</text>
                    </Show>
                  </box>
                </Show>
              </box>
            );
          }}
        </For>
      </box>
      <box flexShrink={0} marginTop={1} height={DETAIL_ROWS} flexDirection="column" border={["top"]} borderColor={t().border} overflow="hidden">
        <Show when={here()} fallback={<text fg={t().muted}>No card under the cursor</text>}>
          {(card) => (
            <>
              <text wrapMode="none" truncate>
                <b style={{ fg: t().text }}>{plainTitle(card().session.title) || "Untitled"}</b>
                <span style={{ fg: t().muted }}>{`   ${harnessName(card().session.harnessId)}${full()?.model ? ` · ${full()?.model}` : ""} · ${projectName(card().session.workspaceId)}${full() ? ` · ${full()?.turns} ${full()?.turns === 1 ? "turn" : "turns"}` : ""}`}</span>
              </text>
              <text wrapMode="none" truncate>
                <span style={{ fg: t().muted }}>{"You     "}</span>
                <span style={{ fg: t().text2 }}>{previewLine(full() ? { ...(full() as SessionPreview), answer: null } : null) ?? (full() ? "—" : "Reading…")}</span>
              </text>
              <box flexDirection="row" height={Math.min(3, Math.max(1, Math.ceil((said() ?? "").length / Math.max(10, width() - 14))))} overflow="hidden">
                <text flexShrink={0} fg={t().muted}>{"Said    "}</text>
                <text flexGrow={1} fg={t().text} wrapMode="word">{said()}</text>
              </box>
              {/* A worker's own row drops its model and host before it squeezes the title, so they are said here, whole. */}
              <Show when={card().children.length > 0}>
                <text wrapMode="none" truncate>
                  <span style={{ fg: t().muted }}>{"Workers "}</span>
                  <span style={{ fg: t().text2 }}>{card().children.map((child) => [childHost(child), previewOf(child)?.model, child.lineage?.role].filter(Boolean).join(" · ") || "worker").join("  ·  ")}</span>
                </text>
              </Show>
              <Show when={(full()?.files.length ?? 0) > 0}>
                <text wrapMode="none" truncate>
                  <span style={{ fg: t().muted }}>{"Files   "}</span>
                  <span style={{ fg: t().text2 }}>{(full()?.files ?? []).join(", ")}</span>
                </text>
              </Show>
            </>
          )}
        </Show>
      </box>
    </box>
  );
}
