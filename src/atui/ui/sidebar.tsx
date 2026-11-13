// The side panel, in two tabs. Sessions: grouped as the web sidebar does
// (Needs you, Working, Pinned, then projects, this one first). Info: the
// open chat's context, usage, todos, git, changes, and limits (panel.tsx).
// C-x s opens Sessions and C-x i Info; with the panel focused ↑/↓ and Enter
// pick a session, Tab switches tabs, Esc goes back to the composer. The « in
// the corner folds the panel to a rail, whose » brings it back.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { ProjectSession } from "../../shared/protocol.js";
import { groupByProject, isBusy, sidebarSections } from "../../web/session-groups.js";
import { clip, clipPath } from "../format.js";
import { breathe, mix, spinnerFor } from "../fx.js";
import { accentOf } from "../theme.js";
import { useAtui, useTheme } from "./context.js";
import { InfoBody } from "./panel.js";
import { tick } from "./ticker.js";

/** A session asking for you breathes over this many ticks of 100 ms. */
const BREATH_TICKS = 24;
const PER_PROJECT = 6;
const PER_OTHER = 3;
/** The folded panel: a rail just wide enough for its » button. */
export const RAIL_WIDTH = 3;

export type SidebarTab = "sessions" | "info";

type Row = { kind: "head"; label: string; color?: string; count: number } | { kind: "session"; s: ProjectSession; project?: string };

function age(iso: string | null): string {
  if (!iso) return "";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** The folded panel: a » to unfold it. */
export function SidebarRail(p: { onExpand: () => void }) {
  const t = useTheme();
  return (
    <box flexDirection="column" width={RAIL_WIDTH} flexShrink={0} border={["right"]} borderColor={t().border} alignItems="center" onMouseDown={p.onExpand}>
      <text fg={t().accent}>»</text>
    </box>
  );
}

export function Sidebar(p: {
  active: boolean;
  width: number;
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  onCollapse: () => void;
  onOpened: () => void;
  onLeave: () => void;
}) {
  const app = useAtui();
  const t = useTheme();
  const isActive = (s: ProjectSession) => {
    const c = app.chat();
    return Boolean(c && ((c.sessionId !== null && s.id === c.sessionId) || s.liveChatId === c.chatId));
  };
  const rows = createMemo<Row[]>(() => {
    const opts = { currentId: app.workspace()?.id ?? null, query: "", harnessId: app.harnessId(), isActive, now: Date.now() };
    const overview = app.overview();
    const sections = sidebarSections(overview, opts);
    const name = (s: ProjectSession) => overview.workspaces.find((w) => w.id === s.workspaceId)?.name ?? "";
    const out: Row[] = [];
    const list = (label: string, sessions: ProjectSession[], color?: string) => {
      if (sessions.length === 0) return;
      out.push({ kind: "head", label, count: sessions.length, ...(color ? { color } : {}) });
      for (const s of sessions) out.push({ kind: "session", s, project: name(s) });
    };
    list("Needs you", sections.needs, t().warn);
    list("Working", sections.working, t().accent);
    list("Pinned", sections.pinned);
    for (const g of groupByProject(overview, opts)) {
      out.push({ kind: "head", label: g.workspace.name, count: g.sessions.length });
      for (const s of g.sessions.slice(0, g.current ? PER_PROJECT : PER_OTHER)) out.push({ kind: "session", s });
    }
    return out;
  });
  const sessionRows = createMemo(() => rows().flatMap((r, i) => (r.kind === "session" ? [i] : [])));

  const [sel, setSel] = createSignal(0);
  createEffect(() => {
    if (!p.active) return;
    const at = rows().findIndex((r) => r.kind === "session" && isActive(r.s));
    setSel(Math.max(0, sessionRows().indexOf(at)));
  });

  useKeyboard((key) => {
    if (!p.active || key.defaultPrevented) return;
    const n = p.tab === "sessions" ? sessionRows().length : 0;
    if (key.name === "escape") {
      key.preventDefault();
      p.onLeave();
    } else if (key.name === "tab") {
      key.preventDefault();
      p.onTab(p.tab === "sessions" ? "info" : "sessions");
    } else if ((key.name === "down" || key.name === "j") && n > 0) {
      key.preventDefault();
      setSel((i) => Math.min(n - 1, i + 1));
    } else if ((key.name === "up" || key.name === "k") && n > 0) {
      key.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if ((key.name === "return" || key.name === "t") && p.tab === "sessions") {
      // Enter opens it in the shown tab; t, in a tab of its own.
      key.preventDefault();
      const row = rows()[sessionRows()[sel()] ?? -1];
      if (row?.kind === "session") void app.openSession(row.s, { newTab: key.name === "t" }).then(p.onOpened);
    }
  });

  const selectedRow = () => sessionRows()[sel()] ?? -1;
  /** Inside the borders and padding, after the two-column mark. */
  const width = () => p.width - 5;
  // Every session asking for you breathes together, in the warn colour, from dim to full.
  const breath = () => breathe(tick(), BREATH_TICKS);
  const askingTone = () => mix(mix(t().bg, t().warn, 0.35), t().warn, breath());
  const meta = (row: Extract<Row, { kind: "session" }>) => ` ${row.s.herdr ? "herdr " : ""}${row.s.handover ? "handed " : ""}${row.project ? `${clip(row.project, 10)} ` : ""}${age(row.s.updatedAt)}`;
  /** A session a herdr pane runs, by what herdr says it does (awui's own run marks win). */
  const herdrTone = (s: ProjectSession) => (s.herdr?.status === "blocked" ? askingTone() : s.herdr?.status === "working" ? t().accent : t().muted);

  const Tab = (q: { id: SidebarTab; label: string }) => (
    <text flexShrink={0} fg={p.tab === q.id ? t().text : t().muted} onMouseDown={() => p.onTab(q.id)}>
      {p.tab === q.id ? <b>{q.label}</b> : q.label}
    </text>
  );

  return (
    <box flexDirection="column" width={p.width} flexShrink={0} border={["right"]} borderColor={t().border} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0}>
        <Tab id="sessions" label="Sessions" />
        <text flexShrink={0} fg={t().border}>
          {" │ "}
        </text>
        <Tab id="info" label="Info" />
        <box flexGrow={1} />
        {/* Three cells to hit, not one. */}
        <box width={3} flexShrink={0} flexDirection="row" justifyContent="flex-end" onMouseDown={p.onCollapse}>
          <text fg={t().muted}>«</text>
        </box>
      </box>
      {/* The active tab's underline: an accent rule under its name, a quiet one under the rest. */}
      <text flexShrink={0} wrapMode="none">
        <span style={{ fg: p.tab === "sessions" ? t().accent : t().border }}>{"━".repeat(8)}</span>
        <span style={{ fg: t().border }}>{"━━━"}</span>
        <span style={{ fg: p.tab === "info" ? t().accent : t().border }}>{"━".repeat(4)}</span>
        <span style={{ fg: t().border }}>{"━".repeat(Math.max(0, p.width - 17))}</span>
      </text>
      <Show
        when={p.tab === "sessions"}
        fallback={
          <>
            <InfoBody width={p.width} />
            <text fg={t().muted} flexShrink={0}>
              {p.active ? "Tab sessions · Esc back" : "C-x i info"}
            </text>
          </>
        }
      >
        <text fg={t().muted} wrapMode="none" truncate flexShrink={0}>
          <span style={{ fg: accentOf(t(), app.harness()?.accent) }}>{`${app.harness()?.displayName ?? ""}  `}</span>
          {clipPath(app.workspace()?.path ?? "no project", Math.max(6, width() - (app.harness()?.displayName?.length ?? 0) - 2))}
        </text>
        <text fg={t().border} wrapMode="none" flexShrink={0}>
          {"─".repeat(Math.max(0, p.width - 4))}
        </text>
        <scrollbox flexGrow={1} marginTop={1} verticalScrollbarOptions={{ visible: false }}>
          <For each={rows()}>
            {(row, i) =>
              row.kind === "head" ? (
                <text fg={row.color ?? t().muted} marginTop={i() === 0 ? 0 : 1}>
                  {row.label}
                  <Show when={row.count > 0}>
                    <span style={{ fg: t().muted }}>{` ${row.count}`}</span>
                  </Show>
                </text>
              ) : (
                <box
                  flexDirection="row"
                  backgroundColor={i() === selectedRow() && p.active ? t().selection : isActive(row.s) ? t().surface2 : undefined}
                  onMouseDown={() => void app.openSession(row.s).then(p.onOpened)}
                >
                  <text flexShrink={0} fg={row.s.asking ? askingTone() : isBusy(row.s.status) ? t().accent : row.s.liveChatId ? t().ok : row.s.herdr ? herdrTone(row.s) : row.s.handover ? t().accent : t().muted}>
                    {row.s.asking ? "▲ " : isBusy(row.s.status) ? `${spinnerFor(row.s.harnessId)[tick() % spinnerFor(row.s.harnessId).length]} ` : row.s.liveChatId ? "● " : row.s.herdr ? "◆ " : row.s.handover ? "◇ " : "· "}
                  </text>
                  <text flexGrow={1} fg={row.s.asking ? mix(t().text2, t().warn, 0.4 * breath()) : isActive(row.s) ? t().text : t().text2} wrapMode="none">
                    {clip(row.s.title || "New chat", width() - meta(row).length)}
                  </text>
                  <text flexShrink={0} fg={t().muted}>
                    {meta(row)}
                  </text>
                </box>
              )
            }
          </For>
          <Show when={rows().length === 0}>
            <text fg={t().muted}>No sessions yet</text>
          </Show>
        </scrollbox>
        <text fg={t().muted} flexShrink={0}>
          {p.active ? "↑↓ Enter · t tab · Esc back" : "C-x s to browse"}
        </text>
      </Show>
    </box>
  );
}
