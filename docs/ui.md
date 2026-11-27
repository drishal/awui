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
| Sidebar: harness title, projects, sessions, the filter disclosure (`sidebar-filter.ts`), its two views (`sidebar-view.ts`, and the flat list's model in `recent-view.ts`), its menus and keyboard (`menu-focus.ts`, `focus-trap.ts`), the collapsed rail | `Sidebar.tsx`, `SidebarFilters.tsx`, `SidebarViewMenu.tsx`, `SidebarRail.tsx`, `HarnessMenu.tsx`, `SessionCard.tsx`, `SidebarResizer.tsx`, `WorkingRing.tsx`, `project-path.ts` | `sidebar.css`, `session-card.css`, `app-frame.css`, `responsive.css` | `app.spec.ts`, `tabs.spec.ts`, `sidebar-filter.spec.ts`, `sidebar-recent.spec.ts`, `sidebar-separation.spec.ts`, `sidebar-keys.spec.ts`, `sidebar-chrome.spec.ts`, `phone.spec.ts` |
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
- **Sidebar chrome:** the first 36 px row is the harness's name and the ⌄ that opens its menu, four pixels apart and inside one trigger sized to the two (the pill, and the target, is the title rather than the empty half of the row); New chat and collapse sit at 28 px at its end. The trigger's name is `Harness: <name>`, so a screen reader hears the harness it switches. Search takes one 32 px row and holds a Recent / Projects menu button before its 24 px filter trigger — a glyph, not a tile: no border or fill of its own, a `--hover` wash under the pointer, and the accent dot for an active filter. Under a 256 px rail the field's placeholder asks in one word (`Search`, else `Search sessions`): an input cannot ellipsise a placeholder, and `Search sessi` at the 236 px floor read as a typo. Its accessible name stays `Search sessions` at every width. The popover is `min(272px, var(--sidebar-w) - 20px, 100vw - 24px)` wide and hangs from the search field's left edge (clamped into the viewport: aligning to the chip's right edge put its labels off-screen), so it ends inside the rail. Outside the narrow phone's View radio fallback it holds Show, the hide options (what each takes out lives on the label's `title` and in a `visually-hidden` span outside the labels, referenced by the control's `aria-describedby` — inside a label Chromium folds the description into the accessible name; a count of 0 keeps its label and count in `--text-2`), a Reset text button at the Hide heading's right end only while something is hidden (11.5/500 accent, a 44 px hit area on a phone), and a `List actions` caption in the existing menu-label style above Refresh sessions and New room as plain column rows in `--text-2`; every row and action is on a 32 px pitch. Radios are drawn rings (appearance none, 1.5 px `--muted` border; checked = accent ring + dot), checkboxes share that drawn style: a 4px box, accent fill, and a CSS `--surface` check. It is a dialog (`role="dialog" aria-label="Filters"`, matching `aria-haspopup="dialog"` on the trigger), Tab walks its form controls and arrows select the Show radio group, Escape returns the focus to the chip, and focus inside it never lights the search field's ring. A row marks the search's hit inside its title with the accent's 24% wash (never its ink or a weight: those mean a run and unread), and with a query of two letters or more the "Search every chat" row starts its words on the titles' edge (its glyph takes the 10px mark column) and the list tucks up under it — the group's 14 px break goes and its first heading keeps 4 px of its own, so the heading's words start 11 px under the row (they sat 31 px under it, a gap that read as the end of the list). While a folder is focused, a typed query leaves that folder for every project (search is global) and its focus head for the flat list, so a muted 11.5 px note under the field says `Searching all projects` with a `Back to <folder>` text action that clears the query and returns to the folder's own list: a text action with a 24 px target, taken with padding outward from the note's own 16 px line (44 px under a thumb), so neither the line nor the list under it moves. The quick-filter token exists only while selected. Empty Rooms renders no band, and its section commands appear on hover/focus. The 36 px footer holds Usage, Theme and Settings, and the scroller's bottom fade is its last child, a sticky `.list-tray` as tall as the tray (`--sid-tray`, 36 px; 44 px on a phone) with no tail of its own on the scroller, so it rests on the list's real bottom edge: a mask on the scroller was a clipping stacking context, so the row menu's foot faded into the footer and the hover card beside the rail was cut away whole (its shadow was the band on the list's edge); now the tray is the scroller's in-flow tail (the list carries no bottom padding of its own), so the fade rests on the list's real bottom edge and at the end of the list covers its own empty box and nothing else; only its last 16 px reach ink, one supporting subline's line box: that second line dissolves fully while the title above it stays crisp, and the row the pointer, the focus or an open menu is on comes up one layer (z-index 3 over the scrims' 2) and is never dimmed at all. On touch, search/filter/New chat targets are at least 44 px; the filter takes its 44 px from the field's own right end (`position:absolute; right:4px; top:0; bottom:0; width:40px`) rather than drawing a bordered square beside it. The drawer's head is a 44 px touch row with 40 px icon buttons and no pencil (its sticky 44 px New chat pill is the one way to start a chat), its close is an ✕, and its scrolled list wears a 20 px `--surface` fade under the head (`.list-scrim`, rendered only while `scrollTop > 0`), and after a real scroll the drawer's rows and headings scroll-snap below its scrim (`scroll-snap-type: y proximity` and `scroll-padding-top: 20px` on the list's `is-scrolled` class, `scroll-snap-align: start` on `.session-item`, `.project-head` and `.date-divider`) so a settled scroll never opens on a title-less subline; at rest snapping is off, so the closed drawer's mount cannot choose a snap target and open the list at its foot. Below 375 px the narrow phone uses a View radio group in Filters and otherwise the same search-edge menu; a scrolled waiting list keeps a 44 px amber pill above New chat to open its first row. A row's menu items are 32px on a pointer (13.5px text, 6px a side) and keep the shared 44px floor on touch; flipped above a low row its foot clears the whole row, not just the ⋯, so the title it acts on stays readable. When Move up/down is absent the rule before Select sessions is skipped (it joins the state group: two rules), and with Move present it stays. A row's menu is capped at `calc(100vw - 16px)` and keeps 8 px from the window's right edge, so it fits a 360–390 px phone. Sidebar state colours mean: amber = needs you, accent ring/word = running, weight = unread, green = done; nothing else in the list is coloured, and a project's monogram — the one decoration — takes four different hues from `--badge-1..4` (teal, violet, orange, red), none of them the accent, the needs-you amber or the done green: a monogram in the run's own colour read as a run. The set of a sidebar's projects is worked out together (`projectSlots`), so no two folders beside each other wear one hue, and a folder keeps its hue from its head to the switch menu to the flat list's rows; its letter is 9px/700 on the 12px row badge, 10px on the 16px head, and takes a step toward the text ink so it clears 4.5:1 on its own wash in both schemes.
  spacing, composer, tab strip). config.yml's `density: compact` sets
  `data-density="compact"` on `<html>`, and `tokens.css` overrides them there,
  for a fine pointer only (touch keeps the comfortable sizes). Use a token, not
  a literal, for a new row height or gap.
- **Scrollbars:** themed globally, once, in `tokens.css` (`*`): every scroller in the app takes an 8px thin bar, `--hairline-strong` on a transparent track, so a menu, a picker, a dialog, the composer or a code block never falls back to the platform's light bar; a container that hides its bar (`scrollbar-width: none` on the tab strips) or reserves a gutter (`scrollbar-gutter: stable` on the thread) says so itself.
- **Sidebar rows:** each title is one 14px line with an ellipsis. A row is 36px tall,
  or 54px with its supporting subline (the project it is out of, the agent's status, how the
  session began — `From <parent chat>` or `Scheduled routine` — or a branch that differs from its
  group's head), with 2px between rows and no hairline or rail on desktop at the default style; a row
  inside its own project with none of those stays one line, so a group mixes the two heights.
  The rows sit on a 12px panel gutter with 10px of row padding and a `--r-md` wash. Titles start
  26px into the row, and folder groups sit 16px apart. In Recent the tag is the project's badge,
  then — in the branch's place, and so before the project's name — the line the agent set for itself,
  then the project's name after a `·` (`ready to merge · awui-wt`): a row states one fact beyond where
  it lives, and the fact that changed comes first. A blocked agent's state is that fact and its comment
  is a note under it, so the row says `blocked · waiting on CI`: the word takes `--row-warn` while the
  note and the project stay muted (`TagFact`), where the note alone used to read as a finished row.
  Touch keeps 44px on one line and 48px with its subline. Compact style and compact density keep their own values.
  `session-state.ts` decides that subline and its state. On a two-line row the title
  takes the row's full width (10px right padding, no hover gutter). Its second line
  holds the project's badge and name on the left, and the age or allowed state word
  on the right. Hover or keyboard focus shows a 24px ⋯ at the subline's right end,
  bottom-aligned in the row, and fades that age out for it in 90ms: the title never
  changes width under the pointer (the 22px it used to give the control cut two
  letters off it), and no glyph is cut under the control. On a one-line row the age
  stays beside the title; hover or keyboard focus swaps it for the ⋯ with an opacity
  cross-fade inside the age's own box, so the title keeps its width. Touch keeps the ⋯
  on the open row only. Inside the Needs-you or Working section that already names the state, the row
  shows the age in the muted ink, not a repeating word and not a third amber cue (the section's icon and
  the row's dot already carry it). In the Working section that age is
  the run's own elapsed time ("12s", "1m 4s"), counting up on its own second clock in `--text-2`, tabular
  like every other time in the list — the age said "now" for the whole run, which is the one thing someone
  watching a run already knows; a run whose start the listing does not give keeps the age. The section's
  own mark does not spin (`WorkingRing`'s `still`): its rows each own a ring, and three rings turning in one
  column read as three runs. Unread is title weight (600) and
  full ink, with the word “Unread” only in a visually hidden span for assistive tech.
  `config.yml`'s `sidebar_style: compact` sets `data-sidebar="compact"` on
  `<html>`, and `sidebar.css` ends with the handful of overrides that make the
  rows tighter still: 28px and one line — the title (`flex: 1 1 auto`, never below 96px), the project's
  name as a dim suffix of at most 56px, and the age at the line's end on the column every row uses, 6px
  from the title and 8px before the age, with the same ⋯/age swap on hover and 1px between rows. The suffix
  gives way first, piece by piece (`TagLine`): the project's name carries a 56px cap and shrinks to 24px
  before a branch after it, while a branch keeps its own width (`flex: none`). The suffix box itself shrinks
  to 0 under its 96px cap (`min-width: 0`; its `min-content` was the whole suffix), and the fact inside it
  gives way the same way (a nowrap line's `min-content` is its whole sentence), so a long status ellipsises
  inside the row and the age stays on its column. A `min-content` floor used to hold a 440px status inside
  the 96px box, which pushed the project's name out of the row. Beside the agent's own status the project's
  name is not drawn at any width — the pair printed two fragments that said nothing (`DeepSee… · a…` at
  292px, `D. · a…` at the 236px floor) — so the fact takes the whole suffix and the project keeps its place
  in the row's `title`, hover card and accessible name. Under a 224px rail the
  project's name alone is not a suffix but an ellipsis (7px of a 74px name at 200px), so it is not drawn
  there — the row keeps it in its `title`, its hover card and its accessible name — and the title takes the
  room. The title gives its room up before the suffix gives up any of its own (a 1000 shrink weight, an order
  rather than a size), so the project keeps its cap wherever the line has room for it and shrinks only under
  the title's 96px floor: at 236px, the resizer's narrowest rail, the project has 50px and every row's age
  lands on one column — the row used to overflow its own body by 6px and put its age 6px right of the others'.
  The desktop resize floor is 236px, so the under-224 branch is reachable only through a very narrow phone drawer (88vw under 254px). Measured: a 292px rail gives the title 146px (was 129) against a 56px project (was 71); at 236px the title
  holds its 96 with a 50px project; at 232px the project has 46px (it overflowed at 56); at 200px on that narrow phone the title
  has 116 (was 96) with no suffix, and a branch row keeps `test` where it used to show 12px of nothing.
  It changes the row look only: heads, chips, hover cards, and the wash keep
  their own rules, and a phone's row is still at least 44px tall.
- **Sidebar list:** the sidebar draws one of two views (`sidebar-view.ts`, saved
  per browser; the view menu beside search (or a narrow phone's View radios) writes it). Recent, the default, is one
  flat list across the shown harness's projects: the needs-you, working and
  pinned sections above, then `recent-view.ts`'s page — calendar headings from
  `session-groups.ts`'s `dateGroup`, rows newest first, each with the project it
  is out of as its tag, 12 rows and then 20 per "Show more"; a folder's preview
  is 4 rows (8 for the current one) and adds the same 20, and "Show more" is a
  row of the list itself: muted words at the row pitch with a 12px chevron after them
  and `--text-2` under the pointer, 44px on a phone.
  Projects is the grouped list (`groupByProject`, `focusProject`), where focus
  mode, the folder heads and drag order live; `GroupOptions`' place rules (what
  needs you, what works, what is pinned, and the settled/snoozed/archived
  toggles) apply to both.
- **Sidebar headings:** a calendar heading and a section head (Needs you, Working,
  Pinned, Rooms) are signposts: sentence case at 11.5px/500 in `--muted-text`,
  with no tracking, and the attention colour stays on the needs-you icon alone.
  A folder head is the folder's own name at 13px/600 in `--text-2`, with its
  16px badge (radius 4, 10px/700, no ring) hanging in the rows' mark column, its
  branch after a `·`, the fold chevron after the name, and its count (past the
  chevron) at every state — the folder's size, not a note about hidden rows, so one column
  holds one meaning; the pointer's `+` sits over that count's own place and fades it, as a
  row's `⋯` fades its age, so a head never spends 28px on a control (a touch screen keeps the
  `+` in the flow and the count beside it); "Show N more" then drops the folder's name the
  head already said; its rows are not indented under it, so
  a folder's titles are as wide as the flat list's. A folder's preview rows carry no date
  headings until the folder is opened: the age on each row already says when. Recent
  has one text edge: a date heading's text and every section head's label start on the
  rows' titles' edge (38px into a 292px panel); only marks hang in the mark column
  (18px), and every count ends on the age column. A date heading carries its bucket's
  size there — or, where the page stopped inside that bucket, how much of it the page drew
  (`12 of 15`, 11px, the rest in its `title`) — and a section head outranks it: the state a
  section names reads in
  `--text-2` at 600 where a date is `--muted-text` at 500, its count likewise. Both
  are `role="heading"` at `aria-level` 3 for assistive tech, and every count carries
  its unit ("4 sessions", not a bare number; a foldable section head says its own name
  and count as words, since the spans would otherwise run together). Date
  headings are plain dividers, not sticky labels (a stuck heading's fade ghosted a search's first
  result and cut a passing row in half on a phone); the scrolled list's own top fade (12px, 20px on a phone) is
  the only edge a row meets. At the default style on a fine pointer, folders leave 16px between them
  and 6px from a head to its first row; compact style and compact density keep their own gaps;
  only 8px (6px at compact density) above the dates under it, two ranks of one list rather than two places.
  A folder head names its branch
  once for its rows: any branch off the trunk, and the trunk too when another folder
  shares the repository; its rows never repeat it (`rowSubline`'s `groupBranch`). Branch
  names are in the UI sans face, muted.
- **Sidebar state, the colour contract:** `session-state.ts` decides a row's two
  state slots — a 10px leading mark and either the age or one word in its place
  — and exactly four things in the list are coloured: **amber** (`--warn`) is
  needs-you — its dot, its word outside its own section, and the `blocked` a blocked row says before its
  note;
  **the accent** is a run, its ring or its word; **green** (`--ok`) is done,
  and only the agent's own verdict ("done" or "ready for review") earns it;
  and **weight** is unread (the title at 600 and full ink, read titles at 86 % of the text ink: one rank
  above the muted annotations, not the 78 % that read as disabled beside the bold rows).
  The section's state word stays outside it; inside it no second word replaces the age, and the age itself
  keeps the muted ink.
  Nothing else in the list states anything by colour: a project's monogram is the one
  decoration: four different hues from `--badge-1..4` — teal, violet, orange, red — none the
  accent, and none the amber of needs-you or the green of done, so no row can be mistaken for a
  run; its letter takes a step toward the text ink, which measures 4.7–5.3:1 in light and
  5.3–6.6:1 in dark on its own 22 % wash, at 9px/700 on the 12px row badge (10px on the 16px
  head); and
  liveness is a server detail (the hover card
  says "Open in this server"), and parked / herdr / handed-over share one 12px muted
  glyph, in that priority, with the whole story in the card. Sidebar-local `--hover`
  is 9% ink (1.2:1 on the panel) with a 90ms background transition (removed with the
  rest of motion), and the row a menu was opened from keeps that wash while the menu
  is up (`.is-menu-open` on the `.session` inside it), so a menu still names its row
  where it covers it. The state words take sidebar-local `--row-warn`, `--row-accent` and
  `--row-ok`, each a step from its token toward `--text` so it clears 4.5:1 on the
  panel; the open row deepens them further and gives its title `--text` and its meta
  and subline a step from `--muted-text` toward `--text` (72/28), so the row keeps its
  second rank on the wash — 5.6–6.0:1 in the two shipped schemes and 4.57:1 on the owner's
  darkest theme, where 88/12 measured 4.16:1 (#a2a5b1 on #3b4057) and even 78/22 reached only
  4.42; halfway from `--text-2` to
  `--text` read 10.6:1 in light — and every word clears 4.5:1. That wash is
  `--sidebar-active-wash`: 12% of the row's harness colour over `--surface-2`, and 8% on a light page,
  where 12% read as a selected tab among grey rows rather than as the open chat (the title then measures
  14.6:1 and the subline 5.5:1, so the step is quieter without losing a word). The 2px rule stays in both.
- **Sidebar menus, keys, and the rail:** each action menu (a row's ⋯ menu, the view
  menu and the project switch) is one tab stop: ↑/↓ and Home/End walk its items
  (`menu-focus.ts`; the walk is `menuStep`, pure and tested; Tab closes the menu without preventDefault, so the focus moves on). Filters is a form dialog:
  native Tab order and native radio arrow-select apply; Escape closes it and puts
  the focus back on the button that opened it. The session list is one tab stop too
  (`Sidebar.tsx`'s `useListKeys`): ↑/↓ between rows, Enter opens, and Shift+F10 (or the
  ContextMenu key) opens that row's menu, so a row is not two stops. A row's hover card
  also opens on keyboard focus, under the row (`SessionCard`'s `side`). On a phone the
  drawer is a real modal: `focus-trap.ts` keeps Tab inside it, the chat behind it is
  `inert`, and closing it returns the focus to the Open-menu button. Folded at ≥ 1100 px
  the sidebar leaves `SidebarRail.tsx`, a 44 px strip (expand, new chat, the palette, and
  the needs-you and running counts, each opening its list); each icon's title carries its
  shortcut from `shortcuts.ts` (`new`, `palette`), a count's badge is a 15px pill (10px/600 on `--surface-2`, a `--hairline-strong` ring) riding its own glyph's
  top-right corner (half over the icon, inside the strip, never clipped), and Usage, Theme
  and Settings stay in a cluster at the strip's bottom, where the tray would be. Narrower it
  hides completely and the chat header's expand button returns it. The project switch menu
  orders itself as places then actions: All projects, every folder with the one you are in
  checked (`role="menuitemradio"`), a rule, then "Set an icon…". The focus head is a separate
  24 px muted **All projects** back button (its glyph in the mark column, never the current
  project's accent — the `is-current` accent rule excludes `.focus-back-chevron`), then the
  switch (name at the rows' title edge, branch after its `·` only off the trunk, ⌄), then **+**; the
  Every menu row reserves a 13px check slot, so all counts share one right edge.
  focused rows sit at the list's own edge (`.focus-group .session-sublist{padding-left:0}`),
  and its Needs-you/Working sections are scoped to the focused folder (a workspace-narrowed
  overview feeds `sidebarSections`; the rail's and the tab title's counts stay global).
  `project-path.ts` words a folder for the switch menu: home-relative, middle-cut
  (`~/…/dotfiles`), the full path on hover.
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
