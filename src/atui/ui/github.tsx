// GitHub in a terminal (the web UI's GitHubPanel): the project's branch and
// its upstream, the current pull request with its checks (the tally and the
// failing names), push, watch, the CI-repair offer, the stack with its layers
// and its bottom-up merge, the forms for a new PR and a stacked one, and the
// guided file-by-file tour. Every write (push, create, merge, repair) is one
// deliberate key: p push, n or s a form, M merge, w watch, x repair, t the
// tour, r refresh, Esc closes. The routes read the workspace; only the watch
// and the repair need the chat. gh's credentials stay on the server; a
// refusal shows the server's own text.
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { ChatSnapshot, GitHubCheckView, PrStack, Tour } from "../../shared/protocol.js";
import { checkFailed, checkWords, layerChecks, layerWord, mergeNotes, prNumberOf, upstreamWords } from "../../shared/github-words.js";
import { clip } from "../format.js";
import { useAtui, useTheme } from "./context.js";

interface Status {
  available: boolean;
  reason?: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  remoteUrl: string | null;
}

/** A form's fields, one active at a time: the title, the target branch, the description; a stack starts at the PR number. */
interface Form {
  kind: "pr" | "stack";
  field: "above" | "base" | "title" | "body";
  above: string;
  base: string;
  title: string;
  body: string;
}

const newForm = (kind: "pr" | "stack"): Form => ({ kind, field: kind === "pr" ? "title" : "above", above: "", base: "main", title: "", body: "" });

const fieldOf = (form: Form): string => (form.field === "above" ? form.above : form.field === "base" ? form.base : form.field === "title" ? form.title : form.body);

const setField = (form: Form, value: string): Form =>
  ({ ...form, ...(form.field === "above" ? { above: value } : form.field === "base" ? { base: value } : form.field === "title" ? { title: value } : { body: value }) } as Form);

/** The field Enter moves to, or null when the form submits. */
const nextField = (form: Form): Form["field"] | null => {
  if (form.kind === "pr") return form.field === "title" ? "base" : form.field === "base" ? "body" : null;
  if (form.field === "above") return form.above.trim() === "" ? "base" : "title";
  return form.field === "base" ? "title" : form.field === "title" ? "body" : null;
};

const FIELD_LABEL: Record<Form["field"], string> = {
  above: "Stack above (PR number; empty starts a stack on the base branch)",
  base: "Target branch",
  title: "Title",
  body: "Description",
};

export function GitHubView(p: { onClose: () => void }) {
  const app = useAtui();
  const t = useTheme();
  const chat = () => app.chat();
  const ws = () => app.workspace();
  const [status, setStatus] = createSignal<Status | null>(null);
  const [checks, setChecks] = createSignal<GitHubCheckView[]>([]);
  const [pr, setPr] = createSignal<{ url: string; title: string; state: string; isDraft: boolean } | null>(null);
  const [stack, setStack] = createSignal<PrStack | null>(null);
  const [watchedUrl, setWatchedUrl] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>("load");
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [form, setForm] = createSignal<Form | null>(null);
  const [tour, setTour] = createSignal<{ tour: Tour; stale: boolean; position: number } | null>(null);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const say = (text: string) => {
    setNotice(text);
    setError(null);
  };

  const refresh = async () => {
    const w = ws();
    if (!w) return;
    setBusy("load");
    setError(null);
    try {
      const next = await app.server.call<Status>(`/api/workspaces/${w.id}/github`);
      setStatus(next);
      if (!next.available) {
        setChecks([]);
        setPr(null);
        setStack(null);
        setBusy(null);
        return;
      }
      const [check, current] = await Promise.allSettled([
        app.server.call<{ checks: GitHubCheckView[] }>(`/api/workspaces/${w.id}/github/checks`),
        app.server.call<{ pr: { url: string; title: string; state: string; isDraft: boolean } | null }>(`/api/workspaces/${w.id}/github/pr`),
      ]);
      setChecks(check.status === "fulfilled" ? check.value.checks : []);
      setPr(current.status === "fulfilled" ? current.value.pr : null);
      setStack(await app.server.call<{ stacks: PrStack[] }>(`/api/workspaces/${w.id}/pr-stack`).then((r) => r.stacks[0] ?? null).catch(() => null));
      const c = chat();
      setWatchedUrl(
        c
          ? await app.server
              .call<{ watches: Array<{ url: string }> }>(`/api/chats/${c.chatId}/pr-watches`)
              .then((r) => r.watches[0]?.url ?? null)
              .catch(() => null)
          : null,
      );
      if (check.status === "rejected") fail(check.reason);
      else if (current.status === "rejected") fail(current.reason);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  onMount(() => {
    void refresh();
  });

  const guarded = async (name: string, run: () => Promise<void>) => {
    if (busy()) return;
    setBusy(name);
    setError(null);
    try {
      await run();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const push = () =>
    void guarded("push", async () => {
      const w = ws();
      if (!w) return;
      await app.server.call(`/api/workspaces/${w.id}/github/push`, { body: {} });
      say("Pushed the current branch");
      await refresh();
    });

  const watch = (on: boolean) =>
    void guarded("watch", async () => {
      const c = chat();
      const url = pr()?.url;
      if (!c || !url) return;
      await app.server.call(`/api/chats/${c.chatId}/pr-watch`, on ? { body: { url } } : { method: "DELETE", body: { url } });
      setWatchedUrl(on ? url : null);
      say(on ? "Watching this PR: a real check or review change prompts you" : "Stopped watching this PR");
    });

  const repair = () =>
    void guarded("repair", async () => {
      const c = chat();
      const w = ws();
      const url = pr()?.url;
      if (!c || !w || !url) return;
      const done = await app.server.call<{ chat: ChatSnapshot }>(`/api/workspaces/${w.id}/pr-repair`, { body: { url, harnessId: c.harnessId } });
      void app.refreshSessions();
      void app.openChat(done.chat.chatId);
      say(`Started the repair chat “${done.chat.title}” in a new tab`);
    });

  const merge = () =>
    void guarded("merge", async () => {
      const w = ws();
      const s = stack();
      if (!w || !s) return;
      const done = await app.server.call<{ stack: PrStack; refusal: { pr: number; message: string } | null; archiveRefusals: Array<{ pr: number; message: string }> }>(`/api/workspaces/${w.id}/pr-stack/${s.id}/merge`, { body: { archive: false } });
      setStack(done.stack);
      const notes = mergeNotes(done);
      if (notes) setError(notes);
      else say("Merged the stack, bottom-up");
      await refresh();
    });

  const submitForm = () =>
    void guarded("pr", async () => {
      const w = ws();
      const f = form();
      if (!w || !f) return;
      if (f.kind === "pr") {
        const made = await app.server.call<{ url: string }>(`/api/workspaces/${w.id}/github/pr`, { body: { base: f.base.trim(), title: f.title.trim(), body: f.body } });
        say(`Created the pull request: ${made.url}`);
      } else {
        const made = await app.server.call<{ stack: PrStack }>(
          `/api/workspaces/${w.id}/pr-stack`,
          f.above.trim() === "" ? { body: { base: f.base.trim(), title: f.title.trim(), body: f.body, push: false } } : { body: { above: Number(f.above), title: f.title.trim(), body: f.body, push: false } },
        );
        setStack(made.stack);
        say(f.above.trim() === "" ? `Stacked the pull request on ${f.base.trim()}` : `Stacked the pull request above #${f.above.trim()}`);
      }
      setForm(null);
      await refresh();
    });

  const openTour = (regenerate: boolean) =>
    void guarded("tour", async () => {
      const w = ws();
      const n = prNumberOf(pr()?.url ?? "");
      if (!w || n === null) return say("No pull request for this branch yet");
      const next = await app.server.call<{ tour: Tour; stale: boolean }>(`/api/workspaces/${w.id}/pr-tour?pr=${n}&regenerate=${regenerate}`);
      setTour({ tour: next.tour, stale: next.stale, position: regenerate || !tour() ? 0 : tour()?.position ?? 0 });
    });

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    const tr = tour();
    if (tr) {
      // The tour reads file by file: step, rebuild, back.
      if (key.name === "escape" || key.name === "q" || key.name === "t") {
        key.preventDefault();
        setTour(null);
      } else if (key.name === "]" || key.name === "n" || key.name === "pagedown") {
        key.preventDefault();
        setTour({ ...tr, position: tr.position + 1 });
      } else if (key.name === "[" || key.name === "p" || key.name === "pageup") {
        key.preventDefault();
        setTour({ ...tr, position: Math.max(0, tr.position - 1) });
      } else if (key.name === "b") {
        key.preventDefault();
        void openTour(true);
      } else if (key.name === "down" || key.name === "j") key.preventDefault();
      return;
    }
    if (form()) {
      // The form's field has the keys but these two.
      if (key.name === "escape") {
        key.preventDefault();
        setForm(null);
      } else if (key.name === "return") {
        key.preventDefault();
        const f = form() as Form;
        const next = nextField(f);
        if (next) setForm({ ...f, field: next });
        else void submitForm();
      }
      return;
    }
    key.preventDefault();
    if (key.name === "escape" || key.name === "q") p.onClose();
    else if (key.name === "r") void refresh().then(() => say("Refreshed"));
    else if (key.name === "p") push();
    else if (key.name === "w") watch(watchedUrl() !== null && pr() !== null && watchedUrl() === pr()?.url);
    else if (key.name === "t") void openTour(false);
    else if (key.name === "m") merge();
    else if (key.name === "x" && failing().length > 0) repair();
    else if (key.name === "n") setForm(newForm("pr"));
    else if (key.name === "s") setForm(newForm("stack"));
  });

  const failing = createMemo(() => checks().filter((c) => checkFailed(c.state)));
  const watched = () => watchedUrl() !== null && pr() !== null && watchedUrl() === pr()?.url;
  const s = () => status();

  const facts = createMemo(() => {
    const st = s();
    if (!st) return [];
    const out: Array<[string, string]> = [
      ["Branch", `${st.branch ?? "no branch"}${st.upstream ? ` → ${st.upstream}` : ""}`],
      ["Upstream", upstreamWords(st)],
      ["Checks", checkWords(checks())],
    ];
    if (st.remoteUrl) out.push(["Remote", st.remoteUrl]);
    return out;
  });

  const tourRead = () => {
    const tr = tour();
    if (!tr) return { file: undefined as Tour["files"][number] | undefined, index: 0, count: 0 };
    const count = tr.tour.files.length;
    const index = Math.min(Math.max(0, tr.position), Math.max(0, count - 1));
    return { file: tr.tour.files[index], index, count };
  };

  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={15} flexDirection="column" backgroundColor={t().bg} paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text flexGrow={1} fg={t().text}>
          <b>GitHub</b>
          <span style={{ fg: t().muted }}>{s() ? `  ${(s() as Status).branch ?? "no branch"}${(s() as Status)?.upstream ? ` → ${(s() as Status).upstream}` : ""}` : ""}</span>
        </text>
        <text flexShrink={0} fg={t().muted}>
          {ws()?.name}
        </text>
      </box>
      {tour() ? (
        (() => {
          const tr = tour() as { tour: Tour; stale: boolean; position: number };
          const read = tourRead();
          return (
            <box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
              <text fg={t().muted} flexShrink={0}>
                {`#${tr.tour.pr} · ${tr.tour.title}`}
              </text>
              {tr.stale ? (
                <text fg={t().warn} flexShrink={0}>
                  The PR has changed since this guide was made. Rebuild (b) before judging it.
                </text>
              ) : null}
              <Show when={read.file} fallback={<text fg={t().muted}>No textual file changes to tour. Inspect binary or metadata changes on GitHub.</text>}>
                <box flexDirection="row" flexShrink={0} marginTop={1}>
                  <text flexGrow={1} wrapMode="none" truncate fg={t().text}>
                    <b>{read.file?.path}</b>
                  </text>
                  <text flexShrink={0} fg={t().muted}>
                    {`${read.index + 1} of ${read.count} · ${read.file?.bucket}`}
                  </text>
                </box>
                <box flexDirection="column" flexGrow={1} overflow="hidden">
                  <Show when={read.file?.diff} fallback={<text fg={t().muted}>{read.file?.note ?? "No text changes to render for this file. Inspect the full file on GitHub."}</text>}>
                    <For each={read.file?.diff?.lines.slice(0, 200) ?? []}>
                      {(line) => (
                        <text wrapMode="none" truncate>
                          <span style={{ fg: t().border }}>{line.line !== undefined ? String(line.line).padStart(5) : "     "} </span>
                          <span style={{ fg: line.kind === "add" ? t().ok : line.kind === "del" ? t().danger : t().text2 }}>
                            {`${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.kind === "hunk" || line.kind === "gap" ? clip(line.text || "⋯", 110) : line.text}`}
                          </span>
                        </text>
                      )}
                    </For>
                  </Show>
                </box>
              </Show>
              <text flexShrink={0} fg={t().muted} marginBottom={1}>
                ]/[ or n/p file · b rebuild · t or Esc back
              </text>
            </box>
          );
        })()
      ) : (
        <>
          <Show when={s()} fallback={<text fg={t().muted}>{busy() ? "Reading the repository's status…" : "No status: start atui in a project folder"}</text>}>
            <box flexDirection="column" marginTop={1} flexShrink={0}>
              <For each={facts()}>
                {([label, value]) => (
                  <text wrapMode="none" truncate>
                    <span style={{ fg: t().muted }}>{`${label.padEnd(10)}`}</span>
                    <span style={{ fg: t().text2 }}>{value}</span>
                  </text>
                )}
              </For>
              {s() && !s()?.available ? (
                <text fg={t().danger} wrapMode="word">
                  {(s() as Status | undefined)?.reason ?? "GitHub is not available on this machine. Install gh and log in on the server."}
                </text>
              ) : null}
              {pr() ? (
                <text wrapMode="none" truncate>
                  <span style={{ fg: t().muted }}>{"Pull request  "}</span>
                  <span style={{ fg: t().link }}>{(pr() as { url: string }).url}</span>
                  <span style={{ fg: t().muted }}>{`  ${(pr() as { title: string }).title}`}</span>
                </text>
              ) : null}
              {failing().length > 0 ? (
                <text wrapMode="none" truncate>
                  <span style={{ fg: t().danger }}>{`Failing: ${failing().map((c) => c.name).join(", ")}`}</span>
                </text>
              ) : null}
            </box>
          </Show>
          {error() || notice() ? (
            <text fg={error() ? t().danger : t().ok} wrapMode="word">
              {error() ?? notice()}
            </text>
          ) : null}
          <box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
            {form() ? (
              <box flexDirection="column" flexShrink={0} border borderStyle="rounded" borderColor={t().border} paddingLeft={1} paddingRight={1} marginBottom={1}>
                <text fg={t().muted}>{(form() as Form).kind === "pr" ? "New pull request" : "Stack a new pull request"}</text>
                <text fg={t().text2}>{FIELD_LABEL[(form() as Form).field]}</text>
                <input
                  focused
                  flexGrow={1}
                  placeholder={FIELD_LABEL[(form() as Form).field]}
                  textColor={t().text}
                  backgroundColor={t().surface}
                  focusedBackgroundColor={t().surface}
                  value={fieldOf(form() as Form)}
                  onInput={(value: string) => setForm((cur) => (cur ? setField(cur, value) : cur))}
                />
                <text fg={t().muted}>Enter next · Esc cancels the form</text>
              </box>
            ) : null}
            {stack()?.layers.length ? (
              <>
                <text fg={t().muted} flexShrink={0}>
                  <b>Stack</b>
                  <span style={{ fg: t().border }}>{"  merged bottom-up, each layer after the one below it"}</span>
                </text>
                <For each={stack()?.layers ?? []}>
                  {(layer) => (
                    <text wrapMode="none" truncate>
                      <span style={{ fg: t().text }}>{`#${layer.pr} `}</span>
                      <span style={{ fg: t().text2 }}>{clip(layer.title, 40)}</span>
                      <span style={{ fg: layerWord(layer.state) === "merged" ? t().ok : layerWord(layer.state) === "closed" ? t().danger : t().accent }}>{`  ${layerWord(layer.state)}`}</span>
                      <span style={{ fg: t().muted }}>{`  → ${layer.baseBranch}${layerChecks(layer) ? `  ${layerChecks(layer)}` : ""}`}</span>
                    </text>
                  )}
                </For>
              </>
            ) : null}
            {checks().length > 0 ? (
              <>
                <text fg={t().muted} flexShrink={0} marginTop={1}>
                  <b>Checks</b>
                </text>
                <For each={checks()}>
                  {(c) => (
                    <text wrapMode="none" truncate>
                      <span style={{ fg: t().text2 }}>{c.name}</span>
                      <span style={{ fg: checkFailed(c.state) ? t().danger : c.state === "pass" ? t().ok : t().warn }}>{`  ${c.state}`}</span>
                    </text>
                  )}
                </For>
              </>
            ) : null}
          </box>
          <text flexShrink={0} fg={t().muted} marginBottom={1}>
            {busy()
              ? `${busy()}…`
              : `p push · n new PR · s stack · M merge stack · w ${watched() ? "unwatch" : "watch"} · t tour${failing().length > 0 ? " · x repair" : ""} · r refresh · Esc close`}
          </text>
        </>
      )}
    </box>
  );
}
