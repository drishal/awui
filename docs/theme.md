# Theme

Colours come from CSS custom properties; a base16 scheme can drive them all.

The built-in light and dark themes follow your system. A base16 or base24 scheme in `~/.config/awui/theme.yml` is listed in the Settings theme menu as **base16** (its own name shows on hover) and among the schemes below; `theme: base16` in `config.yml` makes it the default everywhere.

- **Accepted formats:** tinted-theming (`system`, `name`, `variant`, nested `palette:`), the stylix-generated shape (`name` + `palette:`, hex without `#`), and legacy flat base16 (`scheme:` + top-level `base00`…).
- **Validation:** only exact 6-digit hex is accepted, because colors become CSS custom properties applied through the CSSOM.
- **Contrast:** roles are checked against WCAG AA (4.5:1 for text, 3:1 for controls and focus) and nudged if needed, against the page, the cards, and the chip surface where text sits; secondary text (`--muted-text`) is derived a step below `--text-2`, never from base16's comment colour as is. Adjustments are logged.
- **Live updates:** the file is re-resolved (realpath and mtime) on each request, so a home-manager switch shows up the next time a tab becomes visible.
- **First paint:** the server writes the active theme into the page it serves (`<html data-theme="dark" data-scheme="1">` and a `<link rel="stylesheet" href="/theme.css?h=…">` with that scheme's variables), so a stored dark scheme never shows a light frame while the script is starting. The script takes over from there (a theme menu's preview, a switch, an edited file), and a page that follows the system gets neither attribute nor stylesheet. `/theme.css` answers a signed-in device only, exactly as `/api/theme` does.
- **Fonts:** the web UI ships Inter (text) and JetBrains Mono (code), SIL OFL, subset and served from `/fonts` (`src/web/public/fonts/README.md` says how they were made); config.yml's `font: system` (Settings → Font) uses the device's own fonts instead. An optional `fonts.sans` / `fonts.mono` goes first in the font stacks either way, with those fallbacks. Nerd Font codepoints (a session's icon-marked title) are always covered: each stack ends with the Symbols Nerd Font names, and a Nerd Font symbols woff2 ships with the app as the last resort for a machine without that pack installed, sized by `unicode-range` so it only downloads where a page actually contains one.

## The theme library

More schemes than one live in `~/.config/awui/themes/`, one base16 or base24 file each, named by its id (`gruvbox-dark.yml` is the theme `gruvbox-dark`). `theme_scheme: <id>` in `config.yml`, with `theme: base16`, makes one the look on every device; without it `base16` means `theme.yml`. Every client follows: the web UI, atui, and the Tern client all read the active scheme from `/api/theme`.

- **Files:** any of the accepted formats can be dropped in by hand or uploaded; what awui writes is always normalized tinted-theming YAML (`system`, `name`, `variant`, `palette:`), so a file it saved reads the same anywhere base16 is understood. Up to 100 themes; a listing reads at most 200 files.
- **Read-only themes:** `theme.yml`, and any file in `themes/` that is a symlink (home-manager's `xdg.configFile`), are listed and can be chosen but are never edited or deleted from awui.
- **Switching:** the palette button beside Settings opens the theme menu: System, Light, and Dark, then every scheme, each with a small swatch of its page, panels, text, and accent colours. Pointing at one (or moving to it with the arrow keys) shows it on the whole page; leaving the list or Escape puts the current one back, and a click saves it to `config.yml` for every device. The command palette offers the same list (`theme gruvbox`), previewing the highlighted one until it moves on or closes.
- **Managing:** Settings → Appearance → Schemes shows every scheme as a card. Choosing one is part of the form, saved with its Save; the rest act on the file at once. **Upload .yml** adds a file (64 KB at most, in any accepted format); **New theme** and **Edit** open the editor: a name, Dark or Light, and the sixteen colours by picker or hex, beside a live preview built with the same contrast check the server applies (it names the roles it had to raise). **Duplicate** makes an editable copy, of a read-only theme too; **Export** downloads the file; **Delete** offers **Undo**, which puts the same file back under the same id. The theme in use cannot be deleted until another is chosen.
- **A pick that breaks:** a `theme_scheme` whose file was removed or no longer parses falls back to `theme.yml` (or the built-in themes), and the problem is reported where `theme.yml`'s are. A file that does not parse is still listed, with its reason, so it can be removed.

## Shared settings and terminal surfaces

- **Automatic** (`""` in config) uses `theme.yml` when present, otherwise follows the system. `system`, `light`, `dark`, `base16`, and the legacy `custom` selector alias are accepted. `base16` is also settable directly in `config.yml`.
- **Text size** (0.5–2×) affects conversation and composer text through `--chat-scale`; chat width is `comfortable`, `wide`, or `full`. **Density** is `comfortable` or `compact` for fine-pointer desktops; coarse pointers retain the larger 44 px main targets rather than shrinking every control.
- **Tool style** is `cards` or `lines`. Colors remain derived from foundational palette tokens rather than hard-coded surface values; `DESIGN.md` carries the complete token/motion contract.
- **Reduced motion** rises no panels, plays no toggles/morphs/ripples, and does not wait for dialog dismissals; final status/color feedback remains meaningful.
- The xterm document takes the surface, foreground, cursor and selection colors from these existing CSS variables on each respective workspace's child frame. It uses the same fonts but has its own especially limited `terminal-shell.html` document CSP: only the xterm renderer needs inline grid dimensions. Main chat remains strict. There is no CDN or font service doorway through the terminal.
- Nerd Fonts version 3.5.0 is shipped under `src/web/public/fonts`, MIT-licensed via its accompanying notice. Unicode-range rules avoid pulling glyph files where no project uses those characters.

## Wiring it to stylix (NixOS / home-manager)

[`contrib/home-manager/awui-theme.nix`](../contrib/home-manager/awui-theme.nix) mirrors `home/common/core/pi-theme.nix`. It writes `xdg.configFile."awui/theme.yml"` from:

- `config.lib.stylix.colors.scheme`
- `config.stylix.polarity`
- every `baseXX` key (base24 included)
- `config.stylix.fonts.{sansSerif,monospace}.name`

To install it:

1. Copy it to `~/dotfiles/NixOS/home/common/core/awui-theme.nix`.
2. Add `./core/awui-theme.nix` to the imports in `home/common/default.nix`.
3. Rebuild.

Changing `stylix.base16Scheme` in `shared/stylix.nix` then re-themes the web UI. Until the module is installed, you can point `THEME_FILE` at `~/.pi/agent/themes/stylix.yaml`, or copy any base16 YAML to `theme.yml`.
