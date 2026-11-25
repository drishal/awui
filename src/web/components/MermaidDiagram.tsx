// A ```mermaid fence in an answer, drawn by Pele into a canvas of its own (see
// src/web/mermaid.ts for the policy and the lazy load). Pele is mounted, not
// rendered to a string, because mount measures the column and redraws when it
// narrows — a phone, or the side pane opening. Three things are awui's and not
// Pele's:
//  - the page's CSP is style-src 'self', which refuses the style attributes the
//    browser parses out of the SVG, so they are taken out of the markup and set
//    again through the CSSOM, which the policy allows (the SVG keeps its own
//    layout and colours that way);
//  - Pele reports a parse error by dimming the diagram it kept and printing its
//    own line inside the canvas; a streamed answer is half-written most of the
//    time, so the diagram stays at full strength and the source plus a quiet
//    note under the card say what happened, once the answer has settled;
//  - while the answer streams the text is redrawn at most every 70 ms, so a
//    token-by-token reply does not re-parse the diagram on every chunk.
import { useEffect, useRef, useState } from "react";
import type { MountOptions, Mounted } from "pele/lazy";
import { IconCopy } from "../icons.js";
import { loadPele, mermaidNote, mermaidOptions, nextMermaidId, rejectedMermaid, rejectionOf, takeStyles, type DiagramRejection } from "../mermaid.js";
import { CopyButton } from "./CopyButton.js";

/** The least time between two redraws while the answer streams. */
const REDRAW_MS = 70;

/** Pele's SVG as a node the page may keep: its style declarations are refused when parsed, and set through the CSSOM instead. */
function adoptSvg(markup: string): Node {
  const { markup: plain, styles } = takeStyles(markup);
  const root = document.importNode(new DOMParser().parseFromString(plain, "image/svg+xml").documentElement, true);
  if (root.localName !== "svg") throw new Error("The diagram did not come back as an SVG");
  // The emptied attributes mark the elements the declarations belong to, in document order.
  const holders = [...(root.hasAttribute("style") ? [root] : []), ...root.querySelectorAll<HTMLElement>("[style]")];
  holders.forEach((el, i) => {
    el.style.cssText = styles[i] ?? "";
  });
  return root;
}

export function MermaidDiagram({ code, streaming }: { code: string; streaming: boolean }) {
  const [id] = useState(nextMermaidId);
  const [drawn, setDrawn] = useState(false);
  const [failure, setFailure] = useState<{ source: string; rejection: DiagramRejection } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<Mounted | null>(null);
  const destroyed = useRef(false);
  // Draws run one after another, so the picture always belongs to the last text queued.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const painted = useRef(0);

  useEffect(() => {
    const wait = streaming ? Math.max(0, REDRAW_MS - (performance.now() - painted.current)) : 0;
    const timer = window.setTimeout(() => {
      painted.current = performance.now();
      queue.current = queue.current.then(() => paint(code)).catch(() => undefined);
    }, wait);
    return () => window.clearTimeout(timer);
    // The text and its settled flag alone: the paint reads the rest from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, streaming]);

  useEffect(
    () => () => {
      destroyed.current = true;
      mounted.current?.destroy();
      mounted.current = null;
    },
    [],
  );

  /** Draw `source` into the canvas, mounting Pele on the first paint. */
  async function paint(source: string): Promise<void> {
    const el = host.current;
    if (!el || destroyed.current) return;
    const options: MountOptions = {
      ...mermaidOptions(id),
      sanitize: adoptSvg,
      onRender: () => {
        setDrawn(true);
        setFailure(null);
      },
      onError: (error: unknown) => {
        // Pele dims the diagram it keeps while its own error line is up; ours is under the card.
        el.querySelector<SVGElement>("svg")?.style.removeProperty("opacity");
        setFailure({ source, rejection: rejectionOf(error) });
      },
    };
    try {
      const instance = mounted.current;
      if (instance) {
        instance.update(source, options);
        return;
      }
      const pele = await loadPele();
      if (destroyed.current || !host.current || mounted.current) return;
      const fresh = await pele.mountAsync(host.current, source, options);
      // The answer may have left the page while the chunk loaded: hand the instance back, not a leak.
      if (destroyed.current) fresh.destroy();
      else mounted.current = fresh;
    } catch (error) {
      if (!destroyed.current) setFailure({ source, rejection: rejectionOf(error) });
    }
  }

  // The failure belongs to the text it came from: newer text keeps the answer quiet until it draws or fails too.
  const rejected = failure && failure.source === code ? rejectedMermaid(code, failure.rejection, !streaming) : null;
  const note = rejected ? mermaidNote(rejected, !streaming) : null;
  return (
    <div className="mermaid-diagram pele-diagram" data-testid="mermaid-diagram">
      <div className="code-head">
        <span className="code-lang">Mermaid</span>
        <div className="code-actions">
          {note === null ? (
            <button
              type="button"
              className="code-action"
              aria-pressed={showSource}
              title={showSource ? "Show the diagram" : "Show the mermaid source"}
              onClick={() => setShowSource(!showSource)}
            >
              Source
            </button>
          ) : null}
          <CopyButton
            className="code-action"
            iconSize={13}
            label="Copy mermaid source"
            title="Copy mermaid source"
            icon={<IconCopy size={13} />}
            onCopy={() => navigator.clipboard?.writeText(code.replace(/\n$/, ""))}
          />
        </div>
      </div>
      {/* Hidden, not unmounted, while the source or a note is up: Pele redraws by itself when the canvas has a width again. */}
      <div className="mermaid-canvas" data-testid="mermaid-svg" hidden={note !== null || showSource}>
        <div ref={host} />
      </div>
      {note !== null || showSource || !drawn ? (
        <pre className="mermaid-source">
          <code>{code.replace(/\n$/, "")}</code>
        </pre>
      ) : null}
      {note === null ? null : (
        <div className="mermaid-note" data-testid="mermaid-note">
          {note}
        </div>
      )}
    </div>
  );
}
