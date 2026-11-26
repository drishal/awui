# Finding and fixing a part of the web UI

How to go from "this part of the UI is broken" (or "looks off") to the file
that draws it, a way to see it without touching anyone's real chats, and a
check that the fix holds. The rules in AGENTS.md (House style, Web UI) still
apply: no hard-coded colours, no inline styles (the CSP refuses them), every
control reachable by keyboard and named for screen readers.

## 1. Wrong data, or wrong drawing?

The server decides **what** is shown; the web UI only decides **how**.

- **Wrong content** (a missing tool call, a reply in the wrong place, a
  duplicated message, a stale status) usually comes from the server: the
  adapter that translated the harness (`src/server/harness/<id>.ts`, see
  docs/harnesses.md) or the reducer that folds its events into items
  (`src/server/chats/chat.ts`). Check the chat's items first:
  `curl -s http://127.0.0.1:4783/api/chats/<chatId> | python3 -m json.tool`.
  Turns are grouped on the client in `src/web/turns.ts` (shared with atui), so
  a turn-level ordering bug lives there.
- **Wrong drawing** (size, spacing, colour, overflow, a control that does not
  respond) is the component and its stylesheet below.

What the client gets: `/api/bootstrap` (harnesses with their capabilities,
colours, and setup commands; the theme; UI settings; workspace roots; limits)
once, then for the open chat
a snapshot plus live events over SSE (`chat-stream.ts`, `stream.ts`).
Components draw from those; they never call a harness.

## 2. Where each part lives

`App.tsx` is the shell: it owns which chat is shown and hands each region its
props. Styles are `src/web/styles/*.css`, imported in cascade order by
`src/web/styles.css`. Find a class's rules with
`rg -n '^\.<class>\b' src/web/styles/`: a few areas keep rules in a file named
after another section (an embedded page's under subagents.css, dialogs under
banners-dialogs.css), so search rather than guess.

| Region | Components | Main styles | Covered by |
|---|---|---|---|
| Page frame, header (the "2 devices" count, its two control groups, the offline status word), the optional status bar | `App.tsx`, `StatusBar.tsx` | `app-frame.css`, `header.css` | `app.spec.ts`, `context-and-viewers.spec.ts` |
| Sidebar: harness, projects, sessions, quick filter chips (`sidebar-filter.ts`), its two views (`sidebar-view.ts`, and the flat list's model in `recent-view.ts`) | `Sidebar.tsx`, `HarnessMenu.tsx`, `SessionCard.tsx`, `SidebarResizer.tsx`, `WorkingRing.tsx` | `sidebar.css`, `session-card.css` | `app.spec.ts`, `tabs.spec.ts`, `sidebar-filter.spec.ts`, `sidebar-recent.spec.ts`, `sidebar-separation.spec.ts` |
| Session tabs: chats and rooms (drag to reorder, pin) | `TabStrip.tsx` (order logic: `tab-order.ts`) | `session-tabs.css` | `tabs.spec.ts`, `board.spec.ts` |
| Timing: a turn's time as a waterfall (opened from the answer's row, and by the context chip's **Show more**) | `TurnTiming.tsx` (over `Dialog.tsx`) and `TimingView.tsx`, which the chip's full view draws too; rows and axis in `waterfall.ts` | `timing.css` (and `usage-details.css` inside the chip's dialog) | `turn-timing.spec.ts`, `context-and-viewers.spec.ts` |
| Conversation: turns, answers, thoughts | `Conversation.tsx`, `CopyButton.tsx`, `Markdown.tsx`, `CodeBlock.tsx`, `QuoteButton.tsx`, `TurnRail.tsx`, `StickyPrompt.tsx` (`sticky-prompt.ts`), a turn's time on hover (`turn-time.ts`), Copy turn as Markdown (`turn-markdown.ts`) | `conversation.css`, `controls.css` (the copy morph) | `app.spec.ts`, `usage-and-actions.spec.ts` |
| Tool card: the "Worked for …" header, icon stack, and tool rows (diffs, terminals in their bodies) | `ProcessFold` and `ToolRow` in `Conversation.tsx`, `ToolBody.tsx`, `Collapse.tsx` (every fold's grow and shrink); a call's sentence (`shared/tool-row.ts`), facts read from its output (`shared/output-facts.ts`), the icon stack's kinds (`tool-kinds.ts`), Ask to retry (`tool-retry.ts`), the working phase (`working-phase.ts`) | `tool-card.css` (over `conversation.css`'s `.process`/`.drow`) | `app.spec.ts` (tool cards), `tool-card.spec.ts`, `tool-card-more.spec.ts` |
| A file path's hover preview | `FileLink.tsx` (shared by every path link) → `FilePreview.tsx`; delay and placement in `hover-card.ts` (also the sidebar's session card) | `file-viewer.css` (`.file-preview*`) | `json-and-preview.spec.ts` |
| JSON arguments and results as a tree | `JsonTree.tsx` (rows from `json-tree.ts`), drawn by `ToolBody.tsx` | `conversation.css` (`.json-*`), colours `.tk-*` in `file-viewer.css` | `json-and-preview.spec.ts` |
| Subagents, agent-rendered pages, plans | `Subagents.tsx`, `HtmlRenderFrame.tsx`, `PlanCard.tsx` | `subagents.css`, `plan-card.css` | `app.spec.ts`, `composer-extras.spec.ts` |
| Empty chat, opening a chat | `App.tsx` (hero), `SwitchSplash.tsx`, `Loader.tsx` | `hero.css`, `opening-chat.css`, `loader.css` | `app.spec.ts`, `tabs.spec.ts` |
| Composer card and its row of controls | `Composer.tsx`, `ChipEditor.tsx` (the box, its chips: `draft-chips.ts`, long pastes: `paste-ranges.ts`), `ComposerControls.tsx`, `ModelPicker.tsx`, `ThinkingPicker.tsx`, `PermissionPicker.tsx`, `HarnessMenu.tsx` (chip), `ContextRing.tsx` (the draft size beside it: `token-estimate.ts`; the panel's sparkline: `sparkline.ts`; its **Show more** opens `ContextDetails` in that file, which draws `DetailsBody` (the dashboard cards) over `TimingView.tsx`) | `composer.css`, `usage-details.css` (the full dialog), `model-picker.css` | `app.spec.ts`, `composer-extras.spec.ts`, `context-and-viewers.spec.ts` |
| Composer extras: stash, link note, usage-limit banner, dropped files (`@path` by name, the Add-to-project note) | `Composer.tsx`, `LimitRecovery.tsx` (drops: `file-drop.ts`, `upload.ts`) | `composer-extras.css` | `composer-extras.spec.ts` |
| Status stack (todos, queue, chain, the live agents/jobs strip), the direnv row (top), and the git row (base) | `StatusStack.tsx` (the strip's counts: `job-progress.ts`), `GitStatusView.tsx` (`GitRow`, `DirenvRow`; the poll: `git.ts`) | `status-stack.css`, `queue-edit.css`, `chain.css` | `app.spec.ts`, `unified.spec.ts`, `direnv.spec.ts` |
| Delegated tasks: the parent's rows (state chip, agent, clock, Open / Cancel) in that stack | `DelegatedTasks.tsx` (its words: `delegated-tasks.ts`), fed by `chat-state.ts`'s `task` fold; the child's lineage chip is `LineageChip.tsx` in the chat header | `tasks.css`, `header.css` | `delegated.spec.ts` |
| Approvals and questions | `ApprovalStack.tsx` | `approvals.css` | `app.spec.ts` |
| Themes: the sidebar's theme menu, Settings' scheme cards, the theme editor, swatches | `ThemeMenu.tsx`, `ThemeLibrary.tsx`, `ThemeEditor.tsx`, `ThemeSwatch.tsx`; the shared list in `themes.ts`, the page preview in `theme.ts` | `themes.css` | `themes.spec.ts` |
| Dialogs: settings (a rail of sections, the open one, and one Save bar under both), folders, restore, palette, images | `Dialog.tsx`, `SettingsDialog.tsx` (its search's matching: `settings-search.ts`), `WorkspacePicker.tsx`, `RestoreDialog.tsx`, `HerdrDialog.tsx`, `CommandPalette.tsx`, `ImageViewer.tsx`, `LoginForm.tsx` | `banners-dialogs.css`, `settings.css` | `settings.spec.ts`, `app.spec.ts`, `herdr.spec.ts`, `remote-login.spec.ts` |
| Searches: every chat, in project, find in chat | `ChatSearch.tsx`, `ProjectSearch.tsx`, `find.ts` | `chat-search.css`, `project-search.css`, `find.css` | `unified.spec.ts`, `composer-extras.spec.ts` |
| File viewer, review (threads on diff lines, their pins in `review.ts`), file timeline | `FileViewer.tsx`, `ReviewPanel.tsx`, `TimelineDialog.tsx` | `file-viewer.css`, `banners-dialogs.css`, `timeline.css` | `unified.spec.ts`, `review.spec.ts` |
| Usage and limits (the heatmap of days: `heatmap.ts`) | `UsageDialog.tsx`, `LimitsMeter.tsx` | `usage.css` | `unified.spec.ts`, `usage-and-actions.spec.ts` |
| Saved prompts, shortcuts | `SavedPromptsDialog.tsx`, `ShortcutSheet.tsx` | `saved-prompts.css`, `shortcuts.css` | `unified.spec.ts` |
| A chat beside the main one | `SidePane.tsx` | `side-pane.css` | `unified.spec.ts` |
| Notice cards (finished, needs you, Undo): stacked, fanned on hover, swiped away on a phone; docked 12 px above the composer's stack or sticky prompt and left of the context rail, gone once you open their chat; a chat's name in the words (`notice-name.ts`: a title two chats share carries its project and age) | `ToastStack.tsx` (`toast-stack.ts`) | `toasts.css` | `toasts-and-swipes.spec.ts`, `tabs.spec.ts`, `notice-name.test.ts` |
| Board rooms: sidebar section, room view (bot runs drawn as chat turns through `Conversation.tsx`'s `RunTranscript`, consultation folds, approvals), editors | `RoomList.tsx`, `RoomView.tsx`, `RoomHeader.tsx` (its pane-header status and actions, in `App.tsx`), `RoomConversation.tsx`, `BotRun.tsx`, `RoomComposer.tsx`, `RoomMembers.tsx`, `BotEditor.tsx`, `RoomEditor.tsx` (fold: `room-state.ts`; stream: `use-room-stream.ts` over `stream.ts`'s shared core; mentions: `room-mentions.ts`) | `board.css` | `board.spec.ts` |
| Project tools: worktrees, isolated comparison, and a comparison's races | `WorktreePicker.tsx`, `CompareDialog.tsx`, `RacePanel.tsx` (a race's rows, file diffs, winner pick, loser cleanup); checkout lifecycle and metadata in server `worktrees.ts`, race records and their git in server `races.ts`; root lookup revalidation in `workspaces.ts` | `worktrees.css`, `banners-dialogs.css` | `worktrees.test.ts`, `races.test.ts`, `workspace-features.test.ts`, `api.test.ts`, `race.spec.ts` |
| Terminal: interactive workspace PTY | `TerminalPanel.tsx` and `terminal-shell.ts` (its iframe document) in the web client; `server/terminal.ts` lifecycle/replay | `terminal.css`, `terminal-shell.css` | `terminal-state.test.ts`, `workspace-features.test.ts` |
| GitHub push, existing/new PR, checks | `GitHubPanel.tsx`, server `github.ts` | `github.css` | `github-workflow.test.ts` |
| Live session and room metadata | `sessions.ts`, `rooms.ts`, `overview-stream.ts`, shared `overview-events.ts` | `SessionOverviewEvent` in `shared/protocol.ts`; server `overview-events.ts` | `overview-stream.test.ts`, `overview-events.test.ts` |
| Agent-rendered page visual preview | `HtmlRenderFrame.tsx`, server `render-preview.ts` | `subagents.css`, bounded in-memory Chromium only | `render-preview.test.ts`, `workspace-features.test.ts` |
| Heavy auxiliary dialogs | `SettingsDialog.tsx`, `UsageDialog.tsx`, `TimelineDialog.tsx`, `RoutinesDialog.tsx`, board and project tools loaded through App.tsx's lazy boundaries | their area stylesheets; desktop chunks load only on open | build + relevant feature specs |
| Phones: drawer, sheets, long press, row swipe actions | `ActionSheet.tsx`, `gestures.ts` (`useRowSwipe` in `Sidebar.tsx`'s rows) | `phones.css`, `responsive.css`, `sidebar.css` | `phone.spec.ts`, `toasts-and-swipes.spec.ts` |
| Current-chat context rail and details | `ContextPanel.tsx` (a summary card whose last row opens review, then one card per group) over the shared rows and cards in `ContextRows.tsx`; derived facts, status words, and project summary in `context-panel.ts`; `App.tsx`'s outer context-work slot outside the original split; `styles/context-panel.css`; native `tool-row`/`request-row` ids attach directly to original tools and permission form, and race/comments/second-opinion interactions keep their existing owning views | 40px collapsed rail with count badges that opens its 240–280px detail (20vw, so the transcript keeps its measure) only while it has a row to show or the chevron asks for it, the usage group open by default around one 44px row with the context pie with its percentage-bearing accessible name and no extra bar or rail percentage, gives its detail back to native side/work panels, phone shows same details in `Dialog`; a group with nothing to say is left out rather than drawn as an empty "0", and a rail with nothing at all says so in one muted line; every fold saved through browser preference `context.folds` | `tests/e2e/context-panel.spec.ts`, `tests/unit/context-panel.test.ts` |
| Motion and the ripple (turn entrance, streaming caret, start-screen mark) | `ripple.ts`, `arrivals.ts`, `morph.ts` (a box handed from one mount to the next: start screen → chat, a sidebar title → the header; `glide()` for the sidebar's active wash; `viewTransition()` for a tab, settings, dashboard or work-panel swap) | `motion.css`, `ripple.css`, `view-transition.css`, `glass.css` (the frosted composer, status stack and command menu; the sticky prompt stays opaque) | `app.spec.ts`, `motion.spec.ts`, `start-screen.spec.ts`, `shell-motion.spec.ts` |

Every component opens with a comment saying what it draws and why it is
shaped that way; read it before changing the file.

**Narrow screens and touch.** `responsive.css` (≤ 819 px: one column, the
sidebar becomes a drawer) and `phones.css` (touch sizes, sheets) override the areas
imported before them; the areas imported after them carry their own `@media`
rules. A fix that looks right on a desktop can be undone there: check both.

## 3. The design tokens

All in `src/web/styles/tokens.css`. A base16 theme replaces the base colours
(`theme.ts`); everything else is mixed from them, so a fix uses a token, never
a literal colour.

- **Harness marks and status dots:** the harness selectors (`HarnessMenu`, the start screen agent chip, and the phone config sheet) draw `HarnessMark.tsx`: a small locally bundled monochrome PNG mask in the harness accent, or the neutral ACP glyph for an unknown/custom id. Custom ACP marks come from Settings via `harness-icon-upload.ts` → a 64 × 64 PNG stored through `server/harness-marks.ts` (bounded, validated on read/write, versioned by content hash). Their inlay is not the running state; session rows/tabs keep the tiny identity dots, working rings, unread marks, and status explanations. Built-in icons are under `public/harness-marks/`, with exact source links and notices. The browser never downloads an icon registry. New harnesses add a mark only if their identity needs one, with docs/harnesses.md's file rows.
- **Colours:** `--bg`, `--surface`, `--surface-2`, `--text`, `--text-2`,
  `--muted`, `--accent`, `--link`, `--ok`, `--warn`, `--danger`; derived
  `--hairline`, `--hairline-strong`, `--hover`, `--active`, and `--raised` (a
  face that sits above its track, like a segmented control's chosen pill: the
  surface on a light page, lightened on a dark one); `--dock-face` (glass.css) is
  the composer's own face, shared by the status stack and a lone branch lane so the
  dock stands at one height in every scheme. A harness's colour
  is `--harness`, set per element by `harnessColor()` from its `accent`.
- **Radii:** `--r-xs` 4, `--r-sm` 8, `--r-control` 8, `--r-md` 10, `--r-lg` 12,
  `--r-xl` 14, `--r-panel` 16 (px). A radius says what a thing is: controls
  (buttons, chips, segmented choices, pickers) take `--r-control`, in-page tiles
  `--r-md`, menus `--r-lg`, dialogs and the prompt bubble `--r-xl`, the
  status dock over it (at its width) and the approval card `--r-panel`, and the
  composer one step rounder still (`--r-panel` + 4 px): it is the page's
  softest object, and the difference is what separates it from the cards above
  it. `999px` / `50%` is only for a dot or a single glyph (send, switches,
  status dots, the context ring).
- **Widths:** `--col` 960 px (review drawers), `--chat-col` (the conversation
  and composer; config.yml's `chat_width`), `--sidebar-w`.
- **Density:** `--row-h`, `--head-h`, `--section-gap`, `--gap-turn`, `--gap-process`,
  `--drow-h`, `--composer-pad-*`, `--tab-h` (sidebar rows, turn and tool-row
  spacing, composer, tab strip). config.yml's `density: compact` sets
  `data-density="compact"` on `<html>`, and `tokens.css` overrides them there,
  for a fine pointer only (touch keeps the comfortable sizes). Use a token, not
  a literal, for a new row height or gap.
- **Sidebar rows:** one line per row is the list's shape: a title at 13.5px cut
  with an ellipsis, a row 32px tall (48px when it carries its subline — the
  project tag, the agent's line, or a branch off the trunk), 2px between rows,
  no hairline or rail, and a 26px gutter at the right for the ⋯ so the age
  never moves under the pointer. `session-state.ts` decides that subline.
  `config.yml`'s `sidebar_style: compact` sets `data-sidebar="compact"` on
  `<html>`, and `sidebar.css` ends with the handful of overrides that make the
  rows tighter still (28px, the subline as a dim suffix after the title, 1px
  between rows). It changes the row look only: heads, chips, hover cards, and
  the wash keep their own rules, and a phone's row is still 44px tall.
- **Sidebar list:** the sidebar draws one of two views (`sidebar-view.ts`, saved
  per browser; the filter menu's switch writes it). Recent, the default, is one
  flat list across the shown harness's projects: the needs-you, working and
  pinned sections above, then `recent-view.ts`'s page — calendar headings from
  `session-groups.ts`'s `dateGroup`, rows newest first, each with the project it
  is out of as its tag, 12 rows and then 20 per "Show more". Projects is the
  grouped list (`groupByProject`, `focusProject`), where focus mode, the folder
  heads and drag order live; `GroupOptions`' place rules (what needs you, what
  works, what is pinned, and the settled/snoozed/archived toggles) apply to both.
- **Text:** `--chat-font` = 14.5 px × `--chat-scale` (config.yml's text size).
  A small uppercase section label (Recent, Todos, Actions) is 600 weight at
  `--label-size` with `--label-tracking`, in `--muted-text`; headings (the chat
  title, dialog titles, the start screen) take `--tracking-tight`.
- **Control sizes:** the composer's row is 32 px tall on every screen, its
  chips and icon buttons at `--r-control`, and Send a round 40 px (the row's one
  control a size larger; the composer is the exception to `phones.css` raising
  touch targets to 36–44 px elsewhere: a phone keeps its one slim row at 32 px,
  and its folded card still names the model and the level in the settings chip,
  which opens the chat-settings sheet).
  Keep a row of controls one height: mismatched heights and radii are what makes a
  part "look off".
- **Motion:** short and eased out; `prefers-reduced-motion` turns it all off
  (the rule at the end of `tokens.css`).
- **Colour jobs (one hue, one job):** identity `--harness` (a dot, a chip wash,
  a spinner — never body text or a large fill); attention `--warn` (needs you,
  approvals, questions — never ordinary emphasis); outcome `--ok`/`--danger`
  (added/removed, pass/fail, done/failed, Stop — never tool categories);
  category `--cat-look`/`--cat-write`/`--cat-run`/`--cat-web`/`--cat-agent`/
  `--cat-plan` (tool glyphs and kind-stack glyphs only — never row backgrounds,
  labels, or paths); live/primary `--accent` (Send with a draft, focus — never
  state). `--info` is the cyan "look" hue; `--brown` (base0F) and `--rare` are
  harness hues, never status. Tints (`--tint` 10 %, `--tint-strong` 14 %,
  `--edge` 40 %) build `--tone-wash`/`--tone-edge` from a per-element `--tone`
  on the element that sets it; usage heat uses `--heat-0..4`; project badges
  `--badge-1..4`.
- **Restraint:** at rest ≤ 3 accent hues per region; only running and failed
  tool rows tint their row; the approval card is the loudest object; answer
  prose, paths, timestamps, model names, section labels, and card backgrounds
  stay grey. Never colour alone: glyph, word, and shape stay.
- **The composer's chip row:** one split pill carries the chat's identity and its two
  settings. Its leading segment is the harness mark (a `--lead-tint` 12 % wash and a
  `--lead-edge` 32 % edge, in `--harness`; the harness's name is the header's and the
  sidebar's job, and stays in the button for screen readers). Beside it a neutral
  segment holds the model and the reasoning level as one sentence, "Fake Echo · Low":
  no fill of its own, one chevron on its last segment, and the level's word carries
  the effort (its ink ramps on `--thinking` from medium up; the level's own wash is
  gone inside the pill). The harness's default permission mode is a quiet 32 px
  shield beside the pill, with its mode in the tooltip and the accessible name; a mode
  that stops asking keeps its word and its warn wash (the harness segment then keeps
  just its mark). Send is the row's one solid and the one control a size larger, 40 px
  round. The row carries `data-harness-accent`: a harness whose accent is `thinking`
  (omp, Awui) ramps reasoning in grey, and one whose accent is `ok` (DeepSeek Harness)
  gets a grey shield, so no two parts ever share a hue.

- **Where the effort slider sits:** `EffortSlider.tsx` is the slider alone; `ThinkingPicker.tsx` wraps it in the composer's pill and popover (the chat's own level), and `ModelPicker.tsx` draws it inline as the footer of the model list (the level a new chat starts on, on the start screen and in Board rooms), where its first stop is "Model default" and a model with other levels is a new slider. A change still settling is sent when its surface closes, never on a model switch (the stops it belonged to are gone).
- **The effort slider's liquid:** the bead and its shadow share a transform. An analytic SVG neck must taper into the bead, not become a thin stick between two circles; its gap stays at most 22 px. The violet wash follows the bead by a bounded lag and reaches a stop before that stop turns violet. Ring only an actual bead-centre crossing, with at most two live animations per dot. `effort-spring.ts` and `effort-slider.spec.ts` own the geometry, containment, crossing, focus and fallback checks. Reduced motion and low-end coarse pointers use the static slider, including its selected-stop coloring. Test forced-colors strokes against the computed system `Highlight`, not a hard-coded RGB value.

## 4. See it without touching real chats

The user's server (port 4783) holds their live chats: look at it, don't
experiment on it. Run a sandbox with the fake harnesses instead, in tmux, and
tear it down afterwards:

```bash
npm run build                                   # the built UI; or use npm run dev below for hot reload
SB=$(mktemp -d); mkdir -p $SB/projects/demo $SB/state
tmux new-session -d -s awui-sandbox "AWUI_CONFIG_DIR= AWUI_HARNESSES=fake,fake-b AWUI_HERDR=0 \
  PORT=4795 WORKSPACE_ROOTS=$SB/projects XDG_STATE_HOME=$SB/state node dist/server/server/index.js"
B=http://127.0.0.1:4795
WS=$(curl -s -X POST $B/api/workspaces/open -H 'content-type: application/json' \
  -d "{\"path\":\"$SB/projects/demo\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
CID=$(curl -s -X POST $B/api/chats -H 'content-type: application/json' \
  -d "{\"harnessId\":\"fake\",\"workspaceId\":\"$WS\"}" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read(),strict=False)["chatId"])')
curl -s -X POST $B/api/chats/$CID/messages -H 'content-type: application/json' \
  -d '{"text":"make a todo list and edit things","mode":"normal"}'
# … look, measure, fix …
tmux kill-session -t awui-sandbox                # then check: nothing listens on 4795
```

With the same variables, `npm run dev` serves the UI from Vite on
http://127.0.0.1:5173 with hot reload instead.

The fake harness answers scripts chosen by words in the prompt, so any state
can be produced on demand: `tool`, `edit`, `showcase` (one call of every tool
kind), `todo`, `ask` (an approval), `quiz` (a question), `formquestion` (one whole HTML form), `subagents`, `planned`,
`ratelimit`, `slow` (to act mid-run), `fail`, and the rest listed in
`src/server/harness/fake.ts` and AGENTS.md (Testing). `fake-b` declares fewer
capabilities, for checking what hides.

## 5. Measure it

```bash
node scripts/ui-shot.mjs "$B/#chat=$CID" ".composer" /tmp/composer.png            # desktop, dark
node scripts/ui-shot.mjs "$B/#chat=$CID" ".composer" /tmp/composer-phone.png --phone
```

It prints every control inside the selector with its size, radius, padding,
and font, and saves a screenshot of that element (`--phone`, `--narrow`,
`--light` switch the viewport and scheme). Read the numbers before the
picture: the composer once mixed 30 px pills, a 34 px send button, square and
round hovers, and a chip narrower than it was tall, and the table showed all of
it at a glance. Run it inside `devenv shell` on NixOS (Playwright's browsers
come from nixpkgs). For the full set of reference frames, use
`AWUI_SCREENSHOTS=<dir> npx playwright test screenshots`.

## 6. Check the fix

- Measure again: the numbers you meant to change changed, and nothing else.
- `npm run typecheck`, then the e2e spec that covers the region (table above):
  `npx playwright test tests/e2e/<spec> --reporter=line` after `npm run build`.
  The whole suite (`npm run test:e2e`, ~3 min) before a commit that moves
  layout.
- Look at a phone viewport and at the light scheme; tab through the controls
  you touched.
- For a pure move of CSS (splitting or reordering files), build before and
  after and compare `dist/web/assets/index-*.css`: it must be byte for byte the
  same.
