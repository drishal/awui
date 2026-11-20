// Projects are real navigation targets, not labels beside an arbitrarily long
// flat list. The current project shows every session; other projects open into
// it. Needs you, Working and Pinned retain their global views. All rows work by
// keyboard and mouse; Info is the context/usage/git view, not a second browser.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ProjectSession } from "../../shared/protocol.js";
import { isBusy } from "../../web/session-groups.js";
import { projectOpen, sidebarFolded, sidebarKey, sidebarParentKey, sidebarRows, sidebarSelectedIndex, sidebarTabRow, type SidebarRow } from "../sidebar-nav.js";
import { clip, clipPath } from "../format.js";
import { leader } from "../keys.js";
import { breathe, mix, spinnerFor } from "../fx.js";
import { accentOf } from "../theme.js";
import { useAtui, useTheme } from "./context.js";
import { InfoBody } from "./panel.js";
import { tick } from "./ticker.js";

const BREATH_TICKS = 24;
export const RAIL_WIDTH = 3;
export type SidebarTab = "sessions" | "info";

function age(iso: string | null): string {
  if (!iso) return "";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function monogram(name: string): string {
  return (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "·").toUpperCase();
}

export function SidebarRail(p: { asking: number; onExpand: () => void }) {
  const t = useTheme();
  // Folded, the rail is the only place a session that needs you can show, so it carries the panel's own asking mark.
  const mark = () => (p.asking === 1 ? "▲" : p.asking > 9 ? "▲+" : `▲${p.asking}`);
  return (
    <box flexDirection="column" width={RAIL_WIDTH} flexShrink={0} border={["right"]} borderColor={t().border} alignItems="center" onMouseDown={p.onExpand}>
      <text selectable={false} fg={t().accent}>»</text>
      <Show when={p.asking > 0}>
        <text selectable={false} wrapMode="none" fg={mix(mix(t().bg, t().warn, 0.35), t().warn, breathe(tick(), BREATH_TICKS))}>{mark()}</text>
      </Show>
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
  /** In the vim style, l leaves the list for the conversation, h's other half. */
  vim?: boolean;
}) {
  const app = useAtui();
  const t = useTheme();
  const [folded, setFolded] = createSignal(new Set<string>());
  const [selection, setSelection] = createSignal<string | null>(null);
  let scroller: ScrollBoxRenderable | undefined;
  const keyOf = (row: SidebarRow | undefined): string | null => sidebarKey(row, row ? rows().indexOf(row) : -1, rows());
  const isActive = (s: ProjectSession) => {
    const c = app.chat();
    return Boolean(c && ((c.sessionId !== null && s.id === c.sessionId) || s.liveChatId === c.chatId));
  };
  const rows = createMemo<SidebarRow[]>(() => sidebarRows(app.overview(), { currentId: app.workspace()?.id ?? null, query: "", harnessId: app.harnessId(), isActive, now: Date.now() }, folded()));
  const navRows = rows;
  const selectedRow = () => sidebarSelectedIndex(rows(), selection());
  const selected = () => navRows()[Math.min(selectedRow(), navRows().length - 1)];
  createEffect(() => {
    if (p.active && selection() === null) {
      const at = rows().findIndex((r) => r.kind === "session" && isActive(r.s));
      const current = rows().findIndex((r) => r.kind === "project" && r.current);
      const row = rows()[at >= 0 ? at : current >= 0 ? current : 0];
      if (row) setSelection(keyOf(row));
    }
  });
  createEffect(() => {
    if (!p.active || !scroller) return;
    selectedRow();
    scroller.afterLayout(() => {
      if (!scroller) return;
      const index = selectedRow();
      // Every drawn row is one terminal line. Keep its two-cell context in view.
      if (index < scroller.scrollTop) scroller.scrollTo(Math.max(0, index - 2));
      else if (index > scroller.scrollTop + scroller.viewport.height - 2) scroller.scrollTo(Math.max(0, index - scroller.viewport.height + 2));
    });
  });

  const isFolded = (row: SidebarRow) => row.kind === "project" ? !projectOpen(folded(), row.workspace.id, row.current) : row.kind === "section" && folded().has(`shut:${row.id}`) && !folded().has(`open:${row.id}`);
  const toggle = (row: SidebarRow) => {
    setSelection(sidebarParentKey(rows(), row));
    setFolded((current) => sidebarFolded(current, row, app.workspace()?.id ?? null));
  };
  const activate = (row: ReturnType<typeof selected>) => {
    if (!row) return;
    setSelection(keyOf(row));
    if (row.kind === "project") setFolded((current) => {
      const next = new Set(current);
      next.add(`open:project:${row.workspace.id}`);
      next.delete(`shut:project:${row.workspace.id}`);
      return next;
    });
    if (row.kind === "section") return toggle(row);
    if (row.kind === "project") {
      if (row.current) return toggle(row);
      if (row.newest) void app.openSession(row.newest).then(p.onOpened);
      else {
        app.newChat({ workspace: row.workspace });
        p.onOpened();
      }
      return;
    }
    void app.openSession(row.s).then(p.onOpened);
  };
  useKeyboard((key) => {
    if (!p.active || key.defaultPrevented) return;
    const index = selectedRow();
    const move = (to: number) => {
      const row = navRows()[Math.max(0, Math.min(navRows().length - 1, to))];
      if (row) setSelection(keyOf(row));
      key.preventDefault();
    };
    if (key.name === "escape") { key.preventDefault(); p.onLeave(); }
    else if (key.name === "tab") { key.preventDefault(); p.onTab(p.tab === "sessions" ? "info" : "sessions"); }
    else if (p.vim && key.name === "l") { key.preventDefault(); p.onLeave(); }
    else if (p.tab !== "sessions") return;
    else if (key.name === "down" || key.name === "j") move(index + 1);
    else if (key.name === "up" || key.name === "k") move(index - 1);
    else if (key.name === "home") move(0);
    else if (key.name === "end") move(navRows().length - 1);
    else if (key.name === "return") { key.preventDefault(); activate(selected()); }
    else if (key.name === "right" || key.name === "left" || key.name === "space") {
      const row = selected();
      if (!row) return;
      key.preventDefault();
      if (key.name === "right" && row.kind !== "session") return;
      setSelection(sidebarParentKey(rows(), row));
      if (key.name !== "right") {
        const target = rows().find((item, index) => sidebarKey(item, index, rows()) === sidebarParentKey(rows(), row));
        if (target) setFolded((current) => sidebarFolded(current, target, app.workspace()?.id ?? null));
      }
    } else if (key.name === "n") {
      const row = selected();
      if (row?.kind === "project") { key.preventDefault(); app.newChat({ workspace: row.workspace }); p.onOpened(); }
    } else if (key.name === "t") {
      const index = selectedRow();
      const row = sidebarTabRow(rows(), selectedRow());
      if (row?.kind === "session") { key.preventDefault(); void app.openSession(row.s, { newTab: true }).then(p.onOpened); }
    }
  });

  const width = () => p.width - 5;
  const breath = () => breathe(tick(), BREATH_TICKS);
  const askingTone = () => mix(mix(t().bg, t().warn, 0.35), t().warn, breath());
  const herdrTone = (s: ProjectSession) => (s.herdr?.status === "blocked" ? askingTone() : s.herdr?.status === "working" ? t().accent : t().muted);
  // Right of the title: the other project's name when the row is not this one's, then the age. The asking
  // mark is the row's own `▲`; a blank or a second "!" here only pushed the title off its budget.
  const meta = (row: Extract<SidebarRow, { kind: "session" }>) => `${row.project ? `${clip(row.project, 10)} ` : ""}${age(row.s.updatedAt)}`;
  const Tab = (q: { id: SidebarTab; label: string }) => (
    <text selectable={false} flexShrink={0} fg={p.tab === q.id ? t().text : t().muted} onMouseDown={() => p.onTab(q.id)}>
      {p.tab === q.id ? <b>{q.label}</b> : q.label}
    </text>
  );

  return (
    <box flexDirection="column" width={p.width} flexShrink={0} border={["right"]} borderColor={t().border} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0}>
        <Tab id="sessions" label="Sessions" /><text selectable={false} fg={t().border}>{" │ "}</text><Tab id="info" label="Info" />
        <box flexGrow={1} /><box width={3} flexShrink={0} justifyContent="flex-end" onMouseDown={p.onCollapse}><text selectable={false} fg={t().muted}>«</text></box>
      </box>
      <text selectable={false} flexShrink={0} wrapMode="none">
        <span style={{ fg: p.tab === "sessions" ? t().accent : t().border }}>{"━".repeat("Sessions".length)}</span>
        <span style={{ fg: t().border }}>{"━━━"}</span>
        <span style={{ fg: p.tab === "info" ? t().accent : t().border }}>{"━".repeat("Info".length)}</span>
        <span style={{ fg: t().border }}>{"━".repeat(Math.max(0, p.width - 19))}</span>
      </text>
      <Show when={p.tab === "sessions"} fallback={<><InfoBody width={p.width} /><text selectable={false} fg={t().muted} flexShrink={0}>{p.active ? "Tab sessions · Esc back" : `${leader("i", p.vim ? "vim" : "emacs")} info`}</text></>}>
        <box flexDirection="row" marginTop={1} paddingLeft={1} backgroundColor={t().surface2} onMouseDown={() => { app.newChat(); p.onOpened(); }}>
          <text selectable={false} fg={t().accent}>+</text><text selectable={false} fg={t().text}>{" New chat"}</text><box flexGrow={1} /><text selectable={false} fg={t().muted}>{`${app.harness()?.displayName ?? ""} `}</text>
        </box>
        <text selectable={false} fg={t().muted} wrapMode="none" truncate flexShrink={0}>
          <span style={{ fg: accentOf(t(), app.harness()?.accent) }}>{monogram(app.workspace()?.name ?? "")}</span>{`  ${clipPath(app.workspace()?.path ?? "no project", Math.max(6, width() - 4))}`}
        </text>
        <text selectable={false} fg={t().border} wrapMode="none" flexShrink={0}>{"─".repeat(Math.max(0, p.width - 4))}</text>
        <scrollbox ref={(el: ScrollBoxRenderable) => (scroller = el)} flexGrow={1} marginTop={1} verticalScrollbarOptions={{ visible: false }}>
          <For each={navRows()}>
            {(row) => {
              const chosen = () => row ? selection() === keyOf(row) && p.active : false;
              if (row.kind === "section") return (
                <box flexDirection="row" marginTop={1} onMouseDown={() => activate(row)}>
                  <text selectable={false} fg={chosen() ? t().accent : t().muted}>{`${isFolded(row) ? "▸" : "▾"} ${row.label}`}</text><text selectable={false} fg={t().muted}>{`  ${row.count}`}</text><box flexGrow={1} />
                </box>
              );
              if (row.kind === "project") {
                const name = () => clip(row.workspace.name, Math.max(4, width() - 14));
                // The card's ● counts what the rows' ● means — the group's own sessions with a live
                // chat on the server, a subset of its total (asking and working ones sit in the
                // lists above, pinned in their own) — so the mark says one thing in both places.
                const live = () => app.overview().sessions.filter((s) => s.workspaceId === row.workspace.id && s.harnessId === app.harnessId() && s.liveChatId && !s.asking && !isBusy(s.status)).length;
                const needs = () => app.overview().sessions.filter((s) => s.workspaceId === row.workspace.id && s.harnessId === app.harnessId() && s.asking).length;
                return (
                  <box flexDirection="row" marginTop={1} backgroundColor={chosen() ? t().selection : row.current ? t().surface : undefined} onMouseDown={() => activate(row)}>
                    <text selectable={false} fg={row.current ? t().accent : t().muted}>{`${isFolded(row) ? "▸" : "▾"} `}</text>
                    <text selectable={false} fg={t().accent} bg={t().surface2}>{` ${monogram(row.workspace.name)} `}</text>
                    <text selectable={false} fg={t().text} wrapMode="none">{` ${name()}`}</text><box flexGrow={1} />
                    {/* The same marks the session rows teach: ▲ a session asking, ● one live on the server. */}
                    {needs() > 0 ? <text selectable={false} fg={t().warn}>{`▲${needs()} `}</text> : null}
                    {live() > 0 ? <text selectable={false} fg={t().ok}>{`●${live()} `}</text> : null}
                    <text selectable={false} fg={t().muted}>{`${row.count} `}</text>
                  </box>
                );
              }
              const { s } = row;
              const rowMeta = () => meta(row);
              return (
                <box flexDirection="row" backgroundColor={chosen() ? t().selection : isActive(s) ? t().surface2 : undefined} onMouseDown={() => { setSelection(keyOf(row)); void app.openSession(s).then(p.onOpened); }}>
                  <text selectable={false} flexShrink={0} fg={s.asking ? askingTone() : isBusy(s.status) ? t().accent : s.liveChatId ? t().ok : s.herdr ? herdrTone(s) : t().muted}>{s.asking ? "▲ " : isBusy(s.status) ? `${spinnerFor(s.harnessId)[tick() % spinnerFor(s.harnessId).length]} ` : s.liveChatId ? "● " : s.herdr ? "◆ " : "· "}</text>
                  <text selectable={false} flexGrow={1} fg={s.asking ? mix(t().text2, t().warn, 0.4 * breath()) : isActive(s) ? t().text : t().text2} wrapMode="none">{clip(s.title || "New chat", width() - rowMeta().length - 1)}</text>
                  <text selectable={false} flexShrink={0} fg={t().muted}>{rowMeta()}</text>
                </box>
              );
            }}
          </For>
        </scrollbox>
        <text selectable={false} fg={t().muted} flexShrink={0}>{p.active ? "↑↓ Enter · t tab · Esc back" : `${leader("s", p.vim ? "vim" : "emacs")} to browse`}</text>
      </Show>
    </box>
  );
}
