The vendored symbols font for session titles that carry Nerd Font icons.
Source: [ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts) `SymbolsNerdFontMono-Regular.ttf`,
release 3.5.0 (the `nerd-fonts.symbols-only` pack), MIT licence (see the repository's LICENCE).

Shipped as woff2 (`woff2_compress` from nixpkgs' `woff2`). Loaded from CSS
(`styles/tokens.css`) with `unicode-range` covering the Nerd Font private-use blocks; an
installed `Symbols Nerd Font`/`Symbols Nerd Font Mono` is preferred via `local()`.

Refresh it by re-running the same steps against a newer `nerd-fonts.symbols-only` in nixpkgs.
