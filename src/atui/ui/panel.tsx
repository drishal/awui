// The side panel's Info tab (OpenCode's session sidebar, with the web UI's
// pieces): context and what fills it, the session's tokens and cost, the
// harness's todos, git, the files this chat changed (each with a stat bar),
// and subscription limits, the context and each limit window drawn as a
// meter. C-x i shows it.
import { createMemo, For, Show } from "solid-js";
import { collectChanges } from "../../web/review.js";
import { accountName, clip, fileUrl, tokens, windowLabel } from "../format.js";
import { meter, statBar } from "../fx.js";
import { CONTEXT_HEAVY_TOKENS, contextTone } from "../theme.js";
import { useAtui, useTheme } from "./context.js";

/** Cells in a changed file's stat bar. */
const STAT_CELLS = 5;

/** A changed file's stat bar: added cells green, removed red, the rest a quiet track (GitHub's squares). */
function StatBar(p: { added: number; removed: number; max: number }) {
  const t = useTheme();
  const bar = () => statBar(p.added, p.removed, p.max, STAT_CELLS);
  return (
    <>
      <span style={{ fg: t().ok }}>{"■".repeat(bar().add)}</span>
      <span style={{ fg: t().danger }}>{"■".repeat(bar().del)}</span>
      <span style={{ fg: t().border }}>{"■".repeat(bar().rest)}</span>
    </>
  );
}

/** A meter: the filled part in `tone`, the rest a thin track, so an empty bar is a line rather than a block. */
function Meter(p: { fraction: number; width: number; tone: string }) {
  const t = useTheme();
  const filled = () => meter(p.fraction, p.width).trimEnd();
  return (
    <>
      <span style={{ fg: p.tone }}>{filled()}</span>
      <span style={{ fg: t().border }}>{"─".repeat(Math.max(0, p.width - filled().length))}</span>
    </>
  );
}

function Heading(p: { label: string }) {
  const t = useTheme();
  return (
    <text fg={t().muted} marginTop={1}>
      <b>{p.label}</b>
    </text>
  );
}

/** The Info tab's content, for a panel `width` columns wide (its border and padding included). */
export function InfoBody(p: { width: number }) {
  const app = useAtui();
  const t = useTheme();
  const c = () => app.chat();
  const files = createMemo(() => {
    const chat = c();
    return chat ? collectChanges(chat.items, chat.workspace.path) : [];
  });
  const w = () => p.width - 4;
  const largest = () => Math.max(0, ...files().map((f) => f.added + f.removed));
  const todoMark = (status: string) => (/done|complete/.test(status) ? "✓" : /progress|active|doing/.test(status) ? "◐" : "○");

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: false }}>
      <text fg={t().text}>
        <b>{clip(c()?.title || "New chat", w())}</b>
      </text>
      <Show when={c()?.context}>
        {(ctx) => (
          <box flexDirection="column">
            <Heading label="Context" />
            <text fg={(ctx().percent ?? 0) >= 65 || (ctx().tokens ?? 0) >= CONTEXT_HEAVY_TOKENS ? contextTone(t(), ctx().percent ?? 0, ctx().tokens) : t().text2}>
              {`${ctx().percent === null ? "—" : `${Math.round(ctx().percent ?? 0)}%`}  ${tokens(ctx().tokens ?? 0)} / ${tokens(ctx().window)}`}
            </text>
            <Show when={ctx().percent !== null}>
              <text wrapMode="none">
                <Meter fraction={(ctx().percent ?? 0) / 100} width={w()} tone={contextTone(t(), ctx().percent ?? 0, ctx().tokens)} />
              </text>
            </Show>
            <For each={(ctx().categories ?? []).slice(0, 6)}>
              {(cat) => (
                <text fg={t().muted} wrapMode="none" truncate>
                  {`${clip(cat.label, w() - 7).padEnd(Math.max(0, w() - 6))}${tokens(cat.tokens).padStart(5)}`}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
      <Show when={c()?.usage}>
        {(u) => (
          <box flexDirection="column">
            <Heading label="Session" />
            <text fg={t().text2}>{`${u().turns} turns · ${u().steps} calls`}</text>
            <text fg={t().muted}>{`in ${tokens(u().input + u().cachedInput)} · out ${tokens(u().output)}`}</text>
            <Show when={u().cost !== null}>
              <text fg={t().muted}>{`$${(u().cost ?? 0).toFixed(2)}`}</text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={(c()?.todos.length ?? 0) > 0}>
        <Heading label="Todos" />
        <For each={c()?.todos ?? []}>
          {(todo) => (
            <text fg={/done|complete/.test(todo.status) ? t().muted : /progress|active/.test(todo.status) ? t().text : t().text2} wrapMode="word">
              {`${todoMark(todo.status)} ${todo.text}`}
            </text>
          )}
        </For>
      </Show>
      <Show when={app.git()}>
        {(g) => (
          <box flexDirection="column">
            <Heading label="Git" />
            <text fg={t().text2} wrapMode="none" truncate>
              <span style={{ fg: t().accent }}>{g().branch ?? `detached ${g().head ?? ""}`}</span>
              <span style={{ fg: t().muted }}>{g().upstream ? (g().ahead || g().behind ? `  ↑${g().ahead} ↓${g().behind}` : "  ✓") : "  not pushed"}</span>
            </text>
            <text fg={t().muted}>
              {g().files.length === 0
                ? "clean"
                : [
                    g().counts.conflicts ? `${g().counts.conflicts} conflicted` : "",
                    g().counts.staged ? `${g().counts.staged} staged` : "",
                    g().counts.changed ? `${g().counts.changed} changed` : "",
                    g().counts.untracked ? `${g().counts.untracked} new` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </text>
            <Show when={g().added + g().removed > 0}>
              <text>
                <span style={{ fg: t().ok }}>{`+${g().added}`}</span>
                <span style={{ fg: t().danger }}>{` −${g().removed}`}</span>
              </text>
            </Show>
          </box>
        )}
      </Show>
      <Show when={files().length > 0}>
        <Heading label="Changed in this chat" />
        <For each={files()}>
          {(f) => (
            <box flexDirection="row">
              <text flexGrow={1} fg={t().text2} wrapMode="none" truncate>
                <a href={fileUrl(f.path, c()?.workspace.path ?? "")}>{f.path}</a>
              </text>
              <text flexShrink={0}>
                <span style={{ fg: t().ok }}>{` +${f.added}`}</span>
                <span style={{ fg: t().danger }}>{` −${f.removed} `}</span>
                <StatBar added={f.added} removed={f.removed} max={largest()} />
              </text>
            </box>
          )}
        </For>
      </Show>
      <Show when={(app.limits()?.accounts.length ?? 0) > 0}>
        <Heading label="Limits" />
        <For each={app.limits()?.accounts ?? []}>
          {(a) => {
            // Labels as wide as the account's longest ("5 Hour", "Monthly"), the bar taking what is left before " 100%".
            const labelWidth = () => Math.min(8, Math.max(0, ...a.windows.map((x) => windowLabel(x.label).length)));
            const barWidth = () => Math.max(4, w() - labelWidth() - 6);
            return (
              <box flexDirection="column">
                <text fg={a.limited ? t().danger : t().text2}>{`${accountName(a)}${a.limited ? " · limited" : ""}`}</text>
                <For each={a.windows}>
                  {(win) => {
                    const used = () => win.used ?? 0;
                    const tone = () => (used() >= 0.9 ? t().danger : used() >= 0.8 ? t().warn : t().accent);
                    return (
                      <text fg={t().muted} wrapMode="none">
                        {`${clip(windowLabel(win.label), labelWidth()).padEnd(labelWidth())} `}
                        <Meter fraction={used()} width={barWidth()} tone={tone()} />
                        {win.used === null ? "    —" : `${Math.round(used() * 100)}%`.padStart(5)}
                      </text>
                    );
                  }}
                </For>
              </box>
            );
          }}
        </For>
      </Show>
    </scrollbox>
  );
}
