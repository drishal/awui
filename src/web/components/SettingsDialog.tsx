// Settings: pairing and sign-out for this device, and the server's
// config.yml — including the theme and text size every device shares. The
// server section is editable from any signed-in device; a save is checked
// server-side the way startup checks the file (and refused if it would lock out
// the device making it), and what takes a restart says so, with a Restart
// button when systemd supervises.
import { useEffect, useState, type CSSProperties } from "react";
import type { Bootstrap, ChatWidth, Density, RestartSetting, ServerSettings, ServerSettingsValues, SettingsPatch, ThemeChoice } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";
import { TEXT_SCALES } from "./Sidebar.js";
import { IconRefresh } from "../icons.js";
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
  autocollapseSidebar: boolean;
  showStatusBar: boolean;
  herdr: boolean;
}

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
    autocollapseSidebar: v.autocollapseSidebar,
    showStatusBar: v.showStatusBar,
    herdr: v.herdr,
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
  if (d.autocollapseSidebar !== v.autocollapseSidebar) p.autocollapseSidebar = d.autocollapseSidebar;
  if (d.showStatusBar !== v.showStatusBar) p.showStatusBar = d.showStatusBar;
  if (d.herdr !== v.herdr) p.herdr = d.herdr;
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
        patch.autocollapseSidebar !== undefined ||
        patch.showStatusBar !== undefined ||
        patch.herdr !== undefined
      ) {
        onUiSaved({
          theme: next.values.theme,
          textScale: next.values.textScale,
          chatWidth: next.values.chatWidth,
          density: next.values.density,
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

  return (
    <Dialog title="Settings" onClose={onClose} className="dialog-wide settings-dialog">
      <section className="settings-section" aria-labelledby="settings-device">
        <h3 id="settings-device">This device</h3>
        <div className="settings-row">
          <span className="settings-label">Other devices</span>
          <div className="settings-actions">
            <button type="button" className="btn btn-small" onClick={onPair}>
              Pair phone
            </button>
            {signedInAs ? (
              <button type="button" className="btn btn-small" onClick={onSignOut} title={`Signed in as ${signedInAs}`}>
                Sign out
              </button>
            ) : null}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">Notifications</span>
          <div className="settings-actions">
            {notifyOn ? (
              <button type="button" className="btn btn-small" disabled={notifyBusy} onClick={() => void notifyAction(onTestNotify)}>
                Send a test
              </button>
            ) : null}
            <button
              type="button"
              className={`btn btn-small${notifyOn ? "" : " btn-primary"}`}
              disabled={notifyBusy || notify.mode === "unsupported"}
              aria-pressed={notifyOn}
              onClick={() => void notifyAction(onToggleNotify)}
            >
              {notifyOn ? "Turn off" : "Turn on"}
            </button>
          </div>
        </div>
        <p className="settings-note" data-testid="notify-note">
          {notifyError ??
            `${NOTIFY_NOTE[notify.mode]}${notify.why === "insecure" ? " Push needs HTTPS (Tailscale Serve) or this machine." : notify.why === "no-push" ? " This browser has no push service." : ""}`}
        </p>
        <div className="settings-row">
          <span className="settings-label" id="settings-chime">
            Sound
          </span>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-small"
              aria-labelledby="settings-chime"
              aria-pressed={chimes}
              onClick={() => {
                setChime(!chimes);
                setChimes(!chimes);
                if (!chimes) chime();
              }}
            >
              {chimes ? "On" : "Off"}
            </button>
          </div>
        </div>
        <p className="settings-note">A chime, in this browser, when a chat finishes out of sight or asks for an answer.</p>
      </section>

      <section className="settings-section" aria-labelledby="settings-server">
        <h3 id="settings-server">Server</h3>
        <p className="settings-note">
          {server && !server.writable
            ? "This server runs without a settings folder, so there is nothing to save to."
            : server && !server.editable
              ? "These live in config.yml on the machine running the server; change them there."
              : "Saved to config.yml for every device. Theme, text size, chat width, sidebar, status bar, and herdr apply here at once and on other devices on their next page load (atui on its next start); the rest when the server restarts."}
        </p>
        {!draft ? (
          error ? null : <p className="settings-note">Loading…</p>
        ) : (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="settings-row">
              <span className="settings-label">Theme</span>
              <select className="select" aria-label="Theme" disabled={!editable} value={draft.theme} onChange={(e) => update({ theme: e.target.value as ThemeChoice | "" })}>
                <option value="">theme.yml if present, else system</option>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                {scheme ? (
                  <option value="base16" title={scheme.name ?? undefined}>
                    base16
                  </option>
                ) : (
                  <option value="base16">base16</option>
                )}
              </select>
            </label>
            <div className="settings-row settings-slider-row">
              <span className="settings-label" id="settings-text-size-label">
                Chat text size
              </span>
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
                <span className="text-slider-reset">
                  {draft.textScale !== 1 ? (
                    <button
                      type="button"
                      className="ghost-icon"
                      aria-label="Reset text size"
                      title="Reset to 100%"
                      disabled={!editable}
                      onClick={() => update({ textScale: 1 })}
                    >
                      <IconRefresh size={14} />
                    </button>
                  ) : null}
                </span>
                <output className="text-slider-value" aria-live="off">
                  {Math.round(draft.textScale * 100)}%
                </output>
              </div>
            </div>
            <label className="settings-row">
              <span className="settings-label">Chat width</span>
              <select className="select" aria-label="Chat width" disabled={!editable} value={draft.chatWidth} onChange={(e) => update({ chatWidth: e.target.value as ChatWidth })}>
                <option value="comfortable">Comfortable (960px)</option>
                <option value="wide">Wide (1400px)</option>
                <option value="full">Full: the whole pane</option>
              </select>
            </label>
            <label className="settings-row">
              <span className="settings-label">Density</span>
              <select className="select" aria-label="Density" disabled={!editable} value={draft.density} onChange={(e) => update({ density: e.target.value as Density })}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact: tighter rows and gaps</option>
              </select>
            </label>
            <label className="settings-row settings-check">
              <input type="checkbox" disabled={!editable} checked={draft.autocollapseSidebar} onChange={(e) => update({ autocollapseSidebar: e.target.checked })} />
              <span>Fold the sidebar away in narrow windows</span>
            </label>
            <label className="settings-row settings-check">
              <input type="checkbox" disabled={!editable} checked={draft.showStatusBar} onChange={(e) => update({ showStatusBar: e.target.checked })} />
              <span>Show the status bar under the conversation (connection, harness, model, folder, version)</span>
            </label>
            <label className="settings-row settings-check">
              <input type="checkbox" disabled={field("herdr")} checked={draft.herdr} onChange={(e) => update({ herdr: e.target.checked })} />
              <span>Work with herdr: mark the sessions open in its panes, and let atui in a pane report its chats</span>
            </label>
            <label className="settings-row">
              <span className="settings-label">Listen on</span>
              <select className="select" aria-label="Listen on" disabled={field("host")} value={draft.host} onChange={(e) => update({ host: e.target.value as Draft["host"] })}>
                <option value="127.0.0.1">This machine only (127.0.0.1)</option>
                <option value="0.0.0.0">All networks, with sign-in (0.0.0.0)</option>
              </select>
            </label>
            <label className="settings-row">
              <span className="settings-label">Port</span>
              <input className="input settings-port" aria-label="Port" inputMode="numeric" disabled={field("port")} value={draft.port} onChange={(e) => update({ port: e.target.value.replace(/\D/g, "") })} />
            </label>
            <label className="settings-row">
              <span className="settings-label">Username</span>
              <input className="input" aria-label="Username" autoComplete="username" disabled={field("username")} value={draft.username} onChange={(e) => update({ username: e.target.value })} />
            </label>
            <label className="settings-row">
              <span className="settings-label">Password</span>
              <input
                className="input"
                type="password"
                aria-label="Password"
                autoComplete="new-password"
                disabled={field("hasPassword") || draft.removePassword}
                placeholder={server?.values.hasPassword ? "Set (type to change)" : "Not set"}
                value={draft.password}
                onChange={(e) => update({ password: e.target.value })}
              />
            </label>
            {server?.values.hasPassword && editable && !overridden("hasPassword") ? (
              <label className="settings-row settings-check">
                <input type="checkbox" checked={draft.removePassword} onChange={(e) => update({ removePassword: e.target.checked, password: "" })} />
                <span>Remove the password from config.yml</span>
              </label>
            ) : null}
            <label className="settings-row settings-stack">
              <span className="settings-label">Workspace roots</span>
              <textarea
                className="input"
                aria-label="Workspace roots"
                rows={2}
                disabled={field("workspaceRoots")}
                placeholder="Your home folder (one folder per line)"
                value={draft.workspaceRoots}
                onChange={(e) => update({ workspaceRoots: e.target.value })}
              />
            </label>
            <label className="settings-row settings-stack">
              <span className="settings-label">Allowed hosts</span>
              <textarea
                className="input"
                aria-label="Allowed hosts"
                rows={2}
                disabled={field("allowedHosts")}
                placeholder="e.g. machine.tailnet.ts.net (one per line)"
                value={draft.allowedHosts}
                onChange={(e) => update({ allowedHosts: e.target.value })}
              />
            </label>
            <label className="settings-row settings-stack">
              <span className="settings-label">Allowed Tailscale users</span>
              <textarea
                className="input"
                aria-label="Allowed Tailscale users"
                rows={2}
                disabled={field("allowedTailscaleUsers")}
                placeholder="Anyone on the tailnet who signs in (one login per line)"
                value={draft.allowedTailscaleUsers}
                onChange={(e) => update({ allowedTailscaleUsers: e.target.value })}
              />
            </label>
            {server && server.envOverrides.length > 0 ? (
              <p className="settings-note">Set by the environment, so config.yml cannot change: {server.envOverrides.join(", ")}.</p>
            ) : null}
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
            ) : saved ? (
              <p className="settings-note" role="status">
                Saved.
              </p>
            ) : null}
            {editable ? (
              <div className="settings-foot">
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
        {!draft && error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {awui ? (
        <section className="settings-section" aria-labelledby="settings-awui">
          <h2 id="settings-awui">Awui harness</h2>
          <p className="settings-note">Providers the read-only Awui chat can call, in its own agent dir. Blank API key keeps the stored one; type `-` to clear it.</p>
          <label className="settings-row settings-check">
            <input
              type="checkbox"
              disabled={!awui.piLogin || awui.busy}
              checked={awui.shareAuth}
              onChange={() => setAwui({ ...awui, saved: false, shareAuth: !awui.shareAuth })}
            />
            <span>Share Pi's login — the Awui chat can use what your terminal pi is logged into, and Pi's providers are copied in when you turn it on</span>
          </label>
          {!awui.piLogin ? <p className="settings-note">No pi login found (~/.pi/agent/auth.json); log into pi first to share it.</p> : null}
          <div className="awui-providers">
            {awui.rows.map((r, i) => (
              <div className="awui-provider" key={i}>
                <input className="input" aria-label="Provider name" placeholder="name (e.g. litellm)" value={r.name} onChange={(e) => setAwui({ ...awui, saved: false, rows: awui.rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <input className="input" aria-label="Base URL" placeholder="http://host:8085/v1" value={r.baseUrl} onChange={(e) => setAwui({ ...awui, saved: false, rows: awui.rows.map((x, j) => (j === i ? { ...x, baseUrl: e.target.value } : x)) })} />
                <input className="input" aria-label="API kind" placeholder="openai-completions" value={r.api} onChange={(e) => setAwui({ ...awui, saved: false, rows: awui.rows.map((x, j) => (j === i ? { ...x, api: e.target.value } : x)) })} />
                <input className="input" type="password" aria-label="API key" autoComplete="new-password" placeholder={r.hadKey ? "Set (type to change)" : "None"} value={r.apiKey} onChange={(e) => setAwui({ ...awui, saved: false, rows: awui.rows.map((x, j) => (j === i ? { ...x, apiKey: e.target.value } : x)) })} />
                <button type="button" className="ghost-icon" aria-label={`Remove ${r.name || "provider"}`} title="Remove provider" onClick={() => setAwui({ ...awui, saved: false, rows: awui.rows.filter((_, j) => j !== i) })}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setAwui({ ...awui, saved: false, rows: [...awui.rows, { name: "", baseUrl: "", api: "openai-completions", apiKey: "", hadKey: false }] })}>
              Add provider
            </button>
            <button type="button" className="btn btn-small btn-primary" disabled={awui.busy} onClick={() => void saveAwui()}>
              {awui.busy ? "Saving…" : "Save"}
            </button>
          </div>
          {awui.error ? (
            <p className="notice notice-error" role="alert">
              {awui.error}
            </p>
          ) : awui.saved ? (
            <p className="settings-note" role="status">
              Saved.
            </p>
          ) : null}
        </section>
      ) : null}
      <p className="settings-version">awui v{version}</p>
    </Dialog>
  );
}
