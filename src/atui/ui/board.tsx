// The agent dashboard (the web UI's Agents board, in a terminal): every session in three columns —
// Needs you, Working, Done — with a delegated child nested under the parent it runs for. The
// grouping is web/dashboard.ts's (boardCards), so a card sits in the same column in both clients;
// this file draws it and maps Enter to opening the chat. C-x k opens it. ←/→ a column, ↑/↓ a card,
// Enter opens the chat, f narrows to one project, r to a pull-request state, Esc closes.
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { ProjectSession, SessionsOverview } from "../../shared/protocol.js";
import {
  BOARD_COLUMNS,
  BOARD_EMPTY,
  BOARD_TITLES,
  boardCards,
  boardCounts,
  boardProjects,
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
import { agentStatusText } from "../../web/agent-status.js";
import { ago } from "../format.js";
import { moveRow } from "../delegated.js";
import { accentOf } from "../theme.js";
import { useAtui, useTheme } from "./context.js";

/** How many projects' pull requests are read when the board opens: gh is slow and a badge is decoration. */
const PR_READS = 8;

/** One column's cards, the cursor kept inside the column's own list. */
const clampCursor = (cards: BoardCard[], at: number): number => (cards.length === 0 ? 0 : Math.min(at, cards.length - 1));

export function BoardView(p: { onClose: () => void; onOpenSession: (s: ProjectSession) => void }) {
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

  const width = () => Math.min(160, size().width - 2);
  const columnWidth = () => Math.max(18, Math.floor((width() - 4) / 3) - 1);
  const height = () => Math.max(6, size().height - 8);
  const filterLine = () => `${project() ? projectName(project() as string) : `Every project (${overview().sessions.filter((s) => !s.archived).length})`} · ${PR_FILTER_LABELS[pr()]}`;

  return (
    <box
      position="absolute"
      /* Stretched to the box it stands in, not measured off the terminal: a sheet sits under the tab strip and
         the title bar, so a terminal-height overlay would put its last row off the frame. */
      top={0}
      bottom={0}
      left={Math.max(0, Math.floor((size().width - width()) / 2))}
      width={width()}
      zIndex={15}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={t().border}
      backgroundColor={t().surface}
      title=" Agents "
      titleColor={t().text}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" flexShrink={0}>
        <text flexGrow={1} fg={t().muted} wrapMode="none" truncate>
          {filterLine()}
        </text>
        <text flexShrink={0} fg={note() ? t().warn : t().muted}>
          {note() ?? "←→ column · ↑↓ card · Enter opens · f project · r pull request · Esc closes"}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1} overflow="hidden" marginTop={1}>
        <For each={BOARD_COLUMNS}>
          {(id) => {
            const columnCards = () => cards()[id];
            const active = () => column() === id;
            const at = () => (active() ? clampCursor(columnCards(), cursor()) : -1);
            return (
              <box flexDirection="column" width={columnWidth()} flexShrink={0} paddingRight={1}>
                <text flexShrink={0} fg={active() ? t().accent : t().muted} wrapMode="none" truncate>
                  <b>{BOARD_TITLES[id]}</b>
                  <span style={{ fg: t().muted }}>{` ${counts()[id]}`}</span>
                </text>
                <Show when={columnCards().length > 0} fallback={<text flexShrink={0} fg={t().muted} wrapMode="word">{reading() ? "Reading this server's sessions…" : BOARD_EMPTY[id]}</text>}>
                  <box flexDirection="column" overflow="hidden">
                    <For each={columnCards().slice(0, height())}>
                      {(card, i) => (
                        <box flexDirection="column" flexShrink={0} marginTop={i() === 0 ? 0 : 1} backgroundColor={i() === at() ? t().selection : undefined} onMouseDown={() => { setColumn(id); setCursor(i()); }}>
                          <text wrapMode="none" truncate>
                            <span style={{ fg: i() === at() ? t().accent : t().border }}>{i() === at() ? "▌" : " "}</span>
                            <span style={{ fg: harnessAccent(card.session.harnessId) }}>{"● "}</span>
                            <b>{plainTitle(card.session.title) || "Untitled"}</b>
                          </text>
                          <text fg={t().muted} wrapMode="none" truncate>
                            {`   ${projectName(card.session.workspaceId)} · ${card.session.updatedAt ? ago(card.session.updatedAt) : ""}${card.session.asking ? " · needs you" : ""}${card.session.origin === "agent" ? " · delegated" : ""}`}
                          </text>
                          <Show when={card.session.agentStatus}>
                            {(status) => <text fg={t().text2} wrapMode="none" truncate>{`   ${agentStatusText(status())}`}</text>}
                          </Show>
                          <Show when={prBadge(card.session, prs() ? { [card.session.workspaceId]: prs()[card.session.workspaceId] ?? null } : undefined)}>
                            {(badge) => <text fg={t().link} wrapMode="none" truncate>{`   ${badge().words}`}</text>}
                          </Show>
                          <For each={card.children}>
                            {(child) => (
                              <text wrapMode="none" truncate onMouseDown={() => p.onOpenSession(child)}>
                                <span style={{ fg: t().border }}>{"   └ "}</span>
                                <span style={{ fg: harnessAccent(child.harnessId) }}>{"● "}</span>
                                <span style={{ fg: t().text2 }}>{plainTitle(child.title) || "Untitled"}</span>
                                <span style={{ fg: child.asking ? t().warn : isBusy(child.status) ? t().accent : t().muted }}>{` ${child.asking ? "needs you" : isBusy(child.status) ? "working" : "done"}`}</span>
                              </text>
                            )}
                          </For>
                        </box>
                      )}
                    </For>
                    <Show when={columnCards().length > height()}>
                      <text flexShrink={0} fg={t().muted}>{`${columnCards().length - height()} more`}</text>
                    </Show>
                  </box>
                </Show>
              </box>
            );
          }}
        </For>
      </box>
      <text flexShrink={0} fg={t().muted} wrapMode="none" truncate>
        {here() ? `${harnessName(here()?.session.harnessId ?? "")} · ${projectName(here()?.session.workspaceId ?? "")} · ${plainTitle(here()?.session.title ?? "")}` : "No card under the cursor"}
      </text>
    </box>
  );
}
