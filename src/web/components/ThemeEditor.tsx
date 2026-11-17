// Make or change a base16 scheme: a name, dark or light, and the sixteen
// colours, each by picker or by hex. The preview beside them is built with the
// server's own colour roles (shared/theme-scheme.ts), so it shows exactly what
// the saved theme will look like, including the roles the contrast check had
// to raise, which it names. A base24 scheme's extra brights are kept as they
// are. Saving goes to the server, which checks the scheme again.
import { useId, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { BASE16_KEYS, buildThemeVars, polarityOf, type Scheme } from "../../shared/theme-scheme.js";
import { errorText } from "../api.js";
import { Dialog } from "./Dialog.js";
import { Segmented } from "./Segmented.js";

/** What each slot is for, in base16's own terms. */
const ROLE: Record<string, string> = {
  base00: "Background",
  base01: "Panels",
  base02: "Selection",
  base03: "Comments, borders",
  base04: "Secondary text",
  base05: "Text",
  base06: "Light text",
  base07: "Brightest",
  base08: "Red: errors",
  base09: "Orange",
  base0A: "Yellow: warnings",
  base0B: "Green: success",
  base0C: "Cyan: info",
  base0D: "Blue: accent, links",
  base0E: "Purple: thinking",
  base0F: "Brown",
};

/** A new theme starts from base16's own Default Dark. */
export const STARTER: Scheme = {
  name: "My theme",
  polarity: "dark",
  palette: Object.fromEntries(
    ["181818", "282828", "383838", "585858", "b8b8b8", "d8d8d8", "e8e8e8", "f8f8f8", "ab4642", "dc9656", "f7ca88", "a1b56c", "86c1b9", "7cafc2", "ba8baf", "a16946"].map((hex, i) => [BASE16_KEYS[i] as string, `#${hex}`]),
  ),
  fonts: {},
};

const HEX = /^#?([0-9a-fA-F]{6})$/;
const WORDS: Record<string, string> = { "text-2": "secondary text", "muted-text": "muted text", "control-border": "control borders", accent: "the accent", link: "links", text: "text" };

export function ThemeEditor({ title, initial, onSave, onClose }: { title: string; initial: Scheme; onSave: (scheme: Scheme) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial.name);
  const [polarity, setPolarity] = useState(initial.polarity);
  const [palette, setPalette] = useState<Record<string, string>>(initial.palette);
  /** What each hex field shows while typed: it becomes the colour once it is a whole hex. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const scheme: Scheme = { name: name.trim() || "Custom", polarity, palette, fonts: initial.fonts };
  const { vars, adjusted } = useMemo(() => buildThemeVars(scheme), [polarity, palette]);
  const bg = palette.base00 ?? "#000000";
  const mismatch = polarityOf(bg) !== polarity;

  const setColor = (key: string, value: string) => {
    const match = HEX.exec(value.trim());
    setTyped((t) => ({ ...t, [key]: value }));
    if (match?.[1]) setPalette((p) => ({ ...p, [key]: `#${match[1]?.toLowerCase()}` }));
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(scheme);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  // Portaled to <body>: opened from Settings, it would otherwise sit inside that dialog and take its section styles.
  return createPortal(
    <Dialog title={title} onClose={onClose} className="theme-editor">
      <div className="theme-editor-grid">
        <div className="theme-editor-fields">
          <div className="theme-editor-head">
            <label className="theme-editor-name" htmlFor={nameId}>
              <span>Name</span>
              <input id={nameId} className="input" type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </label>
            <Segmented label="Variant" value={polarity} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} onChange={setPolarity} />
          </div>
          <div className="theme-colors" role="group" aria-label="Colours">
            {BASE16_KEYS.map((key) => {
              const value = palette[key] ?? "#000000";
              const text = typed[key] ?? value;
              const bad = !HEX.test(text.trim());
              return (
                <div key={key} className="theme-color">
                  <input type="color" aria-label={`${key} colour`} value={value} onChange={(e) => setColor(key, e.target.value)} />
                  <span className="theme-color-text">
                    <span className="theme-color-key">{key}</span>
                    <span className="theme-color-role">{ROLE[key]}</span>
                  </span>
                  <input
                    type="text"
                    className="input theme-color-hex"
                    aria-label={`${key} hex`}
                    aria-invalid={bad || undefined}
                    spellCheck={false}
                    value={text}
                    maxLength={7}
                    onChange={(e) => setColor(key, e.target.value)}
                    onBlur={() => setTyped((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== key)))}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div className="theme-editor-side">
          {/* The preview takes the variables the saved theme will have, on its own box only. */}
          <div className="theme-preview" style={vars as CSSProperties} aria-label="Preview" role="img">
            <div className="tp-side">
              <span className="tp-brand">awui</span>
              <span className="tp-row is-on">Fix the build</span>
              <span className="tp-row">Review the PR</span>
              <span className="tp-row">Release notes</span>
            </div>
            <div className="tp-main">
              <span className="tp-prompt">Why does the test fail?</span>
              <span className="tp-text">The fixture still uses the old port.</span>
              <span className="tp-muted">Read tests/app.test.ts · 12 lines</span>
              <span className="tp-chips">
                <span className="tp-chip is-ok">passed</span>
                <span className="tp-chip is-warn">1 warning</span>
                <span className="tp-chip is-danger">1 failed</span>
              </span>
              <span className="tp-link">tests/app.test.ts</span>
              <span className="tp-composer">
                <span>Ask anything</span>
                <span className="tp-send" />
              </span>
            </div>
          </div>
          {adjusted.length > 0 ? <p className="theme-editor-note">Contrast is raised for {adjusted.map((r) => WORDS[r] ?? r).join(", ")}, so every text stays readable.</p> : null}
          {mismatch ? <p className="theme-editor-note">The background reads as {polarity === "dark" ? "light" : "dark"}, but the variant says {polarity}: buttons and the page's light/dark details follow the variant.</p> : null}
          {error ? (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="theme-editor-actions">
            <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-small btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
              {busy ? "Saving…" : "Save theme"}
            </button>
          </div>
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
