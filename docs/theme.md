# Theme

Colours come from CSS custom properties; a base16 scheme can drive them all.

The built-in light and dark themes follow your system. A base16 or base24 scheme in `~/.config/awui/theme.yml` is listed in the Settings theme menu as **base16** (its own name shows on hover); `theme: base16` in `config.yml` makes it the default everywhere.

- **Accepted formats:** tinted-theming (`system`, `name`, `variant`, nested `palette:`), the stylix-generated shape (`name` + `palette:`, hex without `#`), and legacy flat base16 (`scheme:` + top-level `base00`…).
- **Validation:** only exact 6-digit hex is accepted, because colors become CSS custom properties applied through the CSSOM.
- **Contrast:** roles are checked against WCAG AA (4.5:1 for text, 3:1 for controls and focus) and nudged if needed, against the page, the cards, and the chip surface where text sits; secondary text (`--muted-text`) is derived a step below `--text-2`, never from base16's comment colour as is. Adjustments are logged.
- **Live updates:** the file is re-resolved (realpath and mtime) on each request, so a home-manager switch shows up the next time a tab becomes visible.
- **Fonts:** the web UI ships Inter (text) and JetBrains Mono (code), SIL OFL, subset and served from `/fonts` (`src/web/public/fonts/README.md` says how they were made); config.yml's `font: system` (Settings → Font) uses the device's own fonts instead. An optional `fonts.sans` / `fonts.mono` goes first in the font stacks either way, with those fallbacks. Nerd Font codepoints (a session's icon-marked title) are always covered: each stack ends with the Symbols Nerd Font names, and a Nerd Font symbols woff2 ships with the app as the last resort for a machine without that pack installed, sized by `unicode-range` so it only downloads where a page actually contains one.

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
