// News from sessions in the background, in the corner above the composer for a
// few seconds: one finished, failed, or asks for you. A click opens it. It sits
// in the layout rather than floating: OpenTUI paints a bordered card's body over
// a sibling overlay, so a floating toast would let the conversation through it.
import { For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { clip } from "../format.js";
import { useAtui, useTheme } from "./context.js";

const WIDTH = 40;

export function Toasts() {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const tone = (kind: string) => (kind === "asking" ? t().warn : kind === "failed" ? t().danger : t().ok);
  const head = (kind: string) => (kind === "asking" ? "▲ Needs you" : kind === "failed" ? "✗ Failed" : "✓ Done");
  const open = (sessionId: string, id: number) => {
    app.dismissToast(id);
    const s = app.overview().sessions.find((x) => x.id === sessionId);
    if (s) void app.openSession(s);
  };
  return (
    <Show when={app.toasts().length > 0 && size().width >= WIDTH + 10}>
      <box flexShrink={0} flexDirection="column" alignItems="flex-end" paddingLeft={2} paddingRight={2}>
        <For each={app.toasts()}>
          {(toast) => (
            <box width={WIDTH} border borderStyle="rounded" borderColor={tone(toast.kind)} backgroundColor={t().surface} paddingLeft={1} paddingRight={1} marginTop={1} onMouseDown={() => open(toast.sessionId, toast.id)}>
              <text wrapMode="none" truncate>
                <span style={{ fg: tone(toast.kind) }}>{head(toast.kind)}</span>
                <span style={{ fg: t().text2 }}>{`  ${clip(toast.title, WIDTH - 16)}`}</span>
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}
