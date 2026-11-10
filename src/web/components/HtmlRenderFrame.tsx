// A page an agent published into the chat, shown inline above the reply. The
// document is fetched from the chat's own html-render route into an iframe
// with an opaque origin (`sandbox="allow-scripts allow-forms"`, never
// `allow-same-origin`), so its scripts cannot reach the app's session. The
// page reads the active theme from its URL fragment before first paint and
// follows changes posted to its bootstrap; its reported content height, or
// the server's measured heights, size the frame so it does not scroll inside
// the thread.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HtmlRenderRef } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { HTML_RENDER_COLUMN_WIDTH, htmlRenderFrameHeight, htmlRenderThemeFragment, readHtmlRenderContentHeight, type HtmlRenderTheme } from "../../shared/html-render.js";

const THEME_VAR_NAMES = ["--bg", "--surface", "--surface-2", "--border", "--text", "--text-2", "--muted", "--accent", "--accent-hover", "--link", "--ok", "--danger", "--warn", "--info", "--orange", "--thinking", "--font-sans", "--font-mono"] as const;

/** The app's theme as the page's variables, read from :root's computed styles. */
function readTheme(): HtmlRenderTheme {
  const styles = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const name of THEME_VAR_NAMES) {
    const value = styles.getPropertyValue(name).trim();
    if (value !== "") variables[name] = value;
  }
  const scheme = styles.getPropertyValue("color-scheme").trim();
  return { appearance: scheme === "light" ? "light" : "dark", variables };
}

/** The live theme, re-read whenever :root's theme attributes change. */
function useHtmlRenderTheme(): HtmlRenderTheme {
  const [theme, setTheme] = useState<HtmlRenderTheme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(readTheme());
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export const HtmlRenderFrame = memo(function HtmlRenderFrame({ chatId, render }: { chatId: string; render: HtmlRenderRef }) {
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  const height = htmlRenderFrameHeight(render, width, contentHeight);
  // The theme rides the fragment so the page's bootstrap reads it before any
  // of its own script runs; the src is fixed for the frame's life, so a theme
  // change is posted, not navigated to.
  const src = useMemo(() => `/api/chats/${chatId}/html-render/${render.id}${htmlRenderThemeFragment(readTheme())}`, [chatId, render.id]);
  const theme = useHtmlRenderTheme();
  const [preview, setPreview] = useState<{ url: string; console: string[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const capture = async () => {
    setPreviewBusy(true); setPreviewError(null);
    try {
      const result = await api<{ url: string; console: string[] }>(`/api/chats/${chatId}/html-render/${render.id}/preview`, { method: "POST", body: { theme: theme.variables, appearance: theme.appearance } });
      setPreview(result);
    } catch (e) { setPreviewError(errorText(e)); }
    finally { setPreviewBusy(false); }
  };
  return (
    <div className="html-render-block">
      <div className="html-render-tools">
        <button type="button" className="btn btn-small btn-ghost" disabled={previewBusy} onClick={() => void capture()}>{previewBusy ? "Checking appearance…" : "Check appearance"}</button>
      </div>
      {previewError ? <p className="notice notice-error">{previewError}</p> : null}
      {preview ? <figure className="render-preview"><img src={preview.url} alt={`Preview of ${render.title || "rendered page"}`} />{preview.console.length > 0 ? <pre>{preview.console.join("\n")}</pre> : null}</figure> : null}
      <div className="html-render" style={{ height }}>
        <HtmlRenderDocument src={src} title={render.title} onWidth={setWidth} onContentHeight={setContentHeight} />
      </div>
    </div>
  );
});

function HtmlRenderDocument(props: { src: string; title: string; onWidth: (width: number) => void; onContentHeight: (height: number) => void }) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage({ method: "awui-html-render/theme", theme }, "*");
  };
  useEffect(postTheme, [theme]);

  // The frame's own width sets which measured height applies before the page reports.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) props.onWidth(entry.contentRect.width);
    });
    if (frame.parentElement) observer.observe(frame.parentElement);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { onContentHeight } = props;
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const reported = readHtmlRenderContentHeight(event.data);
      if (reported !== undefined) onContentHeight(reported);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onContentHeight]);

  // The page cannot open windows itself; it asks, and the client opens the
  // link only while this frame has focus and the reader has just used the app.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.method !== "awui-html-render/open-link") return;
      if (typeof data.url !== "string" || !/^https?:\/\//i.test(data.url)) return;
      if (document.activeElement !== frame || navigator.userActivation?.isActive === false) return;
      window.open(data.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage({ method: "awui-html-render/link-opened", id: data.id }, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={frameRef}
      src={props.src}
      title={props.title}
      // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts allow-forms"
      loading="lazy"
      onLoad={() => {
        setLoaded(true);
        postTheme();
      }}
      // A frame whose color scheme differs from its document's paints an opaque
      // canvas, so the blank start would flash white in dark mode.
      className="html-render-frame scheme-light"
      style={loaded ? { colorScheme: theme.appearance } : undefined}
    />
  );
}
