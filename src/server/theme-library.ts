// The theme library: base16 / base24 schemes kept one per file in
// ~/.config/awui/themes/<id>.yml, beside config.yml, so they are the user's own
// settings (shared by every device, kept by a dotfiles repo) rather than state.
// config.yml's `theme_scheme: <id>` picks one; theme.yml stays what stylix or
// home-manager writes and is never touched from here.
//
// Every file is read the way theme.yml is (parseScheme: YAML failsafe, exact hex,
// 64 KB), and every write is checked the same way first, then written as the
// normalized tinted-theming YAML schemeToYaml makes: whatever an upload carried
// (comments, anchors, odd keys) never reaches the disk. A symlinked file is
// home-manager's: it is listed and usable but never rewritten or deleted. The id
// is the file name, slug-checked, so no request can name a path outside the folder.
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ThemeEntry } from "../shared/protocol.js";
import { cleanSchemeName, schemeToYaml, type Scheme } from "../shared/theme-scheme.js";
import { ChatError } from "./chats/chat.js";
import { MAX_THEME_BYTES, parseScheme, schemeInfo } from "./theme.js";

/** A library id: the file's name without `.yml`. */
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** At most this many themes are created from here; past it a create is refused (a dotfiles folder may hold more, read up to MAX_LISTED). */
export const MAX_THEMES = 100;
/** At most this many files are read for a listing, so a huge folder cannot stall a request. */
const MAX_LISTED = 200;
const FILE_NAME = /^([a-z0-9][a-z0-9-]{0,62})\.ya?ml$/;

/** A library entry as the server keeps it: the listing's entry plus the file it came from (never sent). */
export interface LibraryTheme extends ThemeEntry {
  id: string;
  scheme: Scheme | null;
}

interface Cached {
  key: string;
  theme: LibraryTheme;
}

/** A theme id made from its name: lower case, dashes between words, unique among `taken`. */
export function themeSlug(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56)
      .replace(/-+$/, "") || "theme";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export class ThemeLibrary {
  private cache = new Map<string, Cached>();

  /** `dir` null: no config folder (AWUI_CONFIG_DIR=""), so the library is empty and read-only. */
  constructor(
    readonly dir: string | null,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** Whether Upload and New can work: there is a folder to write into. */
  get writable(): boolean {
    return this.dir !== null;
  }

  /** The files in the folder by id (`.yml` wins over `.yaml` when both exist), at most MAX_LISTED. */
  private async files(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.dir) return out;
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).sort();
    } catch {
      return out;
    }
    for (const name of names) {
      const id = FILE_NAME.exec(name)?.[1];
      if (!id) continue;
      if (!out.has(id) || name.endsWith(".yml")) out.set(id, path.join(this.dir, name));
      if (out.size >= MAX_LISTED) break;
    }
    return out;
  }

  /** One file as an entry; cached by realpath, mtime, and size so a listing re-reads only what changed. */
  private async load(id: string, file: string): Promise<LibraryTheme | null> {
    let readOnly = false;
    let real: string;
    let key: string;
    try {
      const link = await fs.lstat(file);
      readOnly = link.isSymbolicLink();
      real = await fs.realpath(file);
      const stat = await fs.stat(real);
      if (!stat.isFile()) return null;
      key = `${real}:${stat.mtimeMs}:${stat.size}:${readOnly}`;
      if (this.cache.get(id)?.key === key) return (this.cache.get(id) as Cached).theme;
      if (stat.size > MAX_THEME_BYTES) return this.remember(id, key, this.broken(id, readOnly, "the file is larger than 64 KB"));
      if (!readOnly) readOnly = !(await fs.access(real, constants.W_OK).then(() => true, () => false));
    } catch {
      return null;
    }
    try {
      const scheme = parseScheme(await fs.readFile(real, "utf8"));
      const info = schemeInfo(scheme, this.log);
      return this.remember(id, key, { id, name: info.name ?? scheme.name, polarity: scheme.polarity, palette: scheme.palette, vars: info.vars, themeColor: info.themeColor, fonts: info.fonts, readOnly, scheme });
    } catch (error) {
      return this.remember(id, key, this.broken(id, readOnly, (error as Error).message));
    }
  }

  private broken(id: string, readOnly: boolean, problem: string): LibraryTheme {
    return { id, name: id, polarity: "dark", palette: {}, vars: {}, themeColor: null, fonts: {}, readOnly, problem, scheme: null };
  }

  private remember(id: string, key: string, theme: LibraryTheme): LibraryTheme {
    this.cache.set(id, { key, theme });
    return theme;
  }

  /** Every theme in the folder, by name; unreadable files are listed with their problem so they can be removed. */
  async list(): Promise<LibraryTheme[]> {
    const files = await this.files();
    for (const id of this.cache.keys()) if (!files.has(id)) this.cache.delete(id);
    const themes = await Promise.all([...files].map(([id, file]) => this.load(id, file)));
    return themes.filter((t): t is LibraryTheme => t !== null).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** One theme by id, or null when there is no such file. */
  async get(id: string): Promise<LibraryTheme | null> {
    if (!THEME_ID.test(id)) return null;
    const file = (await this.files()).get(id);
    return file ? this.load(id, file) : null;
  }

  /** The file's own text, for Export: bounded, and only for an id that is in the folder. */
  async read(id: string): Promise<{ name: string; text: string }> {
    const theme = await this.existing(id);
    if (theme.problem || !theme.scheme) throw new ChatError(422, "theme_unusable", `This theme cannot be used: ${theme.problem ?? "unreadable"}`);
    return { name: theme.name, text: schemeToYaml(theme.scheme) };
  }

  private async existing(id: string): Promise<LibraryTheme> {
    const theme = await this.get(id);
    if (!theme) throw new ChatError(404, "no_theme", `There is no theme "${id}" in the theme library`);
    return theme;
  }

  private folder(): string {
    if (!this.dir) throw new ChatError(409, "no_theme_folder", "This server has no config folder (AWUI_CONFIG_DIR is empty), so it keeps no themes");
    return this.dir;
  }

  /**
   * A new theme from an upload (`text`, parsed exactly as a file is) or the editor's scheme. `preferredId` asks
   * for that id (Undo after a delete puts the same file back) and fails when it is taken; otherwise the id comes
   * from the name, made unique.
   */
  async create(input: { text: string } | { scheme: Scheme }, preferredId?: string): Promise<LibraryTheme> {
    const dir = this.folder();
    const scheme = this.check(input);
    const files = await this.files();
    if (files.size >= MAX_THEMES) throw new ChatError(409, "too_many_themes", `The theme library holds at most ${MAX_THEMES} themes: remove one first`);
    if (preferredId !== undefined && !THEME_ID.test(preferredId)) throw new ChatError(400, "bad_theme_id", "A theme id is lower-case letters, digits, and dashes");
    if (preferredId !== undefined && files.has(preferredId)) throw new ChatError(409, "theme_exists", `There is already a theme "${preferredId}"`);
    const id = preferredId ?? themeSlug(scheme.name, new Set(files.keys()));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${id}.yml`);
    const tmp = path.join(dir, `.${id}.${randomBytes(4).toString("hex")}.tmp`);
    await fs.writeFile(tmp, schemeToYaml(scheme), { mode: 0o600, flag: "wx" });
    try {
      // link, not rename: it fails when the name was taken in between, so a create never replaces a file.
      await fs.link(tmp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ChatError(409, "theme_exists", `There is already a theme "${id}"`);
      throw error;
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    return this.existing(id);
  }

  /** The edited scheme over the same file (its id, and so config.yml's pick, stay). */
  async update(id: string, scheme: Scheme): Promise<LibraryTheme> {
    const dir = this.folder();
    const theme = await this.existing(id);
    if (theme.readOnly) throw new ChatError(409, "theme_read_only", "This theme's file is not writable here (home-manager links it): change it where it is made");
    const checked = this.check({ scheme });
    const target = (await this.files()).get(id) as string;
    const tmp = path.join(dir, `.${id}.${randomBytes(4).toString("hex")}.tmp`);
    await fs.writeFile(tmp, schemeToYaml(checked), { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, target).catch(async (error: unknown) => {
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    });
    return this.existing(id);
  }

  /** Remove a theme; answers the YAML it held, so the client's Undo can create it again under the same id. */
  async remove(id: string): Promise<{ id: string; yaml: string }> {
    const theme = await this.existing(id);
    if (theme.readOnly) throw new ChatError(409, "theme_read_only", "This theme's file is not writable here (home-manager links it): remove it where it is made");
    const file = (await this.files()).get(id) as string;
    const yaml = theme.scheme ? schemeToYaml(theme.scheme) : "";
    await fs.unlink(file);
    this.cache.delete(id);
    return { id, yaml };
  }

  /** The same check a file gets at startup: an editor's scheme goes through YAML and back, so both paths agree. */
  private check(input: { text: string } | { scheme: Scheme }): Scheme {
    try {
      if ("text" in input) {
        if (Buffer.byteLength(input.text) > MAX_THEME_BYTES) throw new ChatError(413, "theme_too_large", "A theme file is at most 64 KB");
        return parseScheme(input.text);
      }
      return parseScheme(schemeToYaml({ ...input.scheme, name: cleanSchemeName(input.scheme.name) || "Custom" }));
    } catch (error) {
      if (error instanceof ChatError) throw error;
      throw new ChatError(400, "bad_theme", `Not a base16 or base24 scheme: ${(error as Error).message}`);
    }
  }
}
