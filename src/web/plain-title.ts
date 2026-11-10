// A chat's title as plain words. Harnesses name a session after its first prompt, Markdown
// and all, and a tab, a sidebar row, or the chat's heading that shows `**bold**` or a
// backticked span reads as noise. Display only: the title itself (rename, search, export,
// accessible names a test or a screen reader already knows) keeps its characters. Pure.

/** The title with inline Markdown markers taken out (emphasis, code, strikes, links, a leading heading/list/quote marker); the original when nothing would be left. */
export function plainTitle(title: string): string {
  const plain = title
    // A link or image keeps its words: [text](url) → text.
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1")
    // Code spans: `x`, ``x``.
    .replace(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (_, _ticks: string, body: string) => body.trim())
    // Strong, then emphasis with *, then strikes. Underscores are left alone: snake_case is common in prompts.
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, "$1$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    // A leading heading, quote, or list marker.
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d{1,3}[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain || title;
}
