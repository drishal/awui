// Undo file changes from a prompt on (the web UI's restore dialog): what
// putting the files back as they were before it would do, file by file, each
// ticked to start with: put back, deleted (it is new since), or brought back
// (it was deleted since). ↑/↓ or a click move and tick, Space ticks, Enter
// undoes the ticked ones, Esc closes. C-x z puts them back again afterwards.
import { createResource, createSignal, For, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { CheckpointFile } from "../../shared/protocol.js";
import { clip } from "../format.js";
import { useAtui, useTheme } from "./context.js";

const CHANGE: Record<CheckpointFile["change"], string> = { restore: "put back", delete: "delete (new since)", recreate: "bring back" };

export function UndoDialog(p: { turn: number; onClose: () => void; side?: number }) {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const [preview] = createResource(() => p.turn, (turn) => app.checkpointPreview(turn));
  const files = () => preview()?.files ?? [];
  const [skipped, setSkipped] = createSignal(new Set<string>());
  const [at, setAt] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const width = () => Math.max(30, Math.min(76, size().width - (p.side ?? 0) - 4));
  const ticked = () => files().filter((f) => !skipped().has(f.path));
  const toggle = (path: string) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const undo = async () => {
    if (busy() || ticked().length === 0) return;
    setBusy(true);
    if (await app.restoreFiles(p.turn, ticked().map((f) => f.path))) p.onClose();
    setBusy(false);
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    key.preventDefault();
    const list = files();
    if (key.name === "escape" || (key.ctrl && key.name === "c")) p.onClose();
    else if ((key.name === "down" || key.name === "j") && list.length > 0) setAt((i) => Math.min(list.length - 1, i + 1));
    else if ((key.name === "up" || key.name === "k") && list.length > 0) setAt((i) => Math.max(0, i - 1));
    else if (key.name === "space") {
      const f = list[at()];
      if (f) toggle(f.path);
    } else if (key.name === "return") void undo();
  });

  return (
    <box
      alignSelf="center"
      marginTop={2}
      width={width()}
      flexShrink={0}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={t().warn}
      backgroundColor={t().surface}
      title={` Undo file changes from message ${p.turn} on `}
      titleColor={t().text}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={!preview.loading} fallback={<text fg={t().muted}>Comparing the files with before it…</text>}>
        <Show when={files().length > 0} fallback={<text fg={t().muted}>No file differs from how it was before that message.</text>}>
          <text fg={t().text2}>Put these files back as they were before it (the agent is not told):</text>
          <box flexDirection="column" marginTop={1}>
            <For each={files()}>
              {(f, i) => (
                <box
                  flexDirection="row"
                  backgroundColor={i() === at() ? t().selection : undefined}
                  onMouseDown={() => {
                    setAt(i());
                    toggle(f.path);
                  }}
                >
                  <text flexShrink={0} fg={skipped().has(f.path) ? t().muted : t().accent}>
                    {skipped().has(f.path) ? "[ ] " : "[x] "}
                  </text>
                  <text flexGrow={1} wrapMode="none" truncate fg={skipped().has(f.path) ? t().muted : t().text}>
                    {clip(f.path, width() - 28)}
                  </text>
                  <text flexShrink={0} fg={f.change === "delete" ? t().danger : f.change === "recreate" ? t().ok : t().muted}>
                    {` ${CHANGE[f.change]}`}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </Show>
      <text fg={t().muted} marginTop={1}>
        {busy() ? "Undoing…" : `↑↓ move · Space ticks · Enter undoes ${ticked().length} · Esc closes`}
      </text>
    </box>
  );
}
