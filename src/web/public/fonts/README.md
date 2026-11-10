Fonts shipped with the web UI. No font service: everything here is served by awui itself.

**Inter** (`Inter.woff2`, `Inter-Italic.woff2`): the UI and conversation font. Source:
[rsms/inter](https://github.com/rsms/inter) 4.1 (nixpkgs `inter`), SIL Open Font License 1.1
(`Inter-OFL.txt`). Made from `InterVariable*.ttf`: the optical-size axis pinned at 14
(`fontTools varLib.instancer … opsz=14`), keeping the weight axis, then subset with
`pyftsubset` to Latin, Latin Extended, combining marks, punctuation, currency, letterlike
symbols, arrows, maths, geometric shapes, dingbats, and ligatures, with the layout features
`kern,liga,calt,ccmp,locl,mark,mkmk,tnum,pnum,case,zero,frac,sups,subs,cv05,cv08,cv11,ss03`,
no hinting, woff2.

**JetBrains Mono** (`JetBrainsMono.woff2`): code, diffs, and measurements. Source:
[JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) 2.304 (nixpkgs
`jetbrains-mono`), SIL Open Font License 1.1 (`JetBrainsMono-OFL.txt`). The weight-variable
`JetBrainsMono[wght].ttf`, subset the same way plus box drawing, with only
`kern,ccmp,locl,mark,mkmk,zero` (no coding ligatures: `=>` stays two characters in a diff).

Both load from `styles/tokens.css` with a `unicode-range` matching the subset, so a character
outside it falls through to the system fonts. Settings → Font → System (`font: system`) uses
the device's fonts instead.

**Symbols Nerd Font** (`SymbolsNerdFontMono-Regular.woff2`): session titles that carry Nerd
Font icons. Source: [ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts)
`SymbolsNerdFontMono-Regular.ttf`, release 3.5.0 (the `nerd-fonts.symbols-only` pack), MIT
licence (see the repository's LICENCE). Shipped as woff2 (`woff2_compress` from nixpkgs'
`woff2`), loaded with `unicode-range` covering the Nerd Font private-use blocks; an installed
`Symbols Nerd Font`/`Symbols Nerd Font Mono` is preferred via `local()`.

Refresh any of them by re-running the same steps against a newer nixpkgs package (the Python
for it: `python3.withPackages (p: [p.fonttools p.brotli])` in a `nix shell`).
