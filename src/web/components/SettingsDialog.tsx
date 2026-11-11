// Settings: pairing and sign-out for this device, and the server's
// config.yml — including the theme and text size every device shares. The
// server section is editable from any signed-in device; a save is checked
// server-side the way startup checks the file (and refused if it would lock out
// the device making it), and what takes a restart says so, with a Restart
// button when systemd supervises.
import { useEffect, useState, type CSSProperties } from "react";
import type { Bootstrap, ChatWidth, Density, RestartSetting, ServerSettings, ServerSettingsValues, SettingsPatch, ThemeChoice, ToolStyle, UiFont } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";
import { FormRow } from "./FormRow.js";
import { Segmented } from "./Segmented.js";
import { Select } from "./Select.js";
import { Switch } from "./Switch.js";
import { TEXT_SCALES } from "./Sidebar.js";
import { IconPlus, IconRefresh, IconX } from "../icons.js";
import type { NotifyState } from "../notify.js";
import { chime, chimeOn, setChime } from "../attention.js";

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
};

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
  desktopBackground: boolean;
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
    desktopBackground: v.desktopBackground,
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
  if (d.desktopBackground !== v.desktopBackground) p.desktopBackground = d.desktopBackground;
  return p;
}

export function SettingsDialog({
  scheme,
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
  onPair: () => void;
  signedInAs: string | null;
  onSignOut: () => void;
  version: string;
  notify: NotifyState;
  onToggleNotify: () => Promise<void>;
  onTestNotify: () => Promise<void>;
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
  // The awui harness's own providers; null until loaded, false when the harness is off.
  const [awui, setAwui] = useState<AwuiSettingsState | null>(null);

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

  return (
    <Dialog title="Settings" onClose={onClose} className="dialog-wide settings-dialog">
      <section className="form-section" aria-labelledby="settings-device">
        <h3 id="settings-device">This device</h3>
        <div className="form-card">
          <FormRow label="Other devices" desc={signedInAs ? `Signed in as ${signedInAs}.` : "Open awui on a phone by scanning a code."}>
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
          <FormRow label="Sound" desc="A chime, in this browser, when a chat finishes out of sight or asks for an answer." toggle>
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
        <section className="form-section" aria-labelledby="settings-server">
          <h3 id="settings-server">Server</h3>
          {error ? (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="form-note">Loading…</p>
          )}
        </section>
      ) : (
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <section className="form-section" aria-labelledby="settings-look">
            <h3 id="settings-look">Appearance</h3>
            <p className="form-note">
              {server && !server.writable
                ? "This server runs without a settings folder, so there is nothing to save to."
                : server && !server.editable
                  ? "These live in config.yml on the machine running the server; change them there."
                  : "Saved to config.yml for every device: it applies here at once, and on other devices at their next page load (atui at its next start)."}
            </p>
            <div className="form-card">
              <FormRow label="Theme" desc={draft.theme === "base16" && scheme?.name ? `The ${scheme.name} scheme from theme.yml.` : "Follow the system, or pin light or dark."}>
                <Select label="Theme" value={draft.theme} disabled={!editable} options={themeOptions} onChange={(theme) => update({ theme: theme as ThemeChoice | "" })} />
              </FormRow>
              <FormRow label="Chat text size" desc="The conversation and the composer; menus keep their size.">
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
              <FormRow label="Chat width" desc={WIDTH_NOTE[draft.chatWidth]}>
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
              <FormRow label="Density" desc={draft.density === "compact" ? "Tighter rows and gaps, with a mouse (touch keeps the larger sizes)." : "Room to breathe between rows."}>
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
              <FormRow label="Font" desc={draft.font === "system" ? "This device's own system font, as other apps here use." : `${BUNDLED_FONT}, shipped with awui, so every device reads the same.`}>
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

          <section className="form-section" aria-labelledby="settings-layout">
            <h3 id="settings-layout">Layout</h3>
            <div className="form-card">
              <FormRow label="Fold the sidebar away in narrow windows" desc="It comes back as a drawer from the edge." toggle>
                <Switch label="Fold the sidebar away in narrow windows" checked={draft.autocollapseSidebar} disabled={!editable} onChange={(autocollapseSidebar) => update({ autocollapseSidebar })} />
              </FormRow>
              <FormRow label="Status bar" desc="Under the conversation: connection, harness, model, folder, version." toggle>
                <Switch label="Status bar" checked={draft.showStatusBar} disabled={!editable} onChange={(showStatusBar) => update({ showStatusBar })} />
              </FormRow>
              <FormRow label="Work with herdr" desc="Mark the sessions open in its panes, and let atui in a pane report its chats." toggle>
                <Switch label="Work with herdr" checked={draft.herdr} disabled={field("herdr")} onChange={(herdr) => update({ herdr })} />
              </FormRow>
            </div>
          </section>

          <section className="form-section" aria-labelledby="settings-desktop">
            <h3 id="settings-desktop">Desktop app</h3>
            <div className="form-card">
              <FormRow
                label="Keep running in the background"
                desc="Closing the window hides it to the tray, so finished runs and approvals still notify you. Quit from the tray or with Ctrl+Q. Off: closing the window quits the app."
                toggle
              >
                <Switch label="Keep running in the background" checked={draft.desktopBackground} disabled={!editable} onChange={(desktopBackground) => update({ desktopBackground })} />
              </FormRow>
            </div>
          </section>

          <section className="form-section" aria-labelledby="settings-network">
            <h3 id="settings-network">Network and sign-in</h3>
            <p className="form-note">Takes effect when the server restarts.</p>
            <div className="form-card">
              <FormRow label="Listen on" desc={draft.host === "0.0.0.0" ? "Every network this machine is on (0.0.0.0); other devices sign in." : "This machine only (127.0.0.1): no sign-in needed here."}>
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
              <FormRow label="Port">
                <input className="input settings-port" aria-label="Port" inputMode="numeric" disabled={field("port")} value={draft.port} onChange={(e) => update({ port: e.target.value.replace(/\D/g, "") })} />
              </FormRow>
              <FormRow label="Username" desc="For signing in from other devices.">
                <input className="input" aria-label="Username" autoComplete="username" disabled={field("username")} value={draft.username} onChange={(e) => update({ username: e.target.value })} />
              </FormRow>
              <FormRow label="Password" desc={server?.values.hasPassword ? "Set. Type a new one to change it." : "Not set."}>
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
                <FormRow label="Remove the password from config.yml" desc="Other devices can no longer sign in with it." toggle>
                  <Switch label="Remove the password from config.yml" checked={draft.removePassword} onChange={(removePassword) => update({ removePassword, password: "" })} />
                </FormRow>
              ) : null}
            </div>
          </section>

          <section className="form-section" aria-labelledby="settings-access">
            <h3 id="settings-access">Folders and access</h3>
            <p className="form-note">One per line. Takes effect when the server restarts.</p>
            <div className="form-card">
              <FormRow label="Workspace roots" desc="The folders projects may be opened in." stack>
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
              <FormRow label="Allowed hosts" desc="Names this server answers to besides localhost." stack>
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
              <FormRow label="Allowed Tailscale users" desc="Empty lets anyone on the tailnet who signs in." stack>
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

          {error ? (
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
          {editable ? (
            <div className={`settings-foot${dirty ? " is-dirty" : ""}`}>
              <span className="settings-foot-state" role="status">
                {saving ? "Saving…" : dirty ? "Unsaved changes" : saved ? "Saved." : ""}
              </span>
              <button type="button" className="btn btn-small btn-ghost" disabled={!dirty || saving} onClick={() => server && setDraft(draftOf(server.values))}>
                Discard
              </button>
              <button type="submit" className="btn btn-small btn-primary" disabled={!dirty || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          ) : null}
        </form>
      )}

      {awui ? (
        <section className="form-section" aria-labelledby="settings-awui">
          <h3 id="settings-awui">Awui harness</h3>
          <p className="form-note">The providers the read-only Awui chat can call, kept in its own agent folder.</p>
          <div className="form-card">
            <FormRow
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
            <div className="form-row is-stack">
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
          <div className="settings-foot">
            <span className="settings-foot-state" role="status">
              {awui.busy ? "Saving…" : awui.saved ? "Saved." : ""}
            </span>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setAwui({ ...awui, saved: false, rows: [...awui.rows, { name: "", baseUrl: "", api: "openai-completions", apiKey: "", hadKey: false }] })}>
              <IconPlus size={13} /> Add provider
            </button>
            <button type="button" className="btn btn-small btn-primary" disabled={awui.busy} onClick={() => void saveAwui()}>
              {awui.busy ? "Saving…" : "Save"}
            </button>
          </div>
        </section>
      ) : null}
      <p className="settings-version">awui v{version}</p>
    </Dialog>
  );
}

const WIDTH_NOTE: Record<ChatWidth, string> = {
  comfortable: "A 960px column, easy to read.",
  wide: "A 1400px column, for wide code and tables.",
  full: "The whole pane, edge to edge.",
};
