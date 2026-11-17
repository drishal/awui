// Settings → Appearance → Schemes: every base16 scheme as a card with its
// swatch (theme.yml, then the library in ~/.config/awui/themes), chosen into
// the form like the rest of Settings and saved with its one Save. Adding,
// editing, and removing a theme act on its file at once, since a file is not a
// form field: Upload takes a .yml, New and Edit open the editor, Duplicate makes
// an editable copy (of theme.yml or a home-manager link too), Export downloads
// the file, and Delete offers Undo, which puts the same file back under the
// same id. The theme in use cannot be deleted; another one is chosen first.
import { useRef, useState } from "react";
import type { ThemeEntry, ThemeList } from "../../shared/protocol.js";
import { schemeToYaml, type Scheme } from "../../shared/theme-scheme.js";
import { api, errorText } from "../api.js";
import { downloadText } from "../export.js";
import { IconCopy, IconDownload, IconEdit, IconPlus, IconUndo, IconX } from "../icons.js";
import { schemeKey, themeFileName, type ThemeOption } from "../themes.js";
import { STARTER, ThemeEditor } from "./ThemeEditor.js";
import { ThemeSwatch } from "./ThemeSwatch.js";

/** An uploaded file is read only this far; the server refuses past 64 KB anyway. */
const MAX_UPLOAD = 64 * 1024;

type Editing = { title: string; initial: Scheme; save: (scheme: Scheme) => Promise<void> };

const schemeOf = (entry: ThemeEntry, name = entry.name): Scheme => ({ name, polarity: entry.polarity, palette: entry.palette, fonts: entry.fonts });
const body = (scheme: Scheme) => ({ name: scheme.name, variant: scheme.polarity, palette: scheme.palette, ...(scheme.fonts.sans || scheme.fonts.mono ? { fonts: scheme.fonts } : {}) });

export function ThemeLibrary({
  list,
  refresh,
  chosen,
  editable,
  onChoose,
  onChanged,
}: {
  list: ThemeList | null;
  refresh: () => Promise<ThemeList | null>;
  /** The form's pick: `scheme:<id>` (`scheme:` for theme.yml), or a built-in's key. */
  chosen: string;
  /** This device may change settings (and so the library). */
  editable: boolean;
  onChoose: (themeScheme: string | null) => void;
  /** A theme's file changed: the page re-reads the active scheme in case it was this one. */
  onChanged: (id: string) => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ id: string; name: string; yaml: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const canWrite = editable && Boolean(list?.writable);
  const themes = list?.themes ?? [];
  const full = list ? themes.filter((t) => t.id !== null).length >= list.max : false;

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const created = async (made: ThemeEntry, verb: string) => {
    await refresh();
    setRemoved(null);
    setNotice(`${verb} “${made.name}”.`);
  };
  const createFrom = (scheme: Scheme, verb: string) => async () => {
    const made = await api<ThemeEntry>("/api/themes", { body: body(scheme) });
    setEditing(null);
    await created(made, verb);
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void act(async () => {
      if (file.size > MAX_UPLOAD) throw new Error("A theme file is at most 64 KB");
      const made = await api<ThemeEntry>("/api/themes", { body: { yaml: await file.text() } });
      await created(made, "Added");
    });
  };

  const remove = (entry: ThemeEntry & { id: string }) =>
    void act(async () => {
      const gone = await api<{ id: string; yaml: string }>(`/api/themes/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      // The form may still hold the deleted pick: it goes back to theme.yml rather than save a missing id.
      if (chosen === schemeKey(entry.id)) onChoose(null);
      setRemoved({ ...gone, name: entry.name });
      await refresh();
    });
  const undo = () =>
    void act(async () => {
      if (!removed) return;
      await api<ThemeEntry>("/api/themes", { body: { yaml: removed.yaml, id: removed.id } });
      setRemoved(null);
      await refresh();
    });

  const exportTheme = (entry: ThemeEntry) =>
    void act(async () => {
      // theme.yml is not in the library: its colours are written out the same way the library writes a file.
      if (entry.id === null) {
        downloadText(themeFileName(entry), schemeToYaml(schemeOf(entry)), "text/yaml");
        return;
      }
      const res = await fetch(`/api/themes/${encodeURIComponent(entry.id)}/file`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      downloadText(themeFileName(entry), await res.text(), "text/yaml");
    });

  return (
    <div className="theme-library">
      {themes.length === 0 ? <p className="form-empty">No schemes yet. Upload a base16 or base24 .yml, or make one.</p> : null}
      <div className="theme-cards" role="radiogroup" aria-label="Schemes">
        {themes.map((entry) => {
          const key = schemeKey(entry.id);
          const option: ThemeOption = { key, label: entry.name, theme: "base16", themeScheme: entry.id, entry };
          const inUse = list?.selected === entry.id && entry.id !== null;
          const label = entry.id === null ? `${entry.name} (theme.yml)` : entry.name;
          return (
            <div key={key} className={`theme-card${chosen === key ? " is-chosen" : ""}${entry.problem ? " is-broken" : ""}`}>
              <button type="button" role="radio" aria-checked={chosen === key} aria-label={label} className="theme-card-pick" disabled={!editable || Boolean(entry.problem)} title={entry.problem} onClick={() => onChoose(entry.id)}>
                {entry.problem ? <span className="theme-swatch is-md is-broken" aria-hidden="true" /> : <ThemeSwatch option={option} />}
                <span className="theme-card-name">{entry.name}</span>
                <span className="theme-card-note">{entry.problem ? "Cannot be used" : entry.id === null ? "theme.yml" : entry.readOnly ? `${entry.polarity} · read-only` : entry.polarity}</span>
              </button>
              <span className="theme-card-actions">
                {!entry.readOnly && entry.id !== null && !entry.problem ? (
                  <button
                    type="button"
                    className="ghost-icon"
                    aria-label={`Edit ${entry.name}`}
                    title="Edit"
                    disabled={!canWrite || busy}
                    onClick={() => {
                      const id = entry.id as string;
                      setEditing({
                        title: `Edit ${entry.name}`,
                        initial: schemeOf(entry),
                        save: async (scheme) => {
                          await api<ThemeEntry>(`/api/themes/${encodeURIComponent(id)}`, { method: "PUT", body: body(scheme) });
                          setEditing(null);
                          await refresh();
                          onChanged(id);
                        },
                      });
                    }}
                  >
                    <IconEdit size={14} />
                  </button>
                ) : null}
                {!entry.problem ? (
                  <button
                    type="button"
                    className="ghost-icon"
                    aria-label={`Duplicate ${entry.name}`}
                    title="Duplicate"
                    disabled={!canWrite || busy || full}
                    onClick={() => setEditing({ title: `Copy of ${entry.name}`, initial: schemeOf(entry, `${entry.name} copy`), save: (scheme) => createFrom(scheme, "Made")() })}
                  >
                    <IconCopy size={14} />
                  </button>
                ) : null}
                {!entry.problem ? (
                  <button type="button" className="ghost-icon" aria-label={`Export ${entry.name}`} title="Export .yml" disabled={busy} onClick={() => exportTheme(entry)}>
                    <IconDownload size={14} />
                  </button>
                ) : null}
                {!entry.readOnly && entry.id !== null ? (
                  <button
                    type="button"
                    className="ghost-icon"
                    aria-label={`Delete ${entry.name}`}
                    title={inUse ? "In use: choose another theme and save first" : "Delete"}
                    disabled={!canWrite || busy || inUse}
                    onClick={() => remove(entry as ThemeEntry & { id: string })}
                  >
                    <IconX size={14} />
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      <div className="theme-library-bar">
        <button type="button" className="btn btn-small" disabled={!canWrite || busy || full} onClick={() => upload.current?.click()}>
          Upload .yml
        </button>
        <input ref={upload} type="file" accept=".yml,.yaml,text/yaml,application/x-yaml" hidden aria-label="Theme file" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" className="btn btn-small" disabled={!canWrite || busy || full} onClick={() => setEditing({ title: "New theme", initial: STARTER, save: (scheme) => createFrom(scheme, "Made")() })}>
          <IconPlus size={14} /> New theme
        </button>
        {removed ? (
          <span className="theme-library-undo" role="status">
            Deleted “{removed.name}”.
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={undo}>
              <IconUndo size={14} /> Undo
            </button>
          </span>
        ) : notice ? (
          <span className="theme-library-undo" role="status">
            {notice}
          </span>
        ) : null}
      </div>
      {list && !list.writable ? <p className="form-note">This server has no config folder, so it keeps no themes.</p> : null}
      {full ? <p className="form-note">The library holds at most {list?.max} themes: delete one to add another.</p> : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {editing ? <ThemeEditor title={editing.title} initial={editing.initial} onSave={editing.save} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
