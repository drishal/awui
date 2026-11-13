// GitHub in the Tern client: the web panel's GitHub as a Tern overlay — the
// branch and its upstream, the current PR with its checks (the tally and the
// failing names), push, watch, the CI-repair offer, the stack with its layers
// and its bottom-up merge, the forms for a new PR and a stacked one, and the
// guided file-by-file PR tour. The words are the shared rule's
// (shared/github-words.ts); this file lays them out and holds the screen's own
// state (which form is open, which of its fields takes the keys, where the
// tour stands). Tern never takes the keyboard: app.ts routes the keys and
// calls the routes.
import { span, ui, type Node } from "@stencil-hq/tern";
import type { GitHubCheckView, PrStack, Tour } from "../shared/protocol.js";
import { checkWords, layerChecks, layerWord, mergeable, prNumberOf, upstreamWords } from "../shared/github-words.js";
import { unifiedDiff } from "../atui/format.js";

/** What the server's own github status says (the web panel's Status shape). */
export interface GithubStatusView {
  available: boolean;
  reason?: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  remoteUrl: string | null;
}

/** The screen's own state: null while closed (app.ts holds the signal). */
export interface GithubState {
  status: GithubStatusView | null;
  checks: GitHubCheckView[];
  pr: { url: string; title: string; state: string; isDraft: boolean } | null;
  stack: PrStack | null;
  /** This chat's one watch's URL, when it watches the current PR. */
  watchedUrl: string | null;
  /** The action in flight ("push", "load", "pr", "merge", "repair", "watch"). */
  busy: string | null;
  form: GithubForm | null;
  tour: TourView | null;
}

export const githubState = (): GithubState => ({ status: null, checks: [], pr: null, stack: null, watchedUrl: null, busy: null, form: null, tour: null });

/** A form's fields: which one is being typed, and what each holds so far. */
export interface GithubForm {
  kind: "pr" | "stack";
  field: "above" | "base" | "title" | "body";
  above: string;
  base: string;
  title: string;
  body: string;
}

export const githubForm = (kind: "pr" | "stack"): GithubForm => ({ kind, field: kind === "pr" ? "title" : "above", above: "", base: "main", title: "", body: "" });

/** The form's active field's value, and the field Enter moves to (`null` submits). */
export function formValue(form: GithubForm): string {
  return form.field === "above" ? form.above : form.field === "base" ? form.base : form.field === "title" ? form.title : form.body;
}

export function editForm(form: GithubForm, text: string): GithubForm {
  return { ...form, ...(form.field === "above" ? { above: text } : form.field === "base" ? { base: text } : form.field === "title" ? { title: text } : { body: text }) };
}

/** Enter's next field, or `null` when the form is complete and submits. */
export function nextField(form: GithubForm): string | null {
  if (form.kind === "pr") return form.field === "title" ? "base" : form.field === "base" ? "body" : null;
  if (form.field === "above") return form.above.trim() === "" ? "base" : "title";
  return form.field === "base" ? "title" : form.field === "title" ? "body" : null;
}

/** The guided tour's own state: the guide, its staleness, and where the reading stands. */
export interface TourView {
  tour: Tour;
  stale: boolean;
  position: number;
  loading: boolean;
}

/** The tour's scroll body node id, for `surface.scroll`. */
export const TOUR_SCROLL_ID = "layer.tour.body";

/** The form's input node id (one field at a time, always the same node), for `surface.focus`. */
export const GITHUB_INPUT_ID = "layer.github.body.form.field";

export interface GithubCx {
  state: GithubState;
  /** The chat that watches and repairs (its session binds a watch; its harness starts a repair chat). */
  hasSession: boolean;
  harnessId: string | null;
  readOnlyHarness: boolean;
  on: {
    close: () => void;
    refresh: () => void;
    push: () => void;
    watch: () => void;
    unwatch: () => void;
    repair: () => void;
    merge: () => void;
    /** Copy the PR's URL (a terminal cannot open a browser; Tern's links click through). */
    copyPr: () => void;
    tour: () => void;
    form: (kind: "pr" | "stack") => void;
    text: (text: string) => void;
    submit: () => void;
    cancelForm: () => void;
  };
}

const STATE_TONE: Record<string, string> = { open: "warning", merged: "success", closed: "error", draft: "muted" };

const STATE_WORD: Record<string, string> = { pass: "success", fail: "error", failure: "error", pending: "warning", running: "warning", skipping: "muted", cancel: "error" };

/** One check row: its name, its state in the state's colour, and View beside it when the link is known. */
function checkRows(checks: readonly GitHubCheckView[]): Node[] {
  return checks.map((c, i) =>
    ui.row({ key: `c${i}`, gap: "sm", align: "center" }, ui.text({ key: "n", grow: 1, truncate: "end" }, c.name), ui.text({ key: "s" }, span(c.state, STATE_WORD[c.state.toLowerCase()] ?? ""))),
  );
}

/** One stack layer: its number and title, its state, what it targets, and its checks. */
function layerRows(stack: PrStack): Node[] {
  return stack.layers.map((layer, i) =>
    ui.row(
      { key: `l${i}`, gap: "sm", align: "center" },
      ui.text({ key: "t", grow: 1, truncate: "end" }, [span(`#${layer.pr} `, "strong"), span(layer.title)]),
      ui.text({ key: "s" }, span(layerWord(layer.state), STATE_TONE[layerWord(layer.state)] ?? "")),
      ui.text({ key: "b" }, span(`→ ${layer.baseBranch}`, "muted")),
      ui.text({ key: "c" }, span(layerChecks(layer), "muted")),
    ),
  );
}

/** The form card: the field being typed, what is typed so far, and the keys. */
function formNode(cx: GithubCx): Node {
  const form = cx.state.form as GithubForm;
  const value = formValue(form);
  const what = form.kind === "pr" ? "New pull request" : "Stack a new pull request";
  const field = form.field === "above" ? "Stack above (PR number, empty to start a stack on the base)" : form.field === "base" ? "Target branch" : form.field === "title" ? "Title" : "Description";
  const soFar =
    form.kind === "pr"
      ? `base ${form.base || "main"} · ${form.title || "no title yet"}`
      : form.above.trim() === ""
        ? `a stack on ${form.field === "above" ? "the base branch" : form.base} · ${form.title || "no title yet"}`
        : `above #${form.above} · ${form.title || "no title yet"}`;
  return ui.card(
    { key: "form", head: [span(what, "strong"), span(`  ${soFar}`, "muted")] },
    ui.text({ key: "f" }, span(field, "muted")),
    ui.input({ key: "field", text: value, cursor: value.length, placeholder: field, aria: field, onEdit: (e) => cx.on.text(e.text) }),
    ui.text({ key: "k" }, span("Enter next · Esc cancels the form", "muted")),
  );
}

/** The GitHub overlay: status, PR, checks, actions, and the stack. */
export function githubNode(cx: GithubCx): Node {
  const { status } = cx.state;
  const pr = cx.state.pr;
  const busy = cx.state.busy;
  const watched = cx.state.watchedUrl !== null && pr !== null && cx.state.watchedUrl === pr.url;
  const stack = cx.state.stack;
  const repairs = cx.state.checks.filter((c) => /fail|error|cancel|timeout/i.test(c.state));
  return ui.overlay(
    {
      key: "github",
      anchor: "center",
      size: "lg",
      head: "GitHub",
      ...(status?.branch ? { meta: `${status.branch}${status.upstream ? ` → ${status.upstream}` : ""}` } : {}),
      end: ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.text({ key: "keys" }, span("p push · r refresh · t tour · w watch · n new PR · s stack · m merge · Esc closes", "muted")),
    },
    ui.scroll(
      { key: "body", gap: "sm" },
      status === null
        ? ui.text({ key: "wait" }, span("Reading the repository's status…", "muted"))
        : !status.available
          ? ui.text({ key: "why" }, span(status.reason ?? "GitHub is not available on this machine. Install gh and log in on the server.", "error"))
          : null,
      status ? ui.text({ key: "b" }, [span(status.branch ?? "no branch", "strong"), ...(status.upstream ? [span(` → ${status.upstream}`, "muted")] : [])]) : null,
      status ? ui.text({ key: "u" }, span(upstreamWords(status), "muted")) : null,
      status?.remoteUrl ? ui.text({ key: "r" }, span(`Remote: ${status.remoteUrl}`, "muted")) : null,
      pr ? ui.row({ key: "pr", gap: "sm", align: "center" }, ui.text({ key: "u", grow: 1, truncate: "end" }, span(`Pull request: ${pr.url}`, "muted")), ui.button({ key: "copy", text: "Copy", size: "sm", variant: "quiet", onClick: cx.on.copyPr })) : null,
      ui.col(
        { key: "checks", gap: "xs" },
        ui.text({ key: "h" }, span("Checks", "strong")),
        ui.text({ key: "w" }, span(checkWords(cx.state.checks), "muted")),
        ...checkRows(cx.state.checks),
      ),
      ui.row(
        { key: "acts", gap: "sm" },
        ui.button({ key: "push", text: busy === "push" ? "Pushing…" : "Push current branch", disabled: !status?.available || !status?.branch ? "gh must be available and a branch checked out" : busy !== null ? "An action is running" : undefined, busy: busy === "push", onClick: cx.on.push }),
        ui.button({ key: "refresh", text: busy === "load" ? "Refreshing…" : "Refresh", variant: "quiet", size: "sm", disabled: busy !== null ? "An action is running" : undefined, busy: busy === "load", onClick: cx.on.refresh }),
        ui.button({ key: "tour", text: "Guided PR tour", variant: "quiet", size: "sm", disabled: !pr ? "No pull request for this branch yet" : busy !== null ? "An action is running" : undefined, onClick: cx.on.tour }),
      ),
      ui.row(
        { key: "acts2", gap: "sm" },
        pr
          ? ui.button({ key: "watch", text: watched ? "Unwatch this PR" : "Watch this PR", variant: "quiet", size: "sm", disabled: busy === "watch" ? "Registering…" : !cx.hasSession ? "Wait for this chat's native session, then register" : busy !== null ? "An action is running" : undefined, busy: busy === "watch", onClick: watched ? cx.on.unwatch : cx.on.watch })
          : null,
        repairs.length > 0
          ? ui.button({ key: "repair", text: "Offer CI repair", variant: "quiet", size: "sm", disabled: cx.readOnlyHarness ? "This harness only reads" : busy !== null ? "An action is running" : undefined, onClick: cx.on.repair })
          : null,
      ),
      pr && repairs.length > 0
        ? ui.text({ key: "repair-note" }, span(`Starts a new ${cx.harnessId ?? ""} chat with the failing checks and their evidence. The agent fixes only those and reports local results; no push happens automatically.`, "muted"))
        : null,
      stack && stack.layers.length > 0
        ? ui.col(
            { key: "stack", gap: "xs" },
            ui.text({ key: "h" }, [span("Stack ", "strong"), span(`(${stack.layers.length})`, "muted")]),
            ui.text({ key: "w" }, span("Merged bottom-up: each layer goes in after the one below it. Creating a stacked PR does not push or merge anything by itself.", "muted")),
            ...layerRows(stack),
            stack.mergedThrough ? ui.text({ key: "m" }, span(`Last merge went through #${stack.mergedThrough}.`, "muted")) : null,
            ui.button({
              key: "merge",
              text: busy === "merge" ? "Merging stack…" : "Merge stack bottom-up",
              disabled: !mergeable(stack) ? "No open layer left to merge" : busy !== null ? "An action is running" : undefined,
              busy: busy === "merge",
              onClick: cx.on.merge,
            }),
          )
        : null,
      ui.row(
        { key: "forms", gap: "sm" },
        ui.button({ key: "pr", text: "New pull request…", disabled: !status?.available ? "gh must be available" : busy !== null ? "An action is running" : undefined, onClick: () => cx.on.form("pr") }),
        ui.button({ key: "stack", text: "Stack above #N…", variant: "quiet", size: "sm", disabled: !status?.available ? "gh must be available" : busy !== null ? "An action is running" : undefined, onClick: () => cx.on.form("stack") }),
      ),
      status && !status.available ? ui.text({ key: "gh-note" }, span("The server must have gh installed and an authenticated account configured. awui never reads those credentials.", "muted")) : null,
      cx.state.form ? formNode(cx) : null,
    ),
  );
}

/** The guided tour overlay: one file at a time, source first, mechanical files last. */
export function tourNode(cx: { view: TourView; on: { close: () => void; step: (by: 1 | -1) => void; rebuild: () => void } }): Node {
  const { tour, stale, position, loading } = cx.view;
  const count = tour.files.length;
  const index = Math.min(Math.max(0, position), Math.max(0, count - 1));
  const file = tour.files[index];
  const body: (Node | null)[] = [
    ui.text({ key: "w" }, span("Source changes first, then tests, generated output, and mechanical files. A reading guide, not an approval.", "muted")),
    stale ? ui.text({ key: "stale" }, span("The PR has changed since this guide was made. Rebuild from the current head before judging it.", "warning")) : null,
    loading ? ui.row({ key: "load", gap: "sm", align: "center" }, ui.spinner({ key: "s" }), ui.text({ key: "t" }, span("Reading the PR diff…", "muted"))) : null,
    count === 0 && !loading ? ui.text({ key: "none" }, span("No textual file changes to tour. Inspect binary or metadata changes on GitHub.", "muted")) : null,
  ];
  if (file) {
    body.push(
      ui.row(
        { key: "file", gap: "sm", align: "center" },
        ui.text({ key: "p", grow: 1, truncate: "end" }, span(file.path, "strong")),
        ui.text({ key: "i" }, span(`${index + 1} of ${count} · ${file.bucket}`, "muted")),
        ui.button({ key: "re", text: loading ? "Checking…" : "Rebuild from current PR", size: "sm", variant: "quiet", disabled: loading ? "Rebuilding…" : undefined, busy: loading, onClick: cx.on.rebuild }),
      ),
    );
    body.push(file.diff ? ui.diff({ key: "d", text: unifiedDiff(file.path, file.diff), path: file.path }) : ui.text({ key: "note" }, span(file.note ?? "No text changes to render for this file. Inspect the full file on GitHub.", "muted")));
    body.push(
      ui.row(
        { key: "nav", gap: "sm" },
        ui.button({ key: "prev", text: "Previous file", size: "sm", disabled: loading || index === 0 ? "This is the first file" : undefined, onClick: () => cx.on.step(-1) }),
        ui.button({ key: "next", text: "Next file", size: "sm", disabled: loading || index >= count - 1 ? "This is the last file" : undefined, onClick: () => cx.on.step(1) }),
      ),
    );
  }
  if (tour.truncated) body.push(ui.text({ key: "trunc" }, span("This is a bounded reading view. Inspect the remaining changes before approving.", "muted")));
  return ui.overlay(
    {
      key: "tour",
      anchor: "center",
      size: "lg",
      head: "Review guide",
      meta: `#${tour.pr} · ${tour.title}`,
      end: ui.button({ key: "close", text: "Back to pull request", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.text({ key: "keys" }, span("]/[ or n/p file · b rebuild · Esc back", "muted")),
    },
    ui.scroll({ key: "body", gap: "sm" }, body),
  );
}

