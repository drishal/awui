// A backend preview of an agent-rendered HTML page (render_html): a one-off
// headless Chromium run that turns the stored document into a PNG, so a tool
// card can show the page without hosting a live frame. The preview route is
// authenticated before this runs; the HTML is the sanitized bytes the render
// store already holds, re-served here from an in-memory route on a fixed
// preview origin so the browser never touches the filesystem, the app, or
// the network — every other request is aborted, and inline assets are all a
// preview gets. A preview keeps no cookies, storage, or profile: its context
// is memory-only and closed when the run ends, whatever the outcome.
import { existsSync } from "node:fs";
import type { Browser, Route } from "playwright-core";
import type * as Playwright from "playwright-core";
import { packagedRequire } from "./binary-runtime.js";

// Chromium chooses CDP here, so the optional BiDi module is not loaded. Its
// CommonJS backend is staged only for explicit preview routes, not chat output.
const { chromium } = packagedRequire<typeof Playwright>("playwright-core");

/** The one origin a preview serves; no data:, no arbitrary URLs, no network. */
const PREVIEW_URL = "http://preview.awui/";
/** Bounds the whole preview: launch, navigation, and the screenshot. */
const PREVIEW_TIMEOUT_MS = 8_000;
/** The preview viewport: the tool card's aspect. Desktop only for now. */
const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 900;
/** Console lines a preview keeps, and how long one line may be. */
const MAX_CONSOLE_LINES = 20;
const MAX_CONSOLE_LINE = 1_000;
/** The theme variables a preview injects; the same names the frame hands a live page. */
const THEME_VARIABLE_KEYS = [
  "--font-sans", "--font-mono", "--bg", "--surface", "--surface-2", "--border", "--text", "--text-2", "--muted",
  "--accent", "--accent-fg", "--accent-hover", "--link", "--danger", "--warn", "--ok", "--info", "--orange", "--thinking",
] as const;
/** How many variables one preview applies; the list above is the real bound. */
const MAX_THEME_VARIABLES = 20;
/** The CSP the render route serves the live document with, reused for previews. */
const PREVIEW_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'; sandbox allow-scripts allow-forms";

/** Why a preview did not run; the route maps each to a clear response. */
export type PreviewFailure = "browser_missing" | "timeout" | "failed";

/** A preview that never produced an image, with the bounded cause. */
export class PreviewError extends Error {
  constructor(
    readonly code: PreviewFailure,
    message: string,
  ) {
    // One line, no stack: the message goes straight into an API response.
    super(message.replace(/\s+/g, " ").trim());
  }
}

/** A finished preview: the screenshot bytes, what the page said, and the viewport it drew in. */
export interface PreviewResult {
  image: Buffer;
  console: string[];
  width: number;
  height: number;
}

/**
 * The theme as one `:root` rule, each value sanitized the way the page
 * bootstrap sanitizes its own (control characters and CSS structure gone),
 * and anything over the value cap dropped. Unknown keys are ignored: a
 * preview reads the same variables a live frame does, no more.
 */
export function themeVariableCss(theme: Record<string, string>, appearance: "light" | "dark"): string {
  if (typeof theme !== "object" || theme === null || Array.isArray(theme)) theme = {};
  const rules: string[] = [];
  for (const key of THEME_VARIABLE_KEYS) {
    const raw = theme[key];
    if (typeof raw !== "string" || raw === "") continue;
    if (!/^--[a-z0-9-]+$/.test(key) || raw.length > 1_000) continue;
    const value = raw.replace(/[;{}<>]/g, "").trim();
    if (value === "") continue;
    rules.push(`${key}:${value};`);
    if (rules.length >= MAX_THEME_VARIABLES) break;
  }
  return `:root{color-scheme:${appearance === "light" ? "light" : "dark"};${rules.join("")}}`;
}

/** A preview's cause, classified: a missing browser, a timeout, or the first line of what else went wrong. */
function previewError(error: unknown): PreviewError {
  if (error instanceof PreviewError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|looks like Playwright was just installed/i.test(message)) {
    return new PreviewError("browser_missing", "HTML preview is unavailable: the Playwright Chromium browser is not installed");
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new PreviewError("timeout", `HTML preview did not finish within ${PREVIEW_TIMEOUT_MS / 1000}s`);
  }
  return new PreviewError("failed", `HTML preview failed: ${message.split("\n")[0]}`);
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, timeout: PREVIEW_TIMEOUT_MS });
  } catch (error) {
    throw previewError(error);
  }
}

/**
 * Resolve with the work's outcome, or reject with a timeout once the whole
 * preview has had its 8 seconds — launch, navigation, and screenshot
 * together, not each on its own clock. A late failure of the losing work is
 * absorbed: it was already decided against.
 */
function withDeadline<T>(work: Promise<T>): Promise<T> {
  // Promise.withResolvers needs ES2024; this project compiles to ES2023.
  const settled = work.catch(() => undefined);
  let rejectDeadline!: (error: PreviewError) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(
    () => rejectDeadline(new PreviewError("timeout", `HTML preview did not finish within ${PREVIEW_TIMEOUT_MS / 1000}s`)),
    PREVIEW_TIMEOUT_MS,
  );
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
    void settled;
  });
}

/** The browser side of one preview: serve the document, theme it, wait it out, shoot it. */
async function renderPage(browser: Browser, html: string, style: string): Promise<PreviewResult> {
  // A memory-only context: no storage state, no service workers, one viewport.
  const context = await browser.newContext({
    viewport: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  context.setDefaultTimeout(PREVIEW_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(PREVIEW_TIMEOUT_MS);
  const page = await context.newPage();

  const consoleLines: string[] = [];
  const rememberConsole = (text: string) => {
    if (consoleLines.length >= MAX_CONSOLE_LINES) return;
    const line = text.replace(/\s+/g, " ").trim().slice(0, MAX_CONSOLE_LINE);
    if (line !== "") consoleLines.push(line);
  };
  // What the page said, and what it threw: an uncaught error's stack is cut
  // to its first line, so a preview reports the cause and not a dump.
  page.on("console", (message) => rememberConsole(message.text()));
  page.on("pageerror", (error) => rememberConsole(`${error.name}: ${error.message.split("\n")[0]}`));

  // The document comes from this call's closure, served once, here; every
  // other request the page could make is aborted before it leaves.
  const abortAll = async (route: Route) => {
    try {
      await route.abort();
    } catch {
      // The run was already over when this route fired.
    }
  };
  await context.route(/.*/, abortAll);
  await context.route(PREVIEW_URL, async (route) => {
    try {
      // Registered last, so it is matched first: the document is served with
      // the same CSP the render route gives the live page.
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        headers: { "Content-Security-Policy": PREVIEW_CSP, "X-Content-Type-Options": "nosniff" },
        body: html,
      });
    } catch {
      // The run was already over when this route fired.
    }
  });

  await page.goto(PREVIEW_URL, { waitUntil: "networkidle", timeout: PREVIEW_TIMEOUT_MS });
  await page.addStyleTag({ content: style });
  const image = await page.screenshot({ type: "png", fullPage: false, scale: "css", timeout: PREVIEW_TIMEOUT_MS });
  return { image, console: consoleLines, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT };
}

/**
 * Preview a stored render document: a PNG of the page as a desktop browser
 * first paints it, themed with `theme`, plus what the page printed. Throws
 * `PreviewError` when the preview could not run; the caller classifies by
 * `code`, and the browser is closed either way.
 */
export async function previewHtmlRender(html: string, theme: Record<string, string>, appearance: "light" | "dark"): Promise<PreviewResult> {
  if (typeof html !== "string" || html.trim() === "") throw new PreviewError("failed", "HTML preview needs a document");
  const browser = await launchBrowser();
  try {
    return await withDeadline(renderPage(browser, html, themeVariableCss(theme, appearance)));
  } catch (error) {
    throw previewError(error);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Whether a preview could run at all on this machine: the browser binary is there. */
export function previewBrowserInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
