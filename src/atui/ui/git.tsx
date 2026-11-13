// Git in a terminal (the web composer's git panel): the project's branch,
// upstream, and last commit, then every changed file by group, each with its
// state letter and lines. ↑/↓ (j/k) a file, {/} a group, Enter or Space stages
// or unstages the file under the cursor (a click on its Stage word does the
// same), a stages all the work the index does not have, u unstages all, c
// commits what is staged from a message box, d opens the selected file's diff
// against HEAD, r refreshes, Esc closes. Writes go through the same routes the
// web panel uses, so a refusal (a remote device may not write this machine's
// checkout) shows the server's own text.
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { GitFileDiff, GitDiffSide, GitStatus } from "../../shared/protocol.js";
import { GROUP_LABEL, OPERATION_LABEL, branchWords, commitWords, countsLine, stateTone, syncWordsOf } from "../../shared/git-words.js";
import { clip, clipPath } from "../format.js";
import { mix } from "../fx.js";
import { firstStop, gitRows, moveCursor, moveGroup, rowPaths, rowWords, stageAction, type GitRow } from "../git.js";
import { windowStart } from "../review.js";
import { useAtui, useTheme } from "./context.js";

export function GitView(p: { onClose: () => void }) {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const chat = () => app.chat();
  const status = createMemo<GitStatus | null>(() => app.git());
  const rows = createMemo(() => (status() ? gitRows(status() as GitStatus) : []));
  const [at, setAt] = createSignal(firstStop(rows()));
  const [writing, setWriting] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  // The open diff: which file and side, what it says once read, and where its window stands.
  const [open, setOpen] = createSignal<{ path: string; side: GitDiffSide; body: GitFileDiff | null } | null>(null);
  const [offset, setOffset] = createSignal(0);
  const height = () => Math.max(6, size().height - 14);

  onMount(() => {
    if (chat()) void app.refreshGit();
  });

  const fail = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  const say = (text: string) => {
    setNotice(text);
    setError(null);
  };

  const write = async (kind: "stage" | "unstage" | "commit", body: object) => {
    const c = chat();
    if (!c || busy()) return;
    setBusy(kind);
    setError(null);
    try {
      await app.server.call(`/api/chats/${c.chatId}/git/${kind}`, { body });
      if (kind === "commit") {
        setMessage("");
        setWriting(false);
        say(`Committed ${app.git()?.lastCommit?.hash ?? ""} ${app.git()?.lastCommit?.subject ?? ""}`.trim());
      } else say(kind === "stage" ? "Staged" : "Unstaged");
      await app.refreshGit();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const current = () => rows()[at()] as Extract<GitRow, { kind: "file" }> | undefined;
  const actOn = (row: Extract<GitRow, { kind: "file" }>) => void write(stageAction(row), { paths: rowPaths(row) });

  const openDiff = async (row: Extract<GitRow, { kind: "file" }>) => {
    const c = chat();
    if (!c) return;
    const path = row.entry.file.path;
    const side = row.entry.side;
    setOpen({ path, side, body: null });
    setOffset(0);
    try {
      setOpen({ path, side, body: await app.server.call<GitFileDiff>(`/api/chats/${c.chatId}/git/diff?path=${encodeURIComponent(path)}&side=${side}`) });
    } catch (e) {
      setOpen({ path, side, body: { diff: null, note: e instanceof Error ? e.message : String(e) } });
    }
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    if (open()) {
      // The diff window scrolls by keys and goes back on Esc, q, or d.
      if (key.name === "escape" || key.name === "q" || key.name === "d") {
        key.preventDefault();
        setOpen(null);
      } else if (key.name === "down" || key.name === "j") {
        key.preventDefault();
        setOffset((n) => n + 3);
      } else if (key.name === "up" || key.name === "k") {
        key.preventDefault();
        setOffset((n) => n - 3);
      } else if (key.name === "pageup" || key.name === "pagedown") {
        key.preventDefault();
        setOffset((n) => n + (key.name === "pageup" ? -10 : 10));
      }
      return;
    }
    if (writing()) {
      // The message box has the keys but these two.
      if (key.name === "escape") {
        key.preventDefault();
        setWriting(false);
        setMessage("");
      } else if (key.name === "return") {
        key.preventDefault();
        const text = message().trim();
        if (text && (status()?.counts.staged ?? 0) > 0) void write("commit", { message: text });
      }
      return;
    }
    key.preventDefault();
    const list = rows();
    if (key.name === "escape" || key.name === "q") p.onClose();
    else if (key.name === "down" || key.name === "j") setAt((i) => moveCursor(list, i, 1));
    else if (key.name === "up" || key.name === "k") setAt((i) => moveCursor(list, i, -1));
    else if (key.name === "pagedown") setAt((i) => moveCursor(list, i, 4));
    else if (key.name === "pageup") setAt((i) => moveCursor(list, i, -4));
    else if (key.name === "}" || key.name === "n") setAt((i) => moveGroup(list, i, 1));
    else if (key.name === "{" || key.name === "p") setAt((i) => moveGroup(list, i, -1));
    else if ((key.name === "return" || key.name === "space") && current()) actOn(current() as Extract<GitRow, { kind: "file" }>);
    else if (key.name === "a" && status()) {
      const paths = list.flatMap((r) => (r.kind === "file" && (r.entry.side !== "staged" || r.entry.state === "conflict") ? rowPaths(r) : []));
      if (paths.length > 0) void write("stage", { paths });
      else say("Nothing to stage");
    } else if (key.name === "u" && status()) {
      const paths = list.flatMap((r) => (r.kind === "file" && r.entry.side === "staged" ? rowPaths(r) : []));
      if (paths.length > 0) void write("unstage", { paths });
      else say("Nothing staged");
    } else if (key.name === "c") {
      if ((status()?.counts.staged ?? 0) === 0) return say("Stage a change, then commit");
      setWriting(true);
      setMessage("");
    } else if (key.name === "d" && current()) void openDiff(current() as Extract<GitRow, { kind: "file" }>);
    else if (key.name === "r") void app.refreshGit().then(() => say("Refreshed"));
  });

  const g = () => status();
  const facts = createMemo(() => {
    const s = g();
    if (!s) return [];
    const out: Array<[string, string]> = [
      ["Branch", `${branchWords(s)}${s.operation ? ` · ${OPERATION_LABEL[s.operation]}` : ""}`],
      ["Upstream", s.upstream ? `${s.upstream} · ${s.ahead === 0 && s.behind === 0 ? "up to date" : `${s.ahead} ahead, ${s.behind} behind`}` : "none: this branch has not been pushed"],
      ["Changes", countsLine(s)],
    ];
    if (s.lastCommit) out.push(["Last commit", `${s.lastCommit.hash} · ${commitWords(s.lastCommit)}`]);
    if (s.stashes > 0) out.push(["Stashes", String(s.stashes)]);
    return out;
  });

  const staged = () => status()?.counts.staged ?? 0;
  const win = () => windowStart(rows().length, Math.max(0, at()), height());
  const diffLines = createMemo(() => open()?.body?.diff?.lines ?? []);

  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={15} flexDirection="column" backgroundColor={t().bg} paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text flexGrow={1} fg={t().text} wrapMode="none" truncate>
          <b>Git</b>
          <span style={{ fg: t().muted }}>{g() ? `  ${(g() as GitStatus).branch ?? `detached ${(g() as GitStatus).head ?? ""}`} · ${syncWordsOf(g() as GitStatus)}` : ""}</span>
        </text>
        <text flexShrink={0} fg={t().muted} wrapMode="none" truncate>
          {clipPath(g()?.root ?? "", Math.max(16, Math.floor(size().width / 3)))}
        </text>
      </box>
      <Show when={g()} fallback={<text fg={t().muted}>{chat() ? "Reading the project's status…" : "Open a chat first: the panel reads this chat's project"}</text>}>
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <For each={facts()}>
            {([label, value]) => (
              <text wrapMode="none" truncate>
                <span style={{ fg: t().muted }}>{`${label.padEnd(12)}`}</span>
                <span style={{ fg: t().text2 }}>{value}</span>
              </text>
            )}
          </For>
        </box>
        <Show
          when={!open()}
          fallback={
            <box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
              <text fg={t().muted} flexShrink={0}>
                {`${open()?.path} · ${open()?.side === "staged" ? "staged" : open()?.side === "untracked" ? "untracked, against nothing" : "not staged"}`}
              </text>
              <Show when={open()?.body} fallback={<text fg={t().muted}>{open()?.body === null ? "Loading the diff…" : ((open()?.body?.note as string | undefined) ?? "No changes to show")}</text>}>
                <For each={diffLines().slice(Math.max(0, Math.min(offset(), diffLines().length - (height() - 2))), Math.max(0, Math.min(offset(), diffLines().length - (height() - 2))) + (height() - 2))}>
                  {(line) => (
                    <text wrapMode="none" truncate>
                      <span style={{ fg: t().border }}>{line.line !== undefined ? String(line.line).padStart(5) : "     "} </span>
                      <span style={{ fg: line.kind === "add" ? t().ok : line.kind === "del" ? t().danger : t().text2 }}>
                        {`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.kind === "hunk" || line.kind === "gap" ? clip(line.text || "⋯", 110) : line.text}`}
                      </span>
                    </text>
                  )}
                </For>
                <Show when={diffLines().length > height() - 2}>
                  <text fg={t().muted} flexShrink={0}>
                    {`  ${Math.min(offset(), diffLines().length - (height() - 2)) + 1}– of ${diffLines().length} lines · ↑↓ scroll`}
                  </text>
                </Show>
              </Show>
              <text flexShrink={0} fg={t().muted} marginBottom={1} wrapMode="none" truncate>
                ↑↓ scroll · Esc back to the files
              </text>
            </box>
          }
        >
          <box flexDirection="row" flexShrink={0} marginTop={1} gap={2}>
            <box border borderStyle="rounded" borderColor={t().border} paddingLeft={1} paddingRight={1} flexGrow={1} onMouseDown={() => staged() > 0 && !writing() && setWriting(true)}>
              <Show
                when={writing()}
                fallback={<text fg={staged() > 0 ? t().text2 : t().muted}>{message() || (staged() > 0 ? "c: write a commit message" : "Stage a change, then commit")}</text>}
              >
                <input
                  focused
                  flexGrow={1}
                  placeholder="Commit message: Enter commits, Esc drops"
                  textColor={t().text}
                  backgroundColor={t().surface}
                  focusedBackgroundColor={t().surface}
                  value={message()}
                  onInput={(value: string) => setMessage(value)}
                />
              </Show>
            </box>
            <text flexShrink={0} fg={busy() ? t().muted : t().accent} onMouseDown={() => void app.refreshGit()}>
              {busy() ? "…" : "r refresh"}
            </text>
          </box>
          <Show when={error() || notice()}>
            <text fg={error() ? t().danger : t().ok} wrapMode="word">
              {error() ?? notice()}
            </text>
          </Show>
          <box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
            <For each={rows().slice(win(), win() + height())}>
              {(row, i) => {
                const index = () => win() + i();
                const here = () => index() === at() && row.kind === "file";
                if (row.kind === "group")
                  return (
                    <text fg={t().muted} marginTop={i() === 0 ? 0 : 1}>
                      <b>{GROUP_LABEL[row.group]}</b>
                      <span style={{ fg: t().border }}>{` ${row.count}`}</span>
                    </text>
                  );
                const words = () => rowWords(row);
                const toggle = () => (row.entry.side === "staged" ? "Unstage" : "Stage");
                return (
                  <box flexDirection="row" backgroundColor={here() ? mix(t().bg, t().selection, 0.85) : undefined}>
                    <text flexShrink={0} fg={here() ? t().accent : t().border}>
                      {here() ? "▌" : " "}
                    </text>
                    <text flexShrink={0} fg={t()[stateTone(row.entry.state) as "ok" | "warn" | "danger" | "info"]}>
                      {`${words().letter} `}
                    </text>
                    <text flexGrow={1} wrapMode="none" truncate fg={t().text2} onMouseDown={() => void openDiff(row)}>
                      {words().note ? `${words().path}  (${words().note})` : words().path}
                    </text>
                    <text flexShrink={0}>
                      <span style={{ fg: t().ok }}>{words().added}</span>
                      <span style={{ fg: t().danger }}>{words().added ? " " : ""}{words().removed}</span>
                    </text>
                    <text flexShrink={0} fg={busy() ? t().muted : t().accent} onMouseDown={() => actOn(row)}>
                      {`  ${toggle()}`}
                    </text>
                  </box>
                );
              }}
            </For>
            <Show when={rows().length === 0}>
              <text fg={t().ok}>Nothing to commit — the working tree is clean</text>
            </Show>
          </box>
          <text flexShrink={0} fg={t().muted} marginBottom={1} wrapMode="none" truncate>
            {busy() ? `${busy()}…` : size().width < 112 ? "↑↓ file · Enter stage/unstage · Esc close" : "↑↓ file · {/} group · Enter stage/unstage · a all · u undo · c commit · d diff · r refresh · Esc close"}
          </text>
        </Show>
      </Show>
    </box>
  );
}
