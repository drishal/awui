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
| Page frame, header (the "2 devices" count), status bar | `App.tsx`, `StatusBar.tsx` | `app-frame.css`, `header.css` | `app.spec.ts`, `context-and-viewers.spec.ts` |
| Sidebar: harness, projects, sessions, quick filter chips (`sidebar-filter.ts`) | `Sidebar.tsx`, `HarnessMenu.tsx`, `SessionCard.tsx`, `SidebarResizer.tsx`, `WorkingRing.tsx` | `sidebar.css`, `session-card.css` | `app.spec.ts`, `tabs.spec.ts`, `sidebar-filter.spec.ts` |
| Session tabs: chats and rooms (drag to reorder, pin) | `TabStrip.tsx` (order logic: `tab-order.ts`) | `session-tabs.css` | `tabs.spec.ts`, `board.spec.ts` |
| Timing: a turn's time as a waterfall (opened from the answer's row, and by the context chip's **Show more**) | `TurnTiming.tsx` (over `Dialog.tsx`) and `TimingView.tsx`, which the chip's full view draws too; rows and axis in `waterfall.ts` | `timing.css` | `turn-timing.spec.ts`, `context-and-viewers.spec.ts` |
| Conversation: turns, answers, thoughts | `Conversation.tsx`, `CopyButton.tsx`, `Markdown.tsx`, `CodeBlock.tsx`, `QuoteButton.tsx`, `TurnRail.tsx`, `StickyPrompt.tsx` (`sticky-prompt.ts`), a turn's time on hover (`turn-time.ts`), Copy turn as Markdown (`turn-markdown.ts`) | `conversation.css`, `controls.css` (the copy morph) | `app.spec.ts`, `usage-and-actions.spec.ts` |
| Tool card: the "Worked for …" header, icon stack, and tool rows (diffs, terminals in their bodies) | `ProcessFold` and `ToolRow` in `Conversation.tsx`, `ToolBody.tsx`, `Collapse.tsx` (every fold's grow and shrink); a call's sentence (`tool-sentence.ts`), facts read from its output (`tool-facts.ts`), the icon stack's kinds (`tool-kinds.ts`), Ask to retry (`tool-retry.ts`), the working phase (`working-phase.ts`) | `tool-card.css` (over `conversation.css`'s `.process`/`.drow`) | `app.spec.ts` (tool cards), `tool-card.spec.ts`, `tool-card-more.spec.ts` |
| A file path's hover preview | `FileLink.tsx` (shared by every path link) → `FilePreview.tsx`; delay and placement in `hover-card.ts` (also the sidebar's session card) | `file-viewer.css` (`.file-preview*`) | `json-and-preview.spec.ts` |
| JSON arguments and results as a tree | `JsonTree.tsx` (rows from `json-tree.ts`), drawn by `ToolBody.tsx` | `conversation.css` (`.json-*`), colours `.tk-*` in `file-viewer.css` | `json-and-preview.spec.ts` |
| Subagents, agent-rendered pages, plans | `Subagents.tsx`, `HtmlRenderFrame.tsx`, `PlanCard.tsx` | `subagents.css`, `plan-card.css` | `app.spec.ts`, `composer-extras.spec.ts` |
| Empty chat, opening a chat | `App.tsx` (hero), `SwitchSplash.tsx`, `Loader.tsx` | `hero.css`, `opening-chat.css`, `loader.css` | `app.spec.ts`, `tabs.spec.ts` |
| Composer card and its row of controls | `Composer.tsx`, `ChipEditor.tsx` (the box, its chips: `draft-chips.ts`, long pastes: `paste-ranges.ts`), `ComposerControls.tsx`, `ModelPicker.tsx`, `ThinkingPicker.tsx`, `PermissionPicker.tsx`, `HarnessMenu.tsx` (chip), `ContextRing.tsx` (the draft size beside it: `token-estimate.ts`; the panel's sparkline: `sparkline.ts`; its **Show more** opens `ContextDetails` in that file over `TimingView.tsx`) | `composer.css`, `model-picker.css` | `app.spec.ts`, `composer-extras.spec.ts`, `context-and-viewers.spec.ts` |
| Composer extras: stash, link note, usage-limit banner, dropped files (`@path` by name, the Add-to-project note) | `Composer.tsx`, `LimitRecovery.tsx` (drops: `file-drop.ts`, `upload.ts`) | `composer-extras.css` | `composer-extras.spec.ts` |
| Status stack (todos, queue, chain, the live agents/jobs strip), the direnv row (top), and the git row (base) | `StatusStack.tsx` (the strip's counts: `job-progress.ts`), `GitStatusView.tsx` (`GitRow`, `DirenvRow`; the poll: `git.ts`) | `status-stack.css`, `queue-edit.css`, `chain.css` | `app.spec.ts`, `unified.spec.ts`, `direnv.spec.ts` |
| Delegated tasks: the parent's rows (state chip, agent, clock, Open / Cancel) in that stack | `DelegatedTasks.tsx` (its words: `delegated-tasks.ts`), fed by `chat-state.ts`'s `task` fold; the child's lineage chip is `LineageChip.tsx` in the chat header | `tasks.css`, `header.css` | `delegated.spec.ts` |
| Approvals and questions | `ApprovalStack.tsx` | `approvals.css` | `app.spec.ts` |
| Dialogs: settings (a rail of sections, the open one, and one Save bar under both), folders, restore, palette, images | `Dialog.tsx`, `SettingsDialog.tsx` (its search's matching: `settings-search.ts`), `WorkspacePicker.tsx`, `RestoreDialog.tsx`, `HerdrDialog.tsx`, `CommandPalette.tsx`, `ImageViewer.tsx`, `LoginForm.tsx` | `banners-dialogs.css`, `settings.css` | `settings.spec.ts`, `app.spec.ts`, `herdr.spec.ts`, `remote-login.spec.ts` |
| Searches: every chat, in project, find in chat | `ChatSearch.tsx`, `ProjectSearch.tsx`, `find.ts` | `chat-search.css`, `project-search.css`, `find.css` | `unified.spec.ts`, `composer-extras.spec.ts` |
| File viewer, review, file timeline | `FileViewer.tsx`, `ReviewPanel.tsx`, `TimelineDialog.tsx` | `file-viewer.css`, `timeline.css` | `unified.spec.ts` |
| Usage and limits (the heatmap of days: `heatmap.ts`) | `UsageDialog.tsx`, `LimitsMeter.tsx` | `usage.css` | `unified.spec.ts`, `usage-and-actions.spec.ts` |
| Saved prompts, shortcuts | `SavedPromptsDialog.tsx`, `ShortcutSheet.tsx` | `saved-prompts.css`, `shortcuts.css` | `unified.spec.ts` |
| A chat beside the main one | `SidePane.tsx` | `side-pane.css` | `unified.spec.ts` |
| Notice cards (finished, needs you, Undo): stacked, fanned on hover, swiped away on a phone | `ToastStack.tsx` (`toast-stack.ts`) | `toasts.css` | `toasts-and-swipes.spec.ts`, `tabs.spec.ts` |
| Board rooms: sidebar section, room view (bot runs drawn as chat turns through `Conversation.tsx`'s `RunTranscript`, consultation folds, approvals), editors | `RoomList.tsx`, `RoomView.tsx`, `RoomHeader.tsx` (its pane-header status and actions, in `App.tsx`), `RoomConversation.tsx`, `BotRun.tsx`, `RoomComposer.tsx`, `RoomMembers.tsx`, `BotEditor.tsx`, `RoomEditor.tsx` (fold: `room-state.ts`; stream: `use-room-stream.ts` over `stream.ts`'s shared core; mentions: `room-mentions.ts`) | `board.css` | `board.spec.ts` |
| Project tools: worktrees and isolated comparison | `WorktreePicker.tsx`, `CompareDialog.tsx`; checkout lifecycle and metadata in server `worktrees.ts`; root lookup revalidation in `workspaces.ts` | `worktrees.css`, `banners-dialogs.css` | `worktrees.test.ts`, `workspace-features.test.ts`, `api.test.ts` |
| Terminal: interactive workspace PTY | `TerminalPanel.tsx` and `terminal-shell.ts` (its iframe document) in the web client; `server/terminal.ts` lifecycle/replay | `terminal.css`, `terminal-shell.css` | `terminal-state.test.ts`, `workspace-features.test.ts` |
| GitHub push, existing/new PR, checks | `GitHubPanel.tsx`, server `github.ts` | `github.css` | `github-workflow.test.ts` |
| Live session and room metadata | `sessions.ts`, `rooms.ts`, `overview-stream.ts`, shared `overview-events.ts` | `SessionOverviewEvent` in `shared/protocol.ts`; server `overview-events.ts` | `overview-stream.test.ts`, `overview-events.test.ts` |
| Agent-rendered page visual preview | `HtmlRenderFrame.tsx`, server `render-preview.ts` | `subagents.css`, bounded in-memory Chromium only | `render-preview.test.ts`, `workspace-features.test.ts` |
| Heavy auxiliary dialogs | `SettingsDialog.tsx`, `UsageDialog.tsx`, `TimelineDialog.tsx`, `RoutinesDialog.tsx`, board and project tools loaded through App.tsx's lazy boundaries | their area stylesheets; desktop chunks load only on open | build + relevant feature specs |
| Phones: drawer, sheets, long press, row swipe actions | `ActionSheet.tsx`, `gestures.ts` (`useRowSwipe` in `Sidebar.tsx`'s rows) | `phones.css`, `responsive.css`, `sidebar.css` | `phone.spec.ts`, `toasts-and-swipes.spec.ts` |
| Motion and the ripple (turn entrance, streaming caret, start-screen mark) | `ripple.ts`, `arrivals.ts` | `motion.css`, `ripple.css` | `app.spec.ts`, `motion.spec.ts` |

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

- **Colours:** `--bg`, `--surface`, `--surface-2`, `--text`, `--text-2`,
  `--muted`, `--accent`, `--link`, `--ok`, `--warn`, `--danger`; derived
  `--hairline`, `--hairline-strong`, `--hover`, `--active`, and `--raised` (a
  face that sits above its track, like a segmented control's chosen pill: the
  surface on a light page, lightened on a dark one). A harness's colour
  is `--harness`, set per element by `harnessColor()` from its `accent`.
- **Radii:** `--r-xs` 4, `--r-sm` 8, `--r-control` 8, `--r-md` 10, `--r-lg` 12,
  `--r-xl` 14, `--r-panel` 16 (px). A radius says what a thing is: controls
  (buttons, chips, segmented choices, pickers) take `--r-control`, in-page tiles
  `--r-md`, menus `--r-lg`, dialogs and the prompt bubble `--r-xl`, the
  composer, the status dock over it (at its width), and the approval card `--r-panel`. `999px` / `50%` is only for a dot or a
  single glyph (send, switches, status dots, the context ring).
- **Widths:** `--col` 960 px (review drawers), `--chat-col` (the conversation
  and composer; config.yml's `chat_width`), `--sidebar-w`.
- **Density:** `--row-h`, `--head-h`, `--section-gap`, `--gap-turn`, `--gap-process`,
  `--drow-h`, `--composer-pad-*`, `--tab-h` (sidebar rows, turn and tool-row
  spacing, composer, tab strip). config.yml's `density: compact` sets
  `data-density="compact"` on `<html>`, and `tokens.css` overrides them there,
  for a fine pointer only (touch keeps the comfortable sizes). Use a token, not
  a literal, for a new row height or gap.
- **Text:** `--chat-font` = 14.5 px × `--chat-scale` (config.yml's text size).
  A small uppercase section label (Recent, Todos, Actions) is 600 weight at
  `--label-size` with `--label-tracking`, in `--muted-text`; headings (the chat
  title, dialog titles, the start screen) take `--tracking-tight`.
- **Control sizes:** the composer's row is 32 px tall on every screen, its
  chips and icon buttons at `--r-control` and Send round (the composer is the exception to `phones.css` raising
  touch targets to 36–44 px elsewhere: a phone keeps its one slim row). Keep
  a row of controls one height: mismatched heights and radii are what makes a
  part "look off".
- **Motion:** short and eased out; `prefers-reduced-motion` turns it all off
  (the rule at the end of `tokens.css`).

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
kind), `todo`, `ask` (an approval), `quiz` (a question), `subagents`, `planned`,
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
