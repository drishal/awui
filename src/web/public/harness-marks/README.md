# Harness marks

Raster masks shipped with awui; the UI never fetches an icon service at runtime. The PNGs are rendered from third-party source SVGs to a transparent 64 × 64 image with one defined color. The web UI typically recolors them with the current harness accent via a CSS mask, so they follow the theme. They are decorative; every harness name is still shown as text.

## Sources

| File | Source SVG |
|---|---|
| `pi.png` | [Pi coding agent](https://github.com/homarr-labs/dashboard-icons/blob/d767d7327db7f8ebd3715b552523f61889eea41c/svg/pi-coding-agent.svg) |
| `omp.png` | [oh-my-pi `assets/icon.svg`](https://github.com/can1357/oh-my-pi/blob/main/assets/icon.svg); connector dots separated and colors flattened, geometry retained |
| `hermes.png` | [Hermes alternate agent mark](https://github.com/homarr-labs/dashboard-icons/blob/d767d7327db7f8ebd3715b552523f61889eea41c/svg/hermes-agent-alt.svg) |
| `claude.png` | [Claude star in T3 Code's ProviderIcon](https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/components/ProviderIcon.tsx), whole path retained for a crisp small mark vs converting the dashboard icon set's fill-tiled variant |
| `codex.png` | [OpenAI mark](https://github.com/homarr-labs/dashboard-icons/blob/d767d7327db7f8ebd3715b552523f61889eea41c/svg/openai-light.svg) |
| `opencode.png` | [OpenCode monochrome mark](https://github.com/homarr-labs/dashboard-icons/blob/d767d7327db7f8ebd3715b552523f61889eea41c/svg/opencode-dark.svg) |
| `grok.png` | [Grok mark](https://github.com/homarr-labs/dashboard-icons/blob/d767d7327db7f8ebd3715b552523f61889eea41c/svg/grok-dark.svg) |
| `dsh.png` | [DeepSeek mark](https://github.com/homarr-labs/dashboard-icons/blob/d767d7327db7f8ebd3715b552523f61889eea41c/svg/deepseek.svg) |

Homarr Labs' collection is Apache-2.0 licensed; see `HOMARR-LICENSE`. Its marks were rendered as monochrome masks, as listed above. Their underlying marks remain the property of their respective owners. The Claude vector is adapted, recolored, and rasterized from T3 Code's MIT-licensed implementation (`T3-MIT`). Brand names and marks remain subject to their own owners' guidelines. This collection is attribution and asset provenance, not an endorsement or replacement for each project's trademark terms.

See also [T3 Code's `ProviderIcon`](https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/components/ProviderIcon.tsx) and [MonoCode's `HarnessIcon`](https://github.com/hardbeat920/monocode/blob/main/src/features/sessions/ui/HarnessIcon.tsx), consulted for the shared-mark and theme-aware-fallback approach only.
