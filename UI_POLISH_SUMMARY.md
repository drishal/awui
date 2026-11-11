# UI polish: summary

What changed in the web UI, and why each change makes it calmer, more consistent and easier to read. Almost all of it is CSS, tokens, icons and small markup changes; behaviour is unchanged apart from the two noted below (the jump control's shape, and the capitalisation of a thinking level). Pushed to `main` on request; the round robin continues from here.

## What changed, and why

### Type
- **Bundled fonts** (`2cea40c`). Inter for text and JetBrains Mono for code ship with the app as subset woff2 files under the SIL OFL, so every device shows the same type. Before, `system-ui` resolved to whatever the OS had (Google Sans, Cantarell, DejaVu, Segoe), and Chromium on Linux fell back to its generic monospace. `src/web/public/fonts/README.md` says how the files were made.
  - **Settings → Font** (Inter or System; `font: system` in config.yml) keeps the device's own fonts for anyone who wants them.
  - Payload: Inter is 127 KB (italic 138 KB, loaded only where italics appear) and JetBrains Mono is 53 KB, with `local()` tried first.
- **Tight tracking on headings** (`89bf67b`). The chat title, dialog titles and the start screen's heading use `--tracking-tight` (-0.014em), which is how Inter is meant to be set at 16–24 px. With the system font it goes back to normal.
- **One style for section labels** (`e626f26`). The small uppercase labels (Recent, Todos, Actions, the usage cards…) ranged from 11 to 12 px, with tracking anywhere from 0.02 to 0.06em. They now share `--label-size` and `--label-tracking`.
- **Chat titles without Markdown markers** (`97f997f`). Titles in the sidebar, tabs, header and page title no longer show stray `**` or backticks. Rename, search and export still use the raw title.

### Shape
- **A tighter radius scale** (`30508a9`): `--r-xs` 4, `--r-sm` 8, `--r-control` 8, `--r-md` 10, `--r-lg` 12, `--r-xl` 14, `--r-panel` 16. Every control (buttons, chips, segmented controls, composer pills) uses `--r-control` instead of a 999px pill. Only dots, Send, switches and status rings are round.
  - The phone's folded composer, the last pill-shaped container, followed later (`4e4f5c4`).
- **The status dock is one surface** (`5f2ab23`, `017c5bc`). Todos, the queue and the git row were bordered bubbles inside a bordered card. They now sit flat, divided by hairlines, with the git row as the card's foot. The dock matches the composer's width and radius, so the two read as one column.
- **Header height stays put** (`4689a29`). The header no longer jumps 7 px when a chat replaces the start screen.

### Colour and contrast
- **Dark surfaces separate** (`247d175`): `--bg #141416`, `--surface #1b1b1f`, `--surface-2 #26262b`, `--border #313137`. Hairlines are a 13% text mix in dark and 10% in light, so edges read without looking heavy.
- **Diff line numbers** (`77fc9bd`, `c01d886`) are no longer faded to 70%, which put them below AA contrast on the dark diff tints. They also sit 12 px from the change bar.

### Icons
- **Stroke 1.4 → 1.5** (`1313780`), so the 16 px icons hold up next to Inter.
- **Tool kinds are bare glyphs** (`cd0af83`, `badb66d`). Overlapping filled discs in the card header read as avatars, and each row had its own disc too. Both are now plain muted glyphs. Only an MCP server's monogram keeps a tinted square, because its hue is how you tell servers apart.
- **The working ring** (`c615e8a`) is an arc over a faint track. Before, it read as the letter "C" when still (in screenshots, or with reduced motion).
- **One spinner per open card** (`4f466f9`). The header's rays go blank while a row below them spins, instead of two or three loaders at once.
- **The folder picker** (`2e7c476`, `9eef748`) uses the stroke folder icon instead of a 📁 emoji. Names and mono paths stay on one line (full path on hover). Workspace roots show the same name-and-path rows as Recent, and both lists share one outline, so the hover state shows inside them.

### Hierarchy and noise
- **Sidebar.** The standing caption under the harness row became hover text (`fb849be`). The harness chip went from accent-filled to a quiet row with a colour dot (`9e61ff8`). Under the *Needs you* heading, rows drop the repeated word "needs you", which was squeezing their titles (`64f5c14`). The Usage footer is a straight rule rather than a box with curled corners (`e7ef31f`).
- **Command palette** (`031f81e`, `6cc786c`). Shortcuts are drawn as keycaps (Ctrl | Shift | H). Plain details follow the label in muted text, so the right edge holds only keys, and the selected row uses the active fill.
- **Status bar** (`7768a65`) shows the project's folder name instead of an absolute path cut off mid-segment.
- **Approval** (`96ee917`). Deny is a bordered secondary button next to the solid Approve, a real choice rather than something that looks like a dismiss link.
- **Phone header** (`99d512b`). The Terminal and GitHub icons move into the chat menu, as Search already did, so the title has room.
- **Settings** (`20e3a2a`). Section labels line up with the card edge below them.

### After round 2
- **Header badge** (`1cadd4c`). The harness badge is a quiet tag with a colour dot at the xs radius, like the sidebar's chip, not a tinted pill in a second style.
- **Phone card header** (`149a03c`). The icon stack drops on narrow screens so "Worked for 1s · Used 9 tools" stays whole; each row still has its icon.
- **Radius stragglers** (`bf7099f`). Jump to latest and the phone composer moved from 999px / 20px literals onto `--r-control` and `--r-panel`.
- **Status dock** (`aebf6f4`, `70df559`). "5 new" stays on a phone. The grip bar on the dock's top edge appears on hover or focus with a mouse, instead of reading as a break in the border (touch keeps it).
- **Spinner** (`1cd0362`) at a 2px stroke, to match the optical weight of the 1.5-stroke icons.
- **Settings controls** (`d6cfaf3`, `fe7208d`). An off switch has a muted knob, so only the switched-on rows draw the eye. A segmented control's chosen pill uses a new `--raised` token: the surface on light themes and a lightened surface on dark ones, where the old `--card` sat darker than its track and looked sunken.
- **Palette and settings lists** (`844a7ab`, `d63d6fd`). Keycaps have a faint fill so they read on dark. Both lists fade into the dialog's bottom edge instead of being cut flat, with padding so the last row clears the fade.
- **Folder picker** (`01b0c73`). Open beside the typed path becomes the primary button once a path is typed, so the roots view has a primary action.
- **Phone drawer scrim** (`cfe1074`) follows the theme's shadow strength (0.33 light, 0.57 dark) instead of a fixed 40% black that barely dimmed a dark page.
- **A flaky board test** (`c392e1e`, test only). `getByText("Queued")` also matched the queued message and the composer's queue note, so it failed in strict mode whenever all three had rendered; it matches the label exactly now.

### Before round 4

The round-3 findings that were plainly defects, plus the three regressions DeepSeek named, fixed in one pass rather than carried into round 4.

- **Jump to latest** (`b6ac9f9`). The worded pill covered a line of the last card whenever it showed. It is a 34px chevron button in the corner now, which at desktop widths sits in the pane's margin beside the column, over no text at all. The thread keeps 44px under its last line so the button clears it at the end, and the name moved to `aria-label` and the hover title.
- **Composer column** (`cb18753`). The composer and the dock were 16px wider than the cards above them and offset from them. Both now mirror the thread's padding and its scrollbar gutter: measured card edges 351–1271, composer and dock 352–1272.
- **Approval screen** (`e607e2d`). The git row drops its bubble while an approval card is up, so the card is the only surface above the composer.
- **Sidebar** (`c42a7a1`). The stacked "All projects" text row is gone. The header's back button and the project menu already say it.
- **Folder picker** (`9c0b2c5`). Recent and workspace-root rows are one component, so names and paths start on one line, and every label in the dialog takes the section-label style.
- **Settings** (`9fda295`). The bottom fade is 40px, and the body keeps that much room under its last row, so no row is cut through its text.
- **Segmented controls** (`132d09c`). An unchosen option is `--text-2`, not muted text, so it no longer reads as disabled.
- **Header tag** (`6f88399`). The harness tag loses its chip in the chat header, where in a light theme it was the second pale fill on a row that already had the active tab.
- **Open cards** (`6011e06`). An open card's header no longer repeats the first row's glyph; a closed one keeps the stack, which is its one hint.
- **Palette keys** (`0752765`). The keycap fill drops to a 4% mix, so the command name leads the row again rather than the keys.
- **Sticky prompt** (`ca1d1f8`). 96% opaque instead of 84%: on a phone the row under the bar read through its text.
- **Thinking level** (`b4625dc`). One `levelTitle` in `config-summary.ts`; the hero's chip, the phone's settings line and the status bar say "Low" and "High", as the chat's thinking chip already did. Three start-screen and status-bar assertions said the lowercase form and were updated with it.

Trade-off: the jump control lost its words. Its name is still announced and shown on hover, but it is no longer self-describing at a glance. A 128px chip that never covers text does not fit the pane's margin.

## Council review

Members: Claude Opus 5.5 (Claude Pro), DeepSeek V4.1 Flash (OpenCode Go), and a third seat held by Grok 4.7 (xAI) in rounds 1–2. In round 3 Grok failed three times on xAI capacity, and the seat moved to Muse Spark 1.3 (OpenCode Go) at the user's request, since the xAI weekly limit was close. The repo is public and the frames are synthetic, so Muse Spark's training on prompts exposes nothing private. Each member scored the same screenshots (desktop and phone, dark and light) on their own, read-only.

| Delegate | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- |
| Claude Opus 5.5 | 7/10 | 8.3/10 | 8.6/10 |
| DeepSeek V4.1 Flash | 6.5/10 | 8.5/10 | 8.6/10 |
| Third seat | 6.8/10 (Grok 4.7) | 8.3/10 (Grok 4.7) | 8.6/10 (Muse Spark 1.3) |

Dimension scores per round (Hier / Type / Space+Radius / Icons / Consist / Read):

| Delegate | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- |
| Claude Opus 5.5 | 6.5 / 6 / 7 / 6.5 / 6.5 / 7.5 | 8.5 / 8.8 / 8.2 / 8.2 / 8.0 / 8.6 | 8.7 / 8.8 / 8.6 / 8.6 / 8.4 / 8.7 |
| DeepSeek V4.1 Flash | 6 / 6 / 5 / 5 / 5.5 / 7 | 8.5 / 8.8 / 8.6 / 8.7 / 8.3 / 8.9 | 8.7 / 8.8 / 8.3 / 8.8 / 8.5 / 8.9 |
| Third seat | 6.5 / 5.5 / 6.0 / 6.5 / 6.5 / 7.5 (Grok) | 8.6 / 8.7 / 8.3 / 8.4 / 8.2 / 8.1 (Grok) | 9.0 / 9.0 / 8.5 / 9.0 / 8.5 / 9.0 (Muse Spark) |

### Still open from round 3

All three gave 8.6. Everything they named as a defect is fixed above; this is what is left, and what round 4 starts from:
- **"+5" in the card header has no unit** (Muse Spark).
- **Smaller** (from both): the context ring reads as a spinner; the settings slider's value stops short of the controls' edge; the chat header isn't on the conversation column; the git row's inset is 8px where the todos' is 14px; light card rings are faint.

## Screenshots

Kept locally in `.todo/ui-polish/` (gitignored, not committed). `before/` holds the frames from the start, `round2/` and `round3/` the council rounds, and `round4/` the frames of this pass, all under the same names:
`{dark,light}-1-chat`, `-2-tools`, `-3-approval`, `-4-folder`, `-5-hero`, `-6-settings` (and `-6-settings-top`), `-7-palette`, `-phone-1-chat`, `-phone-2-drawer`. They come from a sandbox server with fake agents (port 4795), so the paths and messages are synthetic.

Round 4's frames differ from earlier rounds in one way worth knowing: the sandbox needs `XDG_CONFIG_HOME` pointed inside its own folder. Without it the server reads the developer's `~/.config/awui/theme.yml` and every frame comes out in their custom base16 theme instead of the app's own light or dark palette.

## Checks

On this pass's tip (the twelve commits above):

- `npm run typecheck`: passes (server, web, tests, atui).
- `npm test`: 1413 passed, 22 skipped, 1 failed. The failure is `render-preview`, which needs a Chromium from the dev shell; it passes when `PLAYWRIGHT_BROWSERS_PATH` is set.
- e2e (`npm run test:e2e:fast`): both shards pass, 225 passed and 7 skipped. A first run had three failures: the two start-screen assertions that named the lowercase level (a real consequence of this pass, fixed with it) and one `eval` test that read "Ran" where it wanted "Running", a race the loaded machine won, which passes alone and in the second run.

Earlier rounds' runs are in the commits they belong to; the round-3 numbers were 1414 passed and one e2e flake (a settings test, three of three alone).

## Notes and trade-offs

- **atui's theme** (`src/atui/theme.ts`) still uses the old dark colours. The terminal client was out of scope.
- **The font setting is per server** (config.yml), like the other look settings. A `theme.yml` `fonts:` entry still goes first in the stacks either way.
- **The harness dot on every session row** stays. Opus suggested showing it only when the list mixes harnesses. It doubles as the slot the working ring takes, and the docs describe it as the harness legend, so removing it would change layout and behaviour for a small gain.
- **Test environment:** two unit tests (render preview, which needs Chromium from devenv, and one `security.test` timing case) fail outside `devenv shell` or under heavy load, and pass inside it or alone. The first e2e run had three timing-sensitive failures while vitest was running at the same time; they passed alone, twice each.
