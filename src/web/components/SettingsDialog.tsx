// Settings: pairing and sign-out for this device, and the server's
// config.yml — including the theme and text size every device shares. The
// server section is editable from any signed-in device; a save is checked
// server-side the way startup checks the file (and refused if it would lock out
// the device making it), and what takes a restart says so, with a Restart
// button when systemd supervises.
//
// The dialog is two panes: a rail of sections with a search field over it, and
// the one section that is open, scrolling on its own under a Save bar that
// stays put. Every section stays mounted while another is shown, so the form
// keeps one draft and one Save: switching sections never drops an edit. On a
// phone the same two panes become a list and a detail: the rail, then the
// section with a way back.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { AcpAgentPatch, AcpAgentProbe, AcpAgentSettings, AgentProfilePatch, AgentProfileSettings, Bootstrap, ChatWidth, Density, HarnessStatus, RestartSetting, ServerSettings, ServerSettingsValues, SettingsPatch, ThemeChoice, ToolStyle, UiFont } from "../../shared/protocol.js";
import { asHarnessId } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";
import { FormRow } from "./FormRow.js";
import { Segmented } from "./Segmented.js";
import { Select } from "./Select.js";
import { Switch } from "./Switch.js";
import { TEXT_SCALES } from "./Sidebar.js";
import { IconPlus, IconRefresh, IconX } from "../icons.js";
import { InvitationsPanel } from "./InvitationsPanel.js";
import type { NotifyState } from "../notify.js";
import { chime, chimeOn, setChime } from "../attention.js";
import { matchSettings, type SettingsSectionText } from "../settings-search.js";
import { load as loadStored, save as saveStored } from "../storage.js";
import { HarnessMark } from "./HarnessMark.js";
import { removeHarnessIcon, uploadHarnessIcon } from "../harness-icon-upload.js";

const NOTIFY_NOTE: Record<NotifyState["mode"], string> = {
  off: "When a run finishes, fails, or asks for an answer.",
  push: "On, even with this page closed.",
  page: "On while this page stays open in the background.",
  blocked: "Blocked in the browser's site settings for this address; allow them there first.",
  unsupported: "This browser cannot show notifications.",
};

const RESTART_LABEL: Record<RestartSetting, string> = {
  port: "port",
  host: "listening address",
  username: "username",
  password: "password",
  workspaceRoots: "workspace roots",
  allowedHosts: "allowed hosts",
  allowedTailscaleUsers: "Tailscale users",
  acpAgents: "ACP agents",
};

/** The dialog's sections, in the order they are read: the rail's list and the pane's headings. */
const SECTIONS = [
  { id: "device", label: "This device" },
  { id: "look", label: "Appearance" },
  { id: "layout", label: "Layout" },
  { id: "agents", label: "Agents" },
  { id: "acp", label: "ACP agents" },
  { id: "desktop", label: "Desktop app" },
  { id: "network", label: "Network and sign-in" },
  { id: "access", label: "Folders and access" },
  { id: "invites", label: "Invitations" },
  { id: "awui", label: "Awui harness" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const isSection = (id: string | undefined): id is SectionId => SECTIONS.some((s) => s.id === id);

/** The section this browser opened Settings on last; a section a deep link names wins over it. */
const LAST_SECTION = "settingsSection";

/** The section to open on: the one a link named, else the one this browser used last, else the first. */
function openingSection(section: string | undefined): SectionId {
  if (isSection(section)) return section;
  const last = loadStored<string>(LAST_SECTION, "");
  return isSection(last) ? last : "device";
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** A provider row as the awui dialog edits it (apiKey stays blank to keep the stored one). */
interface AwuiProviderRow {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  /** The stored key, redacted server-side to a flag; blank in the form means "keep it". */
  hadKey: boolean;
}

interface AwuiSettingsState {
  rows: AwuiProviderRow[];
  /** The share checkbox as the user has it now. */
  shareAuth: boolean;
  /** What the server had when the section loaded; the toggle is sent only when the two differ. */
  loadedShareAuth: boolean;
  /** A ~/.pi/agent/auth.json exists, so sharing is offered rather than only explained. */
  piLogin: boolean;
  busy: boolean;
  error: string | null;
  saved: boolean;
}

interface AwuiSettingsResponse {
  providers: Record<string, { baseUrl: string; api: string; hasApiKey: boolean; modelOverrides?: Record<string, unknown> }>;
  shareAuth: boolean;
  piLogin: boolean;
}

function draftAwui(c: AwuiSettingsResponse): AwuiSettingsState {
  return {
    rows: Object.entries(c.providers).map(([name, p]) => ({ name, baseUrl: p.baseUrl, api: p.api, apiKey: "", hadKey: p.hasApiKey })),
    shareAuth: c.shareAuth,
    loadedShareAuth: c.shareAuth,
    piLogin: c.piLogin,
    busy: false,
    error: null,
    saved: false,
  };
}

const SCALE_MIN = TEXT_SCALES[0]?.[1] ?? 0.85;
const SCALE_MAX = TEXT_SCALES[TEXT_SCALES.length - 1]?.[1] ?? 1.35;

/**
 * One ACP agent as the form holds it: `args` is one argument per line (an
 * argument may hold a space) and `env` is `NAME=value` lines. A value left blank
 * keeps the one the server already stored, which the browser is never shown.
 */
interface AcpAgentRow {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  envNames: string[];
  authMethod: string;
}

function acpRowsOf(agents: AcpAgentSettings[]): AcpAgentRow[] {
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name === agent.id ? "" : agent.name,
    command: agent.command,
    args: agent.args.join("\n"),
    env: agent.envNames.map((name) => `${name}=`).join("\n"),
    envNames: agent.envNames,
    authMethod: agent.authMethod ?? "",
  }));
}

/**
 * One shared agent profile as the form holds it: a named seat (harness, model,
 * thinking level, permission mode, note) every room and delegation can use.
 */
interface AgentProfileRow {
  name: string;
  harness: string;
  model: string;
  thinking: string;
  permissionMode: string;
  note: string;
}

function agentProfileRowsOf(profiles: AgentProfileSettings[]): AgentProfileRow[] {
  return profiles.map((p) => ({ name: p.name, harness: p.harness, model: p.model ?? "", thinking: p.thinking ?? "", permissionMode: p.permissionMode ?? "", note: p.note ?? "" }));
}

/** The list as the dialog saves it: an empty field is the harness's own default, said as null. */
function agentProfilePatchOf(rows: AgentProfileRow[]): AgentProfilePatch[] {
  return rows.map((row) => ({
    name: row.name.trim(),
    harness: row.harness.trim(),
    ...(row.model.trim() ? { model: row.model.trim() } : {}),
    ...(row.thinking.trim() ? { thinking: row.thinking.trim() } : {}),
    ...(row.permissionMode.trim() ? { permissionMode: row.permissionMode.trim() } : {}),
    ...(row.note.trim() ? { note: row.note.trim() } : {}),
  }));
}

/** The env lines as names and values; a value typed as "-" clears it, and a blank one keeps the stored value. */
function acpPatchOf(rows: AcpAgentRow[]): AcpAgentPatch[] {
  return rows.map((row) => {
    const env: Record<string, string> = {};
    for (const line of lines(row.env)) {
      const at = line.indexOf("=");
      const name = (at >= 0 ? line.slice(0, at) : line).trim();
      const value = at >= 0 ? line.slice(at + 1).trim() : "";
      if (name) env[name] = value;
    }
    return {
      id: row.id.trim(),
      ...(row.name.trim() ? { name: row.name.trim() } : {}),
      command: row.command.trim(),
      ...(lines(row.args).length > 0 ? { args: lines(row.args) } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      authMethod: row.authMethod.trim() || null,
    };
  });
}

/** The form's working copy: lists as one entry per line, the password as a write-only field. */
interface Draft {
  port: string;
  host: ServerSettingsValues["host"];
  username: string;
  password: string;
  removePassword: boolean;
  workspaceRoots: string;
  allowedHosts: string;
  allowedTailscaleUsers: string;
  theme: ThemeChoice | "";
  textScale: number;
  chatWidth: ChatWidth;
  density: Density;
  toolStyle: ToolStyle;
  font: UiFont;
  autocollapseSidebar: boolean;
  showStatusBar: boolean;
  herdr: boolean;
  orchestrationEnabled: boolean;
  desktopBackground: boolean;
  /** config.yml's `harnesses.acp` entries as the form edits them (args and env one per line). */
  acpAgents: AcpAgentRow[];
  /** config.yml's `agent_profiles` entries as the form edits them. */
  agentProfiles: AgentProfileRow[];
}

/** The font tokens.css ships as the default (public/fonts), named where the Font setting offers it. */
const BUNDLED_FONT = "Inter";

function draftOf(v: ServerSettingsValues): Draft {
  return {
    port: String(v.port),
    host: v.host,
    username: v.username,
    password: "",
    removePassword: false,
    workspaceRoots: v.workspaceRoots.join("\n"),
    allowedHosts: v.allowedHosts.join("\n"),
    allowedTailscaleUsers: v.allowedTailscaleUsers.join("\n"),
    theme: v.theme ?? "",
    textScale: v.textScale ?? 1,
    chatWidth: v.chatWidth ?? "comfortable",
    density: v.density ?? "comfortable",
    toolStyle: v.toolStyle ?? "cards",
    font: v.font ?? "bundled",
    autocollapseSidebar: v.autocollapseSidebar,
    showStatusBar: v.showStatusBar,
    herdr: v.herdr,
    orchestrationEnabled: v.orchestrationEnabled,
    desktopBackground: v.desktopBackground,
    acpAgents: acpRowsOf(v.acpAgents),
    agentProfiles: agentProfileRowsOf(v.agentProfiles),
  };
}

/** Only what the form changed, so a save never rewrites a setting nobody touched. */
function patchOf(d: Draft, v: ServerSettingsValues): SettingsPatch {
  const p: SettingsPatch = {};
  const port = Number(d.port);
  if (d.port.trim() !== String(v.port)) p.port = port;
  if (d.host !== v.host) p.host = d.host;
  if (d.username.trim() !== v.username) p.username = d.username.trim();
  if (d.removePassword) p.password = null;
  else if (d.password) p.password = d.password;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(lines(d.workspaceRoots), v.workspaceRoots)) p.workspaceRoots = lines(d.workspaceRoots);
  if (!same(lines(d.allowedHosts), v.allowedHosts)) p.allowedHosts = lines(d.allowedHosts);
  if (!same(lines(d.allowedTailscaleUsers), v.allowedTailscaleUsers)) p.allowedTailscaleUsers = lines(d.allowedTailscaleUsers);
  if ((d.theme || null) !== v.theme) p.theme = d.theme || null;
  if (d.textScale !== (v.textScale ?? 1)) p.textScale = d.textScale;
  // Comfortable is the default: saved as no setting at all.
  const width = d.chatWidth === "comfortable" ? null : d.chatWidth;
  if (width !== v.chatWidth) p.chatWidth = width;
  const density = d.density === "comfortable" ? null : d.density;
  if (density !== v.density) p.density = density;
  // Cards are the default: saved as no setting at all.
  const toolStyle = d.toolStyle === "cards" ? null : d.toolStyle;
  if (toolStyle !== v.toolStyle) p.toolStyle = toolStyle;
  // The bundled font is the default: saved as no setting at all.
  const font = d.font === "bundled" ? null : d.font;
  if (font !== v.font) p.font = font;
  if (d.autocollapseSidebar !== v.autocollapseSidebar) p.autocollapseSidebar = d.autocollapseSidebar;
  if (d.showStatusBar !== v.showStatusBar) p.showStatusBar = d.showStatusBar;
  if (d.herdr !== v.herdr) p.herdr = d.herdr;
  if (d.orchestrationEnabled !== v.orchestrationEnabled) p.orchestrationEnabled = d.orchestrationEnabled;
  if (d.desktopBackground !== v.desktopBackground) p.desktopBackground = d.desktopBackground;
  // ACP agents compare as the form holds them: the argument and env lines are its own spelling.
  if (JSON.stringify(d.acpAgents) !== JSON.stringify(acpRowsOf(v.acpAgents))) p.acpAgents = acpPatchOf(d.acpAgents);
  // Shared agent profiles compare the same way: the form's empty fields are its own spelling.
  if (JSON.stringify(d.agentProfiles) !== JSON.stringify(agentProfileRowsOf(v.agentProfiles))) p.agentProfiles = agentProfilePatchOf(d.agentProfiles);
  return p;
}

export function SettingsDialog({
  scheme,
  section,
  harnesses,
  onHarnessMark,
  onPair,
  signedInAs,
  onSignOut,
  version,
  notify,
  onToggleNotify,
  onTestNotify,
  onUiSaved,
  onClose,
}: {
  /** A theme.yml is loaded: offer its scheme. */
  scheme: { name: string | null } | null;
  /** The section to open on (a `?settings=<id>` link); the one last used otherwise. */
  section?: string;
  onPair: () => void;
  signedInAs: string | null;
  onSignOut: () => void;
  version: string;
  notify: NotifyState;
  onToggleNotify: () => Promise<void>;
  onTestNotify: () => Promise<void>;
  /** Live server state, including the custom marks this machine uploaded. */
  harnesses: Bootstrap["harnesses"];
  /** A custom agent's stored mark changed: selectors follow the server's small PNG. */
  onHarnessMark: (id: string, src: string | null) => void;
  /** The file's look settings changed: the open page follows without a reload. */
  onUiSaved: (ui: Partial<Bootstrap["ui"]>) => void;
  onClose: () => void;
}) {
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  /** Each ACP agent's last Test: its own line when it draws one, else its error. */
  const [acpTests, setAcpTests] = useState<Record<string, { busy: boolean; line?: string; error?: string }>>({});
  /** Local upload overrides until the parent's live bootstrap carries the returned URL. */
  const [iconOverrides, setIconOverrides] = useState<Record<string, string | undefined>>({});
  const [iconStates, setIconStates] = useState<Record<string, { busy: boolean; notice?: string; error?: string }>>({});
  // The awui harness's own providers; null until loaded, false when the harness is off.
  const [awui, setAwui] = useState<AwuiSettingsState | null>(null);
  const [active, setActive] = useState<SectionId>(() => openingSection(section));
  const [query, setQuery] = useState("");
  /** A phone shows the rail, then the section it was sent to; a wide screen shows both at once. */
  const [detail, setDetail] = useState(isSection(section));
  const pane = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  // What each row says, read from the page itself (every row carries data-settings-row), so the
  // search cannot drift from the rows on screen. Rows a search hides stay in the page to be read.
  const [index, setIndex] = useState<SettingsSectionText[]>([]);

  useEffect(() => {
    void api<ServerSettings>("/api/settings")
      .then((s) => {
        setServer(s);
        setDraft(draftOf(s.values));
      })
      .catch((e: unknown) => setError(errorText(e)));
    void api<AwuiSettingsResponse>("/api/awui/settings")
      .then((c) => setAwui(draftAwui(c)))
      .catch(() => setAwui(null)); // harness not registered: no section
  }, []);

  useEffect(() => {
    const root = pane.current;
    if (!root) return;
    setIndex(
      SECTIONS.map((s) => {
        const panel = root.querySelector(`#settings-panel-${s.id}`);
        return {
          id: s.id,
          label: s.label,
          rows: Array.from(panel?.querySelectorAll<HTMLElement>("[data-settings-row]") ?? [], (el) => ({ key: el.dataset.settingsRow ?? "", text: el.textContent ?? "" })),
        };
      }),
    );
  }, [draft !== null, server !== null, awui?.rows.length]);

  const editable = Boolean(server?.editable && server.writable);
  const patch = server && draft ? patchOf(draft, server.values) : {};
  const dirty = Object.keys(patch).length > 0;
  const overridden = (key: keyof ServerSettingsValues) => server?.envOverrides.includes(key) ?? false;
  const field = (key: keyof ServerSettingsValues) => !editable || overridden(key);
  const update = (change: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...change } : d));
    setSaved(false);
  };

  const save = async () => {
    if (!server || !draft || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api<ServerSettings>("/api/settings", { method: "PUT", body: patch });
      setServer(next);
      setDraft(draftOf(next.values));
      setSaved(true);
      if (
        patch.theme !== undefined ||
        patch.textScale !== undefined ||
        patch.chatWidth !== undefined ||
        patch.density !== undefined ||
        patch.toolStyle !== undefined ||
        patch.font !== undefined ||
        patch.autocollapseSidebar !== undefined ||
        patch.showStatusBar !== undefined ||
        patch.herdr !== undefined
      ) {
        onUiSaved({
          theme: next.values.theme,
          textScale: next.values.textScale,
          chatWidth: next.values.chatWidth,
          density: next.values.density,
          toolStyle: next.values.toolStyle,
          font: next.values.font,
          autocollapseSidebar: next.values.autocollapseSidebar,
          showStatusBar: next.values.showStatusBar,
          ...(patch.herdr !== undefined ? { herdr: next.values.herdr } : {}),
        });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const saveAwui = async () => {
    if (!awui || awui.busy) return;
    setAwui({ ...awui, busy: true, error: null, saved: false });
    try {
      const providers: Record<string, { baseUrl: string; api: string; apiKey?: string }> = {};
      for (const r of awui.rows) {
        if (!r.name.trim() || !r.baseUrl.trim()) continue;
        // Blank key keeps the stored one (omitted); "-" is the form's clear sentinel, sent as "".
        providers[r.name.trim()] = { baseUrl: r.baseUrl.trim(), api: r.api.trim() || "openai-completions", ...(r.apiKey === "" ? {} : { apiKey: r.apiKey === "-" ? "" : r.apiKey }) };
      }
      // The toggle is sent only when it changed: a providers-only save must not re-seed Pi's list.
      const shareAuth = awui.shareAuth !== awui.loadedShareAuth ? awui.shareAuth : undefined;
      const next = await api<AwuiSettingsResponse>("/api/awui/settings", { method: "PUT", body: { providers, ...(shareAuth !== undefined ? { shareAuth } : {}) } });
      setAwui({ ...draftAwui(next), saved: true });
    } catch (e) {
      setAwui({ ...awui, busy: false, error: errorText(e) });
    }
  };

  /** systemd brings the server back; wait for it, then reload (on its new port, when that changed). */
  const restart = async () => {
    if (!server) return;
    setRestarting(true);
    setError(null);
    try {
      await api("/api/settings/restart", { body: {} });
    } catch (e) {
      setRestarting(false);
      setError(errorText(e));
      return;
    }
    const portChanged = server.restartPending.includes("port") && !server.envOverrides.includes("port");
    const origin = portChanged ? `${window.location.protocol}//${window.location.hostname}:${server.values.port}` : window.location.origin;
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() - started < 60_000) {
      try {
        const res = await fetch(`${origin}/api/health`, { cache: "no-store", mode: portChanged ? "no-cors" : "same-origin" });
        if (portChanged || res.ok) {
          window.location.assign(`${origin}${window.location.pathname}${window.location.hash}`);
          return;
        }
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    setRestarting(false);
    setError("The server has not come back yet; check its log (journalctl --user -u awui).");
  };

  const [notifyBusy, setNotifyBusy] = useState(false);
  const [chimes, setChimes] = useState(chimeOn);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const notifyOn = notify.mode === "push" || notify.mode === "page";
  const notifyAction = async (action: () => Promise<void>) => {
    setNotifyBusy(true);
    setNotifyError(null);
    try {
      await action();
    } catch (e) {
      setNotifyError(errorText(e));
    } finally {
      setNotifyBusy(false);
    }
  };

  const pendingText = server?.restartPending.map((k) => RESTART_LABEL[k]).join(", ") ?? "";

  const themeOptions = [
    { value: "", label: "Automatic", hint: "theme.yml if present, else the system" },
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "base16", label: "base16", ...(scheme?.name ? { hint: scheme.name } : {}) },
  ];
  const setAwuiRow = (i: number, change: Partial<AwuiProviderRow>) => awui && setAwui({ ...awui, saved: false, rows: awui.rows.map((x, j) => (j === i ? { ...x, ...change } : x)) });

  const setAcpRow = (i: number, change: Partial<AcpAgentRow>) => draft && update({ acpAgents: draft.acpAgents.map((row, j) => (j === i ? { ...row, ...change } : row)) });
  const setAgentProfileRow = (i: number, change: Partial<AgentProfileRow>) => draft && update({ agentProfiles: draft.agentProfiles.map((row, j) => (j === i ? { ...row, ...change } : row)) });
  const markFor = (row: AcpAgentRow): { id: HarnessStatus["id"]; icon?: string } | undefined => {
    const id = row.id.trim();
    const existing = harnesses.find((h) => h.id === id);
    return (id && savedAcpIds.includes(id)) || existing ? { id: existing?.id ?? asHarnessId(id), icon: iconOverrides[id] ?? existing?.icon } : undefined;
  };
  const changeHarnessMark = async (row: AcpAgentRow, file: File | null) => {
    const id = row.id.trim();
    if (!id || (file === null && !(iconOverrides[id] ?? harnesses.find((h) => h.id === id)?.icon))) return;
    setIconStates((states) => ({ ...states, [id]: { busy: true } }));
    try {
      const next = file ? await uploadHarnessIcon(id, file) : await removeHarnessIcon(id);
      setIconOverrides((prev) => ({ ...prev, [id]: next.icon ?? undefined }));
      onHarnessMark(id, next.icon);
    } catch (e) {
      setIconStates((states) => ({ ...states, [id]: { busy: false, error: errorText(e) } }));
      return;
    }
    setIconStates((states) => ({ ...states, [id]: { busy: false, notice: file ? "Saved." : "Removed. The neutral fallback is shown instead." } }));
  };

  /** The ids config.yml has now: a row must be saved before the server can handshake with it. */
  const savedAcpIds = server?.values.acpAgents.map((agent) => agent.id) ?? [];
  /** One handshake, no model call: what the saved agent calls itself and what it advertises. */
  const testAcp = async (row: AcpAgentRow) => {
    const id = row.id.trim();
    if (!id) return;
    setAcpTests((tests) => ({ ...tests, [id]: { busy: true } }));
    try {
      const probe = await api<AcpAgentProbe>("/api/settings/acp/test", { method: "POST", body: { id } });
      const said = [probe.agentName ?? "The agent", probe.version ? `v${probe.version}` : ""].filter(Boolean).join(" ");
      const bits = [probe.resume ? (probe.replay ? "resumes with history" : "resumes without history") : "no resume", probe.images ? "images" : "no images", probe.mcpHttp ? "HTTP MCP" : "stdio MCP"];
      const methods = probe.authMethods.length > 0 ? `; sign-in: ${probe.authMethods.join(", ")}` : "; no sign-in methods";
      const warnings = probe.warnings.length > 0 ? ` — ${probe.warnings.join(" ")}` : "";
      setAcpTests((tests) => ({ ...tests, [id]: { busy: false, line: `${said}: ${bits.join(", ")}${methods}${warnings}` } }));
    } catch (e) {
      setAcpTests((tests) => ({ ...tests, [id]: { busy: false, error: errorText(e) } }));
    }
  };

  // A section exists once it has something to show: the server's form once it loaded, the awui
  // harness's own when the harness is registered. Invitations need only their own list.
  const sections = SECTIONS.filter((s) => (s.id === "device" ? true : s.id === "invites" ? true : s.id === "awui" ? awui !== null : draft !== null));
  const current = sections.find((s) => s.id === active)?.id ?? "device";
  const currentLabel = SECTIONS.find((s) => s.id === current)?.label ?? "";
  const matches = useMemo(() => matchSettings(index, query), [index, query]);
  const railSections = matches ? sections.filter((s) => matches.sections.includes(s.id)) : sections;
  /** Whether a row survives the search (every row does when nothing was typed). */
  const shows = (id: SectionId, row: string) => {
    const rows = matches?.rows[id];
    return rows === undefined || rows.includes(row);
  };
  // A field the save would be refused for: the rail says which section holds it, so a fix is
  // never hidden behind a section nobody opened.
  const port = draft?.port.trim() ?? "";
  const issues: Partial<Record<SectionId, string>> = {};
  if (draft && editable && (port === "" || Number(port) < 1 || Number(port) > 65_535)) {
    issues.network = port === "" ? "The port cannot be empty." : "The port must be between 1 and 65535.";
  }
  if (draft && editable && draft.acpAgents.length > 0) {
    const ids = draft.acpAgents.map((row) => row.id.trim());
    if (ids.some((id) => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))) issues.acp = "An id is a lowercase slug: letters, digits, and - (at most 32), not starting with -.";
    else if (new Set(ids).size !== ids.length) issues.acp = "Two ACP agents share an id.";
    else if (draft.acpAgents.some((row) => !row.command.trim())) issues.acp = "An ACP agent needs the command that starts it.";
  }
  if (draft && editable && draft.agentProfiles.length > 1) {
    const names = draft.agentProfiles.map((row) => row.name.trim().toLowerCase()).filter(Boolean);
    if (new Set(names).size !== names.length) issues.agents = "Two shared profiles share a name.";
  }

  // Typing a search that no section's open rows match opens the first section that does: the
  // pane never sits on an empty section while another holds what was asked for.
  useEffect(() => {
    if (!matches || matches.sections.length === 0 || matches.sections.includes(current)) return;
    const first = matches.sections[0];
    if (isSection(first)) setActive(first);
  }, [matches, current]);

  const choose = (id: SectionId) => {
    setActive(id);
    setDetail(true);
    saveStored(LAST_SECTION, id);
  };

  /** Arrow keys move through the rail, as a tab list's do (the chosen section opens as it is passed). */
  const railKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = railSections.findIndex((s) => s.id === current);
    const last = railSections.length - 1;
    const next = e.key === "ArrowDown" ? (at >= last ? 0 : at + 1) : e.key === "ArrowUp" ? (at <= 0 ? last : at - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    const target = railSections[next];
    if (next < 0 || !target) return;
    e.preventDefault();
    choose(target.id);
    rail.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <Dialog title="Settings" onClose={onClose} className={`dialog-wide settings-dialog${detail ? " is-detail" : ""}`}>
      <div className="settings-rail">
        <input
          type="search"
          className="input settings-rail-search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDetail(false);
          }}
          // Escape empties the search rather than closing the dialog: clearing a filter is what it means here.
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !query) return;
            e.preventDefault();
            setQuery("");
          }}
        />
        <div className="settings-rail-list" role="tablist" aria-label="Settings sections" aria-orientation="vertical" ref={rail} onKeyDown={railKeys}>
          {railSections.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`settings-tab-${s.id}`}
              className="settings-rail-item"
              aria-selected={current === s.id}
              aria-controls={`settings-panel-${s.id}`}
              aria-describedby={issues[s.id] ? `settings-issue-${s.id}` : undefined}
              title={issues[s.id]}
              tabIndex={current === s.id ? 0 : -1}
              onClick={() => choose(s.id)}
            >
              <span className="settings-rail-label">{s.label}</span>
              {issues[s.id] ? <span className="settings-rail-flag" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        {matches && railSections.length === 0 ? <p className="settings-rail-empty">Nothing matches “{query.trim()}”.</p> : null}
        {SECTIONS.filter((s) => issues[s.id]).map((s) => (
          <span key={s.id} id={`settings-issue-${s.id}`} className="visually-hidden">
            {issues[s.id]}
          </span>
        ))}
      </div>

      <div className="settings-pane" ref={pane}>
        {/* Phones: the rail is the list, this is the section it opened. */}
        <button type="button" className="settings-back" onClick={() => setDetail(false)}>
          <span aria-hidden="true">‹</span> Sections
        </button>

        <section className="form-section" id="settings-panel-device" role="tabpanel" aria-labelledby="settings-device" hidden={current !== "device"}>
          <h3 id="settings-device">This device</h3>
          <div className="form-card">
            <FormRow row="pair" hidden={!shows("device", "pair")} label="Other devices" desc={signedInAs ? `Signed in as ${signedInAs}.` : "Open awui on a phone by scanning a code."}>
              <button type="button" className="btn btn-small" onClick={onPair}>
                Pair phone
              </button>
              {signedInAs ? (
                <button type="button" className="btn btn-small btn-ghost" onClick={onSignOut} title={`Signed in as ${signedInAs}`}>
                  Sign out
                </button>
              ) : null}
            </FormRow>
            <FormRow
              row="notify"
              hidden={!shows("device", "notify")}
              label="Notifications"
              descId="notify-note"
              desc={
                notifyError ??
                `${NOTIFY_NOTE[notify.mode]}${notify.why === "insecure" ? " Push needs HTTPS (Tailscale Serve) or this machine." : notify.why === "no-push" ? " This browser has no push service." : ""}`
              }
            >
              {notifyOn ? (
                <button type="button" className="btn btn-small btn-ghost" disabled={notifyBusy} onClick={() => void notifyAction(onTestNotify)}>
                  Send a test
                </button>
              ) : null}
              <Switch label="Notifications" describedBy="notify-note" checked={notifyOn} disabled={notifyBusy || notify.mode === "unsupported"} onChange={() => void notifyAction(onToggleNotify)} />
            </FormRow>
            <FormRow row="sound" hidden={!shows("device", "sound")} label="Sound" desc="A chime, in this browser, when a chat finishes out of sight or asks for an answer." toggle>
              <Switch
                label="Sound"
                checked={chimes}
                onChange={(on) => {
                  setChime(on);
                  setChimes(on);
                  if (on) chime();
                }}
              />
            </FormRow>
          </div>
        </section>

        {!draft ? (
          current === "device" || current === "awui" || current === "invites" ? (
            current === "invites" ? <InvitationsPanel current={current} /> : null
          ) : (
            <section className="form-section" id={`settings-panel-${current}`} role="tabpanel" aria-labelledby="settings-loading">
              <h3 id="settings-loading">{currentLabel}</h3>
              {error ? (
                <p className="notice notice-error" role="alert">
                  {error}
                </p>
              ) : (
                <p className="form-note">Loading…</p>
              )}
            </section>
          )
        ) : (
          <form
            id="settings-form"
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <section className="form-section" id="settings-panel-look" role="tabpanel" aria-labelledby="settings-look" hidden={current !== "look"}>
              <h3 id="settings-look">Appearance</h3>
              <p className="form-note">
                {server && !server.writable
                  ? "This server runs without a settings folder, so there is nothing to save to."
                  : server && !server.editable
                    ? "These live in config.yml on the machine running the server; change them there."
                    : "Saved to config.yml for every device: it applies here at once, and on other devices at their next page load (atui at its next start)."}
              </p>
              <div className="form-card">
                <FormRow row="theme" hidden={!shows("look", "theme")} label="Theme" desc={draft.theme === "base16" && scheme?.name ? `The ${scheme.name} scheme from theme.yml.` : "Follow the system, or pin light or dark."}>
                  <Select label="Theme" value={draft.theme} disabled={!editable} options={themeOptions} onChange={(theme) => update({ theme: theme as ThemeChoice | "" })} />
                </FormRow>
                <FormRow row="text-size" hidden={!shows("look", "text-size")} label="Chat text size" desc="The conversation and the composer; menus keep their size.">
                  <div className="text-slider">
                    <input
                      type="range"
                      className="text-slider-input"
                      aria-label="Chat text size"
                      disabled={!editable}
                      min={SCALE_MIN}
                      max={SCALE_MAX}
                      step={0.01}
                      value={draft.textScale}
                      style={{ "--slider-fill": `${SCALE_MAX <= SCALE_MIN ? 0 : Math.min(100, Math.max(0, ((draft.textScale - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100))}%` } as CSSProperties}
                      onChange={(e) => update({ textScale: Number(e.target.value) })}
                    />
                    {/* The reset slot sits before the value, so the value ends on the controls' right edge whether or not the slot is filled. */}
                    <span className="text-slider-reset">
                      {draft.textScale !== 1 ? (
                        <button type="button" className="ghost-icon" aria-label="Reset text size" title="Reset to 100%" disabled={!editable} onClick={() => update({ textScale: 1 })}>
                          <IconRefresh size={14} />
                        </button>
                      ) : null}
                    </span>
                    <output className="text-slider-value" aria-live="off">
                      {Math.round(draft.textScale * 100)}%
                    </output>
                  </div>
                </FormRow>
                <FormRow row="width" hidden={!shows("look", "width")} label="Chat width" desc={WIDTH_NOTE[draft.chatWidth]}>
                  <Segmented<ChatWidth>
                    label="Chat width"
                    value={draft.chatWidth}
                    disabled={!editable}
                    options={[
                      { value: "comfortable", label: "Comfortable", title: "960px" },
                      { value: "wide", label: "Wide", title: "1400px" },
                      { value: "full", label: "Full", title: "The whole pane" },
                    ]}
                    onChange={(chatWidth) => update({ chatWidth })}
                  />
                </FormRow>
                <FormRow row="density" hidden={!shows("look", "density")} label="Density" desc={draft.density === "compact" ? "Tighter rows and gaps, with a mouse (touch keeps the larger sizes)." : "Room to breathe between rows."}>
                  <Segmented<Density>
                    label="Density"
                    value={draft.density}
                    disabled={!editable}
                    options={[
                      { value: "comfortable", label: "Comfortable" },
                      { value: "compact", label: "Compact" },
                    ]}
                    onChange={(density) => update({ density })}
                  />
                </FormRow>
                <FormRow
                  row="tools"
                  hidden={!shows("look", "tools")}
                  label="Tool calls"
                  desc={draft.toolStyle === "lines" ? "Each call its own line under the run's counts, with no card around them." : "A run's calls grouped as one card, with a mark per call and an opened call's output under it."}
                >
                  <Segmented<ToolStyle>
                    label="Tool calls"
                    value={draft.toolStyle}
                    disabled={!editable}
                    options={[
                      { value: "cards", label: "Cards", title: "One card per run" },
                      { value: "lines", label: "Lines", title: "A line per call" },
                    ]}
                    onChange={(toolStyle) => update({ toolStyle })}
                  />
                </FormRow>
                <FormRow row="font" hidden={!shows("look", "font")} label="Font" desc={draft.font === "system" ? "This device's own system font, as other apps here use." : `${BUNDLED_FONT}, shipped with awui, so every device reads the same.`}>
                  <Segmented<UiFont>
                    label="Font"
                    value={draft.font}
                    disabled={!editable}
                    options={[
                      { value: "bundled", label: BUNDLED_FONT, title: "Shipped with awui" },
                      { value: "system", label: "System", title: "This device's font" },
                    ]}
                    onChange={(font) => update({ font })}
                  />
                </FormRow>
              </div>
            </section>

            <section className="form-section" id="settings-panel-layout" role="tabpanel" aria-labelledby="settings-layout" hidden={current !== "layout"}>
              <h3 id="settings-layout">Layout</h3>
              <div className="form-card">
                <FormRow row="autocollapse" hidden={!shows("layout", "autocollapse")} label="Fold the sidebar away in narrow windows" desc="It comes back as a drawer from the edge." toggle>
                  <Switch label="Fold the sidebar away in narrow windows" checked={draft.autocollapseSidebar} disabled={!editable} onChange={(autocollapseSidebar) => update({ autocollapseSidebar })} />
                </FormRow>
                <FormRow row="status-bar" hidden={!shows("layout", "status-bar")} label="Status bar" desc="Under the conversation: connection, harness, model, folder, version." toggle>
                  <Switch label="Status bar" checked={draft.showStatusBar} disabled={!editable} onChange={(showStatusBar) => update({ showStatusBar })} />
                </FormRow>
                <FormRow row="herdr" hidden={!shows("layout", "herdr")} label="Work with herdr" desc="Mark the sessions open in its panes, and let atui in a pane report its chats." toggle>
                  <Switch label="Work with herdr" checked={draft.herdr} disabled={field("herdr")} onChange={(herdr) => update({ herdr })} />
                </FormRow>
              </div>
            </section>

            <section className="form-section" id="settings-panel-agents" role="tabpanel" aria-labelledby="settings-agents" hidden={current !== "agents"}>
              <h3 id="settings-agents">Agents</h3>
              <p className="form-note">The limits behind it — tasks per chat, how deep delegation goes, the wall clock, the call and wake budgets — live in config.yml under orchestration.</p>
              <div className="form-card">
                <FormRow row="delegate" hidden={!shows("agents", "delegate")} label="Agents delegate to other agents" desc="A chat's agent can hand a task to another agent chat, watch it, stop it, and read the result back. Off: no chat is given the tools." toggle>
                  <Switch label="Agents delegate to other agents" checked={draft.orchestrationEnabled} disabled={!editable} onChange={(orchestrationEnabled) => update({ orchestrationEnabled })} />
                </FormRow>
              </div>
              <div className="form-card">
                <div className="form-row is-stack" data-settings-row="agent-profiles" hidden={!shows("agents", "agent-profiles")}>
                  <span className="form-row-text">
                    <span className="form-label">Shared agent profiles</span>
                    <span className="form-desc">Named seats every room and delegation can use, in config.yml for every device: a harness, the model and thinking level it offers here, its permission mode, and a note a delegating model reads. An empty field is that harness's own default. Provider logins stay in each harness's own auth; a profile never holds one.</span>
                  </span>
                  {draft.agentProfiles.length > 0 ? (
                    <div className="agent-profiles">
                      {draft.agentProfiles.map((row, i) => (
                        <div className="agent-profile" key={i}>
                          <div className="agent-profile-row">
                            <input className="input" aria-label="Profile name" placeholder="e.g. reviewer" value={row.name} disabled={!editable} onChange={(e) => setAgentProfileRow(i, { name: e.target.value })} />
                            <input className="input" aria-label="Profile harness" placeholder="harness id (e.g. omp)" value={row.harness} disabled={!editable} onChange={(e) => setAgentProfileRow(i, { harness: e.target.value })} />
                            <input className="input" aria-label="Profile model" placeholder="provider/id (harness default)" value={row.model} disabled={!editable} onChange={(e) => setAgentProfileRow(i, { model: e.target.value })} />
                            <button type="button" className="ghost-icon" aria-label={`Remove ${row.name || "profile"}`} title="Remove profile" disabled={!editable} onClick={() => update({ agentProfiles: draft.agentProfiles.filter((_, j) => j !== i) })}>
                              <IconX size={14} />
                            </button>
                          </div>
                          <div className="agent-profile-row is-second">
                            <input className="input" aria-label="Profile thinking level" placeholder="thinking level (harness default)" value={row.thinking} disabled={!editable} onChange={(e) => setAgentProfileRow(i, { thinking: e.target.value })} />
                            <input className="input" aria-label="Profile permission mode" placeholder="permission mode (harness default)" value={row.permissionMode} disabled={!editable} onChange={(e) => setAgentProfileRow(i, { permissionMode: e.target.value })} />
                            <input className="input" aria-label="Profile note" placeholder="one line a delegating model reads" value={row.note} disabled={!editable} onChange={(e) => setAgentProfileRow(i, { note: e.target.value })} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="form-empty">None yet.</p>
                  )}
                  <button type="button" className="button" disabled={!editable} onClick={() => update({ agentProfiles: [...draft.agentProfiles, { name: "", harness: "", model: "", thinking: "", permissionMode: "", note: "" }] })}>
                    Add a shared profile
                  </button>
                </div>
              </div>
            </section>

            <section className="form-section" id="settings-panel-acp" role="tabpanel" aria-labelledby="settings-acp" hidden={current !== "acp"}>
              <h3 id="settings-acp">ACP agents</h3>
              <p className="form-note">Any app that speaks the Agent Client Protocol over stdio (Gemini CLI, Qwen Code, Goose, Cline, …), each a harness of its own with no code. The agent keeps its own login and session files; awui only starts it. A change to this list takes effect when the server restarts.</p>
              <div className="form-card">
                <div className="form-row is-stack" data-settings-row="acp-list" hidden={!shows("acp", "acp-list")}>
                  <span className="form-row-text">
                    <span className="form-label">Agents</span>
                    <span className="form-desc">Arguments one per line (an argument may hold a space). Env lines are NAME=value: a value left blank keeps the stored one, and removing the line removes the variable. Test runs one handshake, no model call.</span>
                  </span>
                  {draft.acpAgents.length > 0 ? (
                    <div className="acp-agents">
                      {draft.acpAgents.map((row, i) => (
                        <div className="acp-agent" key={i}>
                          <div className="acp-agent-row">
                            <input className="input" aria-label="ACP agent id" placeholder="gemini" value={row.id} disabled={!editable} onChange={(e) => setAcpRow(i, { id: e.target.value })} />
                            <input className="input" aria-label="ACP agent name" placeholder="Gemini CLI" value={row.name} disabled={!editable} onChange={(e) => setAcpRow(i, { name: e.target.value })} />
                            <input className="input" aria-label="ACP agent command" placeholder="gemini" value={row.command} disabled={!editable} onChange={(e) => setAcpRow(i, { command: e.target.value })} />
                            <button type="button" className="ghost-icon" aria-label={`Remove ${row.name || row.id || "agent"}`} title="Remove agent" disabled={!editable} onClick={() => update({ acpAgents: draft.acpAgents.filter((_, j) => j !== i) })}>
                              <IconX size={14} />
                            </button>
                          </div>
                          <div className="acp-agent-row">
                            <textarea className="input" aria-label="ACP agent arguments" placeholder="--acp" rows={2} value={row.args} disabled={!editable} onChange={(e) => setAcpRow(i, { args: e.target.value })} />
                            <textarea className="input" aria-label="ACP agent environment" placeholder="GEMINI_API_KEY=" rows={2} value={row.env} disabled={!editable} onChange={(e) => setAcpRow(i, { env: e.target.value })} />
                            <input className="input" aria-label="ACP agent auth method" placeholder="auth method (optional)" value={row.authMethod} disabled={!editable} onChange={(e) => setAcpRow(i, { authMethod: e.target.value })} />
                          </div>
                          <div className="acp-agent-mark" data-icon-state={iconStates[row.id.trim()]?.error ?? iconStates[row.id.trim()]?.notice ?? ""}>
                            <HarnessMark harness={markFor(row)} size={22} />
                            <div className="acp-agent-mark-copy">
                              <span className="form-label">Agent icon</span>
                              <span className="form-desc">Optional. Cropped to square (SVGs fitted), converted to a 64 × 64 PNG in your browser, and saved in awui's own state folder. Never fetched from an icon service.</span>
                            </div>
                            <label className={`button${!editable || !savedAcpIds.includes(row.id.trim()) || iconStates[row.id.trim()]?.busy === true ? " is-disabled" : ""}`} aria-disabled={!editable || !savedAcpIds.includes(row.id.trim()) || iconStates[row.id.trim()]?.busy === true}>
                              {iconOverrides[row.id.trim()] !== undefined || harnesses.find((h) => h.id === row.id.trim())?.icon ? "Change icon" : "Upload icon"}
                              <input type="file" aria-label={`Upload icon for ${row.name || row.id.trim() || "agent"}`} accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" disabled={!editable || !savedAcpIds.includes(row.id.trim()) || iconStates[row.id.trim()]?.busy === true} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } }} onChange={(e) => { const file = e.target.files?.[0] ?? null; e.target.value = ""; if (file) void changeHarnessMark(row, file); }} />
                            </label>
                            {iconOverrides[row.id.trim()] !== undefined || harnesses.find((h) => h.id === row.id.trim())?.icon ? <button type="button" className="button btn-ghost" disabled={!editable || iconStates[row.id.trim()]?.busy === true} onClick={() => void changeHarnessMark(row, null)}>Remove</button> : null}
                            {iconStates[row.id.trim()]?.busy ? <span className="form-desc">Preparing…</span> : null}
                            {iconStates[row.id.trim()]?.notice ? <span className="form-desc">{iconStates[row.id.trim()]?.notice}</span> : null}
                            {iconStates[row.id.trim()]?.error ? <span className="notice notice-error" role="alert">{iconStates[row.id.trim()]?.error}</span> : null}
                          </div>
                          <div className="acp-agent-test">
                            <button type="button" className="button" disabled={!editable || !savedAcpIds.includes(row.id.trim()) || acpTests[row.id]?.busy === true} onClick={() => void testAcp(row)}>
                              Test
                            </button>
                            {(() => {
                              const test = acpTests[row.id];
                              if (!test) return null;
                              if (test.busy) return <span className="form-desc">Testing…</span>;
                              if (test.error) return <span className="notice notice-error" role="alert">{test.error}</span>;
                              return <span className="form-desc">✓ {test.line}</span>;
                            })()}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="form-empty">None yet.</p>
                  )}
                  <button type="button" className="button" disabled={!editable} onClick={() => update({ acpAgents: [...draft.acpAgents, { id: "", name: "", command: "", args: "", env: "", envNames: [], authMethod: "" }] })}>
                    Add an ACP agent
                  </button>
                </div>
              </div>
            </section>

            <section className="form-section" id="settings-panel-desktop" role="tabpanel" aria-labelledby="settings-desktop" hidden={current !== "desktop"}>
              <h3 id="settings-desktop">Desktop app</h3>
              <div className="form-card">
                <FormRow
                  row="background"
                  hidden={!shows("desktop", "background")}
                  label="Keep running in the background"
                  desc="Closing the window hides it to the tray, so finished runs and approvals still notify you. Quit from the tray or with Ctrl+Q. Off: closing the window quits the app."
                  toggle
                >
                  <Switch label="Keep running in the background" checked={draft.desktopBackground} disabled={!editable} onChange={(desktopBackground) => update({ desktopBackground })} />
                </FormRow>
              </div>
            </section>

            <section className="form-section" id="settings-panel-network" role="tabpanel" aria-labelledby="settings-network" hidden={current !== "network"}>
              <h3 id="settings-network">Network and sign-in</h3>
              <p className="form-note">Takes effect when the server restarts.</p>
              <div className="form-card">
                <FormRow row="host" hidden={!shows("network", "host")} label="Listen on" desc={draft.host === "0.0.0.0" ? "Every network this machine is on (0.0.0.0); other devices sign in." : "This machine only (127.0.0.1): no sign-in needed here."}>
                  <Segmented<Draft["host"]>
                    label="Listen on"
                    value={draft.host}
                    disabled={field("host")}
                    options={[
                      { value: "127.0.0.1", label: "This machine", title: "127.0.0.1" },
                      { value: "0.0.0.0", label: "All networks", title: "0.0.0.0, with sign-in" },
                    ]}
                    onChange={(host) => update({ host })}
                  />
                </FormRow>
                <FormRow row="port" hidden={!shows("network", "port")} label="Port">
                  <input className="input settings-port" aria-label="Port" inputMode="numeric" disabled={field("port")} value={draft.port} onChange={(e) => update({ port: e.target.value.replace(/\D/g, "") })} />
                </FormRow>
                <FormRow row="username" hidden={!shows("network", "username")} label="Username" desc="For signing in from other devices.">
                  <input className="input" aria-label="Username" autoComplete="username" disabled={field("username")} value={draft.username} onChange={(e) => update({ username: e.target.value })} />
                </FormRow>
                <FormRow row="password" hidden={!shows("network", "password")} label="Password" desc={server?.values.hasPassword ? "Set. Type a new one to change it." : "Not set."}>
                  <input
                    className="input"
                    type="password"
                    aria-label="Password"
                    autoComplete="new-password"
                    disabled={field("hasPassword") || draft.removePassword}
                    placeholder={server?.values.hasPassword ? "••••••••" : "Not set"}
                    value={draft.password}
                    onChange={(e) => update({ password: e.target.value })}
                  />
                </FormRow>
                {server?.values.hasPassword && editable && !overridden("hasPassword") ? (
                  <FormRow row="remove-password" hidden={!shows("network", "remove-password")} label="Remove the password from config.yml" desc="Other devices can no longer sign in with it." toggle>
                    <Switch label="Remove the password from config.yml" checked={draft.removePassword} onChange={(removePassword) => update({ removePassword, password: "" })} />
                  </FormRow>
                ) : null}
              </div>
            </section>

            <section className="form-section" id="settings-panel-access" role="tabpanel" aria-labelledby="settings-access" hidden={current !== "access"}>
              <h3 id="settings-access">Folders and access</h3>
              <p className="form-note">One per line. Takes effect when the server restarts.</p>
              <div className="form-card">
                <FormRow row="roots" hidden={!shows("access", "roots")} label="Workspace roots" desc="The folders projects may be opened in." stack>
                  <textarea
                    className="input"
                    aria-label="Workspace roots"
                    rows={2}
                    disabled={field("workspaceRoots")}
                    placeholder="Your home folder"
                    value={draft.workspaceRoots}
                    onChange={(e) => update({ workspaceRoots: e.target.value })}
                  />
                </FormRow>
                <FormRow row="hosts" hidden={!shows("access", "hosts")} label="Allowed hosts" desc="Names this server answers to besides localhost." stack>
                  <textarea
                    className="input"
                    aria-label="Allowed hosts"
                    rows={2}
                    disabled={field("allowedHosts")}
                    placeholder="e.g. machine.tailnet.ts.net"
                    value={draft.allowedHosts}
                    onChange={(e) => update({ allowedHosts: e.target.value })}
                  />
                </FormRow>
                <FormRow row="tailscale" hidden={!shows("access", "tailscale")} label="Allowed Tailscale users" desc="Empty lets anyone on the tailnet who signs in." stack>
                  <textarea
                    className="input"
                    aria-label="Allowed Tailscale users"
                    rows={2}
                    disabled={field("allowedTailscaleUsers")}
                    placeholder="one login per line"
                    value={draft.allowedTailscaleUsers}
                    onChange={(e) => update({ allowedTailscaleUsers: e.target.value })}
                  />
                </FormRow>
              </div>
              {server && server.envOverrides.length > 0 ? (
                <p className="form-note">Set by the environment, so config.yml cannot change: {server.envOverrides.join(", ")}.</p>
              ) : null}
            </section>

            <InvitationsPanel current={current} />
          </form>
        )}

        {awui ? (
          <section className="form-section" id="settings-panel-awui" role="tabpanel" aria-labelledby="settings-awui" hidden={current !== "awui"}>
            <h3 id="settings-awui">Awui harness</h3>
            <p className="form-note">The providers the read-only Awui chat can call, kept in its own agent folder.</p>
            <div className="form-card">
              <FormRow
                row="share"
                hidden={!shows("awui", "share")}
                label="Share Pi's login"
                desc={
                  awui.piLogin
                    ? "Use what your terminal pi is logged into. Pi's providers are copied in when you turn it on; ones you set here stay as they are."
                    : "No pi login found (~/.pi/agent/auth.json): log into pi first to share it."
                }
                toggle
              >
                <Switch label="Share Pi's login" checked={awui.shareAuth} disabled={!awui.piLogin || awui.busy} onChange={(shareAuth) => setAwui({ ...awui, saved: false, shareAuth })} />
              </FormRow>
              <div className="form-row is-stack" data-settings-row="providers" hidden={!shows("awui", "providers")}>
                <span className="form-row-text">
                  <span className="form-label">Providers</span>
                  <span className="form-desc">Leave a key blank to keep the stored one; type - to clear it.</span>
                </span>
                {awui.rows.length > 0 ? (
                  <div className="awui-providers">
                    {awui.rows.map((r, i) => (
                      <div className="awui-provider" key={i}>
                        <input className="input" aria-label="Provider name" placeholder="name (e.g. litellm)" value={r.name} onChange={(e) => setAwuiRow(i, { name: e.target.value })} />
                        <input className="input" aria-label="Base URL" placeholder="http://host:8085/v1" value={r.baseUrl} onChange={(e) => setAwuiRow(i, { baseUrl: e.target.value })} />
                        <input className="input" aria-label="API kind" placeholder="openai-completions" value={r.api} onChange={(e) => setAwuiRow(i, { api: e.target.value })} />
                        <input className="input" type="password" aria-label="API key" autoComplete="new-password" placeholder={r.hadKey ? "Set (type to change)" : "No key"} value={r.apiKey} onChange={(e) => setAwuiRow(i, { apiKey: e.target.value })} />
                        <button type="button" className="ghost-icon" aria-label={`Remove ${r.name || "provider"}`} title="Remove provider" onClick={() => setAwui({ ...awui, saved: false, rows: awui.rows.filter((_, j) => j !== i) })}>
                          <IconX size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="form-empty">None yet{awui.shareAuth ? "" : ": add one, or share Pi's login above"}.</p>
                )}
              </div>
            </div>
            {awui.error ? (
              <p className="notice notice-error" role="alert">
                {awui.error}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>

      {/* The bar under both panes: what the form's state says, and the one Save for the section that is open. */}
      <div className="settings-bar">
        {draft && error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        {server && server.restartPending.length > 0 ? (
          <div className="settings-restart" role="status">
            <span>Saved; takes effect after a restart: {pendingText}.</span>
            {server.canRestart && server.editable ? (
              <button type="button" className="btn btn-small" disabled={restarting} onClick={() => void restart()}>
                {restarting ? "Restarting…" : "Restart server"}
              </button>
            ) : (
              <span className="muted">Restart the server to apply.</span>
            )}
          </div>
        ) : null}
        <div className="settings-bar-row">
          <span className="settings-version">awui v{version}</span>
          {current === "invites" ? null : current === "awui" && awui ? (
            <>
              <span className="settings-foot-state" role="status">
                {awui.busy ? "Saving…" : awui.saved ? "Saved." : ""}
              </span>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setAwui({ ...awui, saved: false, rows: [...awui.rows, { name: "", baseUrl: "", api: "openai-completions", apiKey: "", hadKey: false }] })}>
                <IconPlus size={13} /> Add provider
              </button>
              <button type="button" className="btn btn-small btn-primary" disabled={awui.busy} onClick={() => void saveAwui()}>
                {awui.busy ? "Saving…" : "Save"}
              </button>
            </>
          ) : editable ? (
            <>
              <span className={`settings-foot-state${dirty ? " is-dirty" : ""}`} role="status">
                {saving ? "Saving…" : dirty ? "Unsaved changes" : saved ? "Saved." : ""}
              </span>
              <button type="button" className="btn btn-small btn-ghost" disabled={!dirty || saving} onClick={() => server && setDraft(draftOf(server.values))}>
                Discard
              </button>
              <button type="submit" form="settings-form" className="btn btn-small btn-primary" disabled={!dirty || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

const WIDTH_NOTE: Record<ChatWidth, string> = {
  comfortable: "A 960px column, easy to read.",
  wide: "A 1400px column, for wide code and tables.",
  full: "The whole pane, edge to edge.",
};
