// What atui changes in Markdown before OpenTUI draws it: task-list boxes as
// ☐/☑ (the terminal has no checkbox), outside code, and the language a path's
// extension names, for highlighting a diff's lines.

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * The words a find landed on, wrapped in `~~` (the Markdown renderer takes no inline marks, so the landed turn draws its struck runs on a warn-tinted ground,
 * syntaxFor's `found` mode, as the web marks them; real bold in the answer stays plain bold, never mistaken for a match): every case-insensitive occurrence of `query`
 * outside fenced code and inline code spans, also inside bold.
 */
export function markMatches(markdown: string, query: string): string {
  const q = query.trim();
  if (q.length === 0) return markdown;
  const needle = q.toLowerCase();
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const f = FENCE.exec(line)?.[1];
      if (f) {
        if (fence === null) fence = f[0] as string;
        else if (f[0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      // Inline code spans are kept whole; the text between them is where matches are set.
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) => {
          if (i % 2 === 1) return part;
          let out = "";
          let at = 0;
          for (let hit = part.toLowerCase().indexOf(needle); hit >= 0; hit = part.toLowerCase().indexOf(needle, at)) {
            const end = hit + needle.length;
            out += part.slice(at, hit) + `~~${part.slice(hit, end)}~~`;
            at = end;
          }
          return out + part.slice(at);
        })
        .join("");
    })
    .join("\n");
}

/** `- [ ] x` → `- ☐ x`, `- [x] x` → `- ☑ x`; code blocks are left alone. */
export function taskBoxes(markdown: string): string {
  if (!markdown.includes("[")) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const f = FENCE.exec(line)?.[1];
      if (f) {
        if (fence === null) fence = f[0] as string;
        else if (f[0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](?=\s)/, (_, lead: string, mark: string) => `${lead}${mark === " " ? "☐" : "☑"}`);
    })
    .join("\n");
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  zig: "zig",
  sh: "bash",
  bash: "bash",
  css: "css",
  html: "html",
  nix: "nix",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  c: "c",
  h: "c",
  cpp: "cpp",
  java: "java",
  rb: "ruby",
  lua: "lua",
};

/** The tree-sitter language for a file, from its extension; undefined when unknown. */
export function filetypeOf(file: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  return ext ? LANGUAGES[ext] : undefined;
}
