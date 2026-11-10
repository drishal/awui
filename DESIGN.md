# awui design system

awui is an operational control surface for coding agents. Its design favors quiet inspection, explicit state, and reversible expert workflows over decorative application chrome. See `docs/ui.md` for the component map and `docs/theme.md` for token configuration.

## Character and structure

- Terminal-instrument calm: precise typography, real state, subdued chrome, and no ornamental interface numbers, mascot narratives, or generic dashboard cards.
- Work stays in nested hierarchy, not landed cards. Each status, tool, room, and reader can own its own inset when hierarchy demands it; do not turn every section into a card.
- Harness colors identify ownership, without changing text or public status colors. Danger, warning, and success remain semantic rather than harness accents.
- Conversation uses `--chat-font`, `--chat-small`, and `--chat-code`, multiplied by `--chat-scale`. Auxiliary controls use `--font-sans`; measurements and transcripts use `--font-mono`. The font is not decorative enterprise branding.

## System tokens

Tokens live in `src/web/styles/tokens.css`. Base16/base24 themes override foundational colors; hairlines, chips, shadows, and surfaces are derived through `color-mix`. Add new colors as tokens with contrast checks, never one-off literals.

- Surfaces: `--bg`, `--surface`, `--surface-2`, `--card`, `--code-bg`.
- Text: `--text`, `--text-2`, `--muted-text`. Secondary copy is readable; gray is not an accessibility shortcut.
- Ownership: `--harness` and `--harness-<id>`, distinct from `--accent`, `--thinking`, `--danger`, `--warn`, `--ok`.
- Interaction states: `--hairline`, `--hairline-strong`, `--hover`, `--active`, `--control-border`, `--selection`, compact density through tokens rather than blanket CSS scaling.
- Radii and layout: `--r-sm` through `--r-xl`, `--col`, `--chat-col`, `--sidebar-w`.

## Interaction hierarchy

1. Current work: prompt, response, ongoing tool stream, approvals, next action.
2. Immediate task context: model, thinking and permission mode, project, context/usage when meaningful.
3. Working state: running, stopping, compaction, pending question, disconnected/reconnecting, failed, done.
4. Secondary tools: image operations, stash, handoff, review, git, render previews, and project operations. Keep rarely needed actions on their own surface rather than growing primary chrome continuously.
5. Auxiliary workflows: Worktrees, Terminal, GitHub, Board. Each is an accessible named panel on the project surface, not a new home screen.

Every action uses accessible names and keyboard operation. Tooltips supplement, not replace, those names. Do not hide safety boundaries behind hover-only affordances.

## Motion contract

Motion makes state and spatial relation legible, not another activity stream.

- **Continuity:** FLIP where composition changes (queue-to-prompt, shared headers, tab geometries, disclosures). Do not crossfade a text-heavy whole transcript to fake continuity.
- **Feedback:** 100–150 ms settled changes when a user causes an immediate action; status colors alone can replace motion if spatial movement adds nothing.
- **Identity:** short spring for a touched control, damped easing for incoming agent output, never perpetual bounce on per-turn churn. Clip and grid transitions keep text crisp; no scale-blurred menus.
- **Navigation:** short header/project cues and preserved scroll/draft state. Cached warm tab switches are immediate; do not display a loader behind a warm session.
- **Dialogs:** 120 ms inert exits while inputs remain rejected, followed by restored focus. Pop and modal states own their lifecycle; pending timers die on unmount.
- **Interruption:** running transitions can be reopened or cancelled without jumps or stale completion effects. Log only actionable failures, not each animation.

Reduced motion is intentional, not an accessibility afterthought. Spatial movement, breathing, shimmer, ripples, and FLIP transitions go off; instantaneous semantic states and meaningful color/feedback persist. Do not make completion depend on an animation finishing.

## Terminal and rendered content

Agent-rendered HTML has an opaque frame origin: `sandbox="allow-scripts allow-forms"` with no same-origin privilege. A headless visual preview is a separate authenticated capture restricted to the stored page, inline assets, bounded console, and timeout. It never calls an arbitrary URL or leaks an app cookie into an agent document.

The real PTY renderer is trusted awui code running in a different, origin-checked child document only because xterm requires inline grid styling. Its narrowly scoped CSP and same-origin-only messages permit orientation/resizing and input through existing terminal APIs. It cannot inspect the parent or receive a command, arbitrary URL, credential, or transcript injection. Agent pages do not use it. Main chat CSP does not change.

## Review checklist

- Render desktop and mobile at actual shipping widths; check density, focus order, names, and readable settled text.
- The two-pane and work-panel layouts must compose, not stack accidental 100% columns or cause a 100vh child to exceed its parent.
- Loading states must not erase subscriptions, input ownership, or scroll/draft identity.
- Remote and rendered content actions match explicit server authorization; no client-only trust guard is security.
- Lifecycle is bounded: no hidden terminal/PTY left after its last viewer, no expired plaintext, no unbounded replay or console data.
- Motions, failure states, and cleanup verified in source and rendered surfaces. Do not claim accessibility from CSS/readability alone; physical touch gestures need device validation.
