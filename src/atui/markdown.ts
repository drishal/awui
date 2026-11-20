// What atui changes in Markdown before OpenTUI draws it: task-list boxes as
// ☐/☑ (the terminal has no checkbox), outside code, and the language a path's
// extension names, for highlighting a diff's lines.

const FENCE = /^\s*(`{3,}|~{3,})/;

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
