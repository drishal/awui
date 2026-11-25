// Answers and prompts as Markdown (GitHub-flavoured), rendered safely: raw
// HTML is shown as the text it is — nothing here parses it into elements —
// links are http(s)/mailto only and open in a new tab, and remote images never
// load (their alt text and URL show instead). Code blocks get a header (language,
// Wrap, Copy), and Run on a one-line shell block in a finished answer; a mermaid
// fence is drawn as a diagram instead (MermaidDiagram.tsx).
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import { isMermaidFence } from "../mermaid.js";
import { CodeBlock } from "./CodeBlock.js";
import { MermaidDiagram } from "./MermaidDiagram.js";

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// GFM allows a single tilde to strike (`singleTilde`), but prose uses "~" for
// "about": "~5% and ~10%" paired two of them and struck the text between.
// Two tildes still strike; one reads as the approximation it was written as.
const REMARK: PluggableList = [[remarkGfm, { singleTilde: false }]];

/** Allow only http, https, and mailto links; everything else becomes inert. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://invalid.local/");
    if (parsed.origin === "https://invalid.local") return "";
    return SAFE_SCHEMES.has(parsed.protocol) ? url : "";
  } catch {
    return "";
  }
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Remote images are off: show the alt text and the URL instead of loading it.
  img: ({ alt, src }) => (
    <span className="md-image" title={typeof src === "string" ? src : undefined}>
      [image{alt ? `: ${alt}` : ""}]
    </span>
  ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

interface Hast {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: Hast[];
}

const hastText = (node: Hast | undefined): string => (node ? (node.value ?? "") + (node.children ?? []).map(hastText).join("") : "");

/** Code blocks with a header, and Run on one-line shell blocks when `allowRun` (a finished answer); `streaming` holds back their colours and numbers. */
function withCode(allowRun: boolean, streaming: boolean): Components {
  return {
    ...components,
    pre: ({ node, children }) => {
      const code = (node as Hast | undefined)?.children?.find((c) => c.tagName === "code");
      const classes = Array.isArray(code?.properties?.className) ? (code.properties.className as string[]) : [];
      const lang = classes.find((c) => c.startsWith("language-"))?.slice(9) ?? null;
      // A mermaid fence is drawn (src/web/mermaid.ts lazy-loads Pele); every other block stays text.
      if (isMermaidFence(lang)) return <MermaidDiagram code={hastText(code)} streaming={streaming} />;
      return (
        <CodeBlock lang={lang} code={hastText(code)} allowRun={allowRun} streaming={streaming}>
          {children}
        </CodeBlock>
      );
    },
  };
}

function MarkdownImpl({ text, allowRun = false, streaming = false }: { text: string; allowRun?: boolean; streaming?: boolean }) {
  const parts = useMemo(() => withCode(allowRun, streaming), [allowRun, streaming]);
  return (
    <div className="md">
      {/* No rehype-raw: without it react-markdown has no path from markdown to
          elements, so an agent's `<details>` or `<script>` comes out escaped
          rather than being dropped (an answer quoting a tag used to lose it). */}
      <ReactMarkdown remarkPlugins={REMARK} skipHtml={false} urlTransform={safeUrl} components={parts}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
