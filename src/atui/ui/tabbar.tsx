// The open tabs, along the top of the conversation once there are two (the
// web UI's tab strip): each with its number (M-1 to M-9 bring it), its
// harness's mark, its title, and a dot when a run finished there unseen; a
// click brings one, × closes the shown one. C-x ] and C-x [ step through them,
// C-x w closes, C-x a opens a new chat in a new tab. Titles budget on the
// strip's own width — the conversation's room beside the side panel — and step
// down to nothing (number and mark alone) before the strip would overflow.
import { Index, Show } from "solid-js";
import { clip, tabTitleChars } from "../format.js";
import { mix } from "../fx.js";
import { harnessGlyph } from "../neat.js";
import { accentOf } from "../theme.js";
import { useAtui, useTheme } from "./context.js";

export function TabBar(p: { /** The strip's own width: the conversation's room, beside the side panel. */ width: number }) {
  const app = useAtui();
  const t = useTheme();
  // Each tab's title takes what the strip can spare it, so long titles end in `…` instead of running off the pane.
  const chars = () => tabTitleChars(p.width, app.tabs().tabs.length);
  const accent = (harnessId: string) => accentOf(t(), app.boot()?.harnesses.find((h) => h.id === harnessId)?.accent);
  return (
    <Show when={app.tabs().tabs.length >= 2}>
      <box flexDirection="row" flexShrink={0} height={1} overflow="hidden" paddingLeft={1}>
        <Index each={app.tabs().tabs}>
          {(tab, i) => {
            const active = () => i === app.tabs().active;
            return (
              <>
                <box flexShrink={0} paddingLeft={1} paddingRight={active() ? 0 : 1} backgroundColor={active() ? mix(t().bg, t().surface2, 0.9) : undefined} onMouseDown={() => void app.switchTab(i)}>
                  <text wrapMode="none" fg={active() ? t().text : t().muted}>
                    <span style={{ fg: t().muted }}>{i < 9 ? `${i + 1} ` : ""}</span>
                    <span style={{ fg: accent(tab().harnessId) }}>{`${harnessGlyph(tab().harnessId)} `}</span>
                    <Show when={chars() > 0} fallback={<span>{active() ? "" : " "}</span>}>
                      {active() ? <b>{clip(tab().title || "New chat", chars())}</b> : clip(tab().title || "New chat", chars())}
                    </Show>
                    <Show when={tab().unread}>
                      <span style={{ fg: t().accent }}>{" ●"}</span>
                    </Show>
                  </text>
                </box>
                <Show when={active()}>
                  {/* Beside the tab, not inside it: a click here closes, and must not also bring the tab. */}
                  <box flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={mix(t().bg, t().surface2, 0.9)} onMouseDown={() => app.closeTab(i)}>
                    <text fg={t().muted}>×</text>
                  </box>
                </Show>
                <text flexShrink={0} fg={t().border}>
                  {" "}
                </text>
              </>
            );
          }}
        </Index>
      </box>
    </Show>
  );
}
