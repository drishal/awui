# Credits

The interface borrows patterns, not code, from four MIT-licensed projects:

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (© 2026 DeepSeek):
  - plain answers with user bubbles;
  - the "Worked for …" process fold and its one-line disclosure rows;
  - the tool input/output card;
  - the composer card with settings inside and the centred empty-chat composer;
  - approvals in the composer;
  - the context ring and the turn rail;
  - the model picker anchored to the composer, with pinned provider headings;
  - the neutral built-in palette.
- **[OpenCode](https://github.com/anomalyco/opencode)** (© 2025 opencode): tool counts on the fold line, changed files per turn, the Deny / Approve button order, and model search that ignores punctuation, with recents.
- **[Hermes Desktop](https://github.com/NousResearch/hermes-agent/tree/main/apps/desktop)** (© 2025 Nous Research):
  - "flat, not boxed";
  - the model picker's "Current" line;
  - the composer status stack with its ridge;
  - stacked approval cards;
  - red reserved for real failures;
  - chat text size separate from page zoom;
  - the bottom status bar;
  - an animated loader instead of "Loading…".
- **[T3 Code](https://github.com/pingdotgg/t3code)** (© 2026 T3 Tools Inc.):
  - the compact-before-send chip and the *Needs you* inbox;
  - ↑ prompt recall, list continuation, and the prompt stash in the composer;
  - find in chat and search in project;
  - the proposed-plan card, the usage-limit recovery banner, and editing queued messages;
  - the session hover card, prompt links, and the count of what needs you in the title.

## Not included (by design)

Profiles, voice, side agents, browser editing of auth, settings, trust, or theme files, a remote file editor, direct provider APIs, a second database, a full session-tree UI (only the active branch is shown), a generic ACP adapter (designed for, not built), public deploy or Funnel, telemetry, and share links.
