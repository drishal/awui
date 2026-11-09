# Theme

Colours come from CSS custom properties; a base16 scheme can drive them all.

The built-in light and dark themes follow your system. A base16 or base24 scheme in `~/.config/awui/theme.yml` is listed in the Settings theme menu as **base16** (its own name shows on hover); `theme: base16` in `config.yml` makes it the default everywhere.

- **Accepted formats:** tinted-theming (`system`, `name`, `variant`, nested `palette:`), the stylix-generated shape (`name` + `palette:`, hex without `#`), and legacy flat base16 (`scheme:` + top-level `base00`…).
- **Validation:** only exact 6-digit hex is accepted, because colors become CSS custom properties applied through the CSSOM.
- **Contrast:** roles are checked against WCAG AA (4.5:1 for text, 3:1 for controls and focus) and nudged if needed, against the page, the cards, and the chip surface where text sits; secondary text (`--muted-text`) is derived a step below `--text-2`, never from base16's comment colour as is. Adjustments are logged.
- **Live updates:** the file is re-resolved (realpath and mtime) on each request, so a home-manager switch shows up the next time a tab becomes visible.
- **Fonts:** an optional `fonts.sans` / `fonts.mono` goes first in the font stacks, with system fallbacks. Nerd Font codepoints (a session's icon-marked title) are always covered: each stack ends with the Symbols Nerd Font names, and a Nerd Font symbols woff2 ships with the app as the last resort for a machine without that pack installed, sized by `unicode-range` so it only downloads where a page actually contains one.

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
