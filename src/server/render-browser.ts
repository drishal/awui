// Bounded Chromium for actions on an agent-rendered page this chat owns.
// There is no site-style navigation or arbitrary script execution here. The
// stored HTML is served from one fixed origin; all other requests, popups and
// downloads are blocked. Actions manipulate only its controls in a memory-only
// context, serialized per render id so consecutive clicks cannot interleave.
// One Chromium serves every page — a page is a context, not a process — and the
// browser closes once nothing has used it for a minute, so an idle server holds
// no browser at all. WebRTC is closed off at launch: it is not an HTTP request,
// so the route blocker cannot see it, and a sandboxed page may not reach STUN or
// UDP hosts.
// downloads are blocked. Actions manipulate only its controls in a memory-only
// context, serialized per render id so consecutive clicks cannot interleave.
import type { Browser, BrowserContext, Page } from "playwright-core";
import type * as Playwright from "playwright-core";
import type { z } from "zod";
import { renderActionSchema } from "../shared/protocol.js";
import type { Chat } from "./chats/chat.js";
import { ChatError } from "./chats/chat.js";
import { HTML_RENDER_THEME_MESSAGE, htmlRenderThemeFragment, type HtmlRenderTheme } from "../shared/html-render.js";
import { readHtmlRender } from "./html-render.js";
import { packagedRequire } from "./binary-runtime.js";

const { chromium } = packagedRequire<typeof Playwright>("playwright-core");
const ORIGIN = "http://preview.awui/";
const CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'; sandbox allow-scripts allow-forms";
const ACTION_TIMEOUT = 6000;
/**
 * Launch flags every preview page runs under: WebRTC is not HTTP, so the route blocker
 * cannot abort it, and a page whose scripts are allowed must not reach STUN or UDP hosts.
 */
const LAUNCH_ARGS = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-features=WebRtcHideLocalIpsWithMdns"];
/** How long the shared browser stays up with nothing on it: a preview costs a process. */
const IDLE_CLOSE_MS = 60_000;
/** Pages one server keeps live; the oldest is closed when a new one would pass this. */
const MAX_LIVE_PAGES = 16;

export type RenderAction = z.infer<typeof renderActionSchema>;

export interface ActionPageReport {
  renderId: string;
  action: RenderAction["action"];
  image?: Buffer;
  elements: Array<{ role: string; label: string; selector: string }>;
  console: string[];
}

interface LivePage { context: BrowserContext; page: Page; logs: string[] }
const live = new Map<string, LivePage>();
const lanes = new Map<string, Promise<unknown>>();
/** The one Chromium every live page runs on, made on first use and closed when idle. */
let shared: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function disarmIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
}

/** Arm the idle close once no page is live; a page opened first disarms it. */
function armIdle(): void {
  disarmIdle();
  if (live.size > 0) return;
  idleTimer = setTimeout(() => {
    void releaseIdleBrowser();
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

/**
 * Close the shared browser once nothing is live. The timer calls this by itself after its
 * window; a page that opens first disarms the timer, so a live context is never cut off.
 */
export async function releaseIdleBrowser(): Promise<void> {
  disarmIdle();
  if (live.size > 0) return;
  const browser = shared;
  shared = null;
  await browser?.close().catch(() => undefined);
}

/** What this module holds — one browser at most, the pages on it, whether the idle close is armed. */
export function previewState(): { browser: boolean; pages: number; idle: boolean } {
  return { browser: shared !== null, pages: live.size, idle: idleTimer !== null };
}

/** The shared browser, launched on first use; an idle-closed one is made again next time. */
async function browserFor(): Promise<Browser> {
  disarmIdle();
  if (shared !== null && shared.isConnected()) return shared;
  shared = await chromium.launch({ headless: true, timeout: ACTION_TIMEOUT, args: LAUNCH_ARGS });
  return shared;
}

export async function closeRenderPage(chatId: string, renderId: string): Promise<void> {
  const key = `${chatId}:${renderId}`;
  const prior = lanes.get(key);
  if (prior) await prior.catch(() => undefined);
  lanes.delete(key);
  const previous = live.get(key);
  live.delete(key);
  // The page's own context goes, never the shared browser: another chat's page may be on it,
  // and the browser itself is closed by the idle timer once nothing is live.
  if (previous) await previous.context.close().catch(() => undefined);
  armIdle();
}

/** The passed-away chat relinquishes every live preview, never an outside actual page url. */
export async function closeRenderPages(chatId: string): Promise<void> {
  for (const key of new Set([...live.keys(), ...lanes.keys()])) {
    if (!key.startsWith(`${chatId}:`)) continue;
    await closeRenderPage(chatId, key.slice(chatId.length + 1));
  }
}

/** The page's transcript/known owner is the only page argument accepted here. */
async function openPage(stateDir: string, chat: Chat, renderId: string, theme?: HtmlRenderTheme): Promise<LivePage> {
  const existing = live.get(`${chat.chatId}:${renderId}`);
  if (existing) return existing;
  if (!chat.ownsHtmlRender(renderId)) throw new ChatError(404, "render_missing", "The current chat did not publish that page.");
  const html = await readHtmlRender(stateDir, renderId);
  if (html === null) throw new ChatError(404, "render_missing", "The agent's saved page could not be found.");
  const browser = await browserFor();
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", acceptDownloads: false });
    context.setDefaultTimeout(ACTION_TIMEOUT);
    await context.route(/.*/, async (route) => await route.abort());
    await context.route(ORIGIN, async (route) => await route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": CSP }, body: html }));
    const page = await context.newPage();
    const logs: string[] = [];
    page.on("console", (message) => { if (logs.length < 16) logs.push(message.text().replace(/\s+/g, " ").slice(0, 250)); });
    page.on("popup", (popup) => { void popup.close().catch(() => undefined); });
    await page.goto(`${ORIGIN}${theme ? htmlRenderThemeFragment(theme) : ""}`, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT });
    const created = { context, page, logs };
    live.set(`${chat.chatId}:${renderId}`, created);
    if (live.size > MAX_LIVE_PAGES) {
      const first = live.keys().next().value;
      if (first) await closeRenderPage(first.slice(0, first.indexOf(":")), first.slice(first.indexOf(":") + 1));
    }
    return created;
  } catch (error) {
    // A context this call made and cannot use is this call's to drop; the browser stays for
    // the next page, and goes by itself if nothing opens one.
    await context?.close().catch(() => undefined);
    armIdle();
    throw new ChatError(422, "browser_execution_failed", error instanceof Error ? error.message.slice(0, 500) : "Unable to create the action context");
  }
}

/** An a11y-like concise enumerate, not a giant arbitrary DOM dump. */
async function currentElements(page: Page, selector?: string): Promise<ActionPageReport["elements"]> {
  return await page.locator(selector ?? "button, a[role='button'], input, textarea, select,[role='button'],[role='textbox']").evaluateAll((nodes) => nodes.slice(0, 40).map((node) => {
    const tag = node.tagName.toLowerCase();
    const name = tag === "input" ? node.getAttribute("id") || node.getAttribute("name") || node.getAttribute("name") || node.getAttribute("id") || (node as unknown as { value: string }).value : tag === "textarea" ? (node as unknown as { value: string }).value || node.id || node.getAttribute("name") : node.getAttribute("aria-label") || (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || node.id || tag;
    return { role: node.getAttribute("role") || node.tagName.toLowerCase(), label: typeof name === "string" ? name.slice(0, 200) : "(unnamed control)", selector: node.id ? `#${node.id}` : node.tagName.toLowerCase()};
  }));
}

/**
 * The theme a page applies when the host changes it; the caller cannot supply its own script.
 * The message is dispatched on the page's own window, not posted: this page is sandboxed, so
 * its origin is opaque ("null") and `postMessage(message, "http://preview.awui/")` is dropped
 * by the receiver's origin check — the theme would never apply. The bootstrap listens on
 * `window` for exactly this method, and nothing but the validated theme travels in it.
 */
async function applyTheme(page: Page, theme?: HtmlRenderTheme): Promise<void> {
  if (!theme) return;
  await page.evaluate(({ method, theme }) => {
    const view = globalThis as unknown as {
      MessageEvent: new (type: string, init: { data: unknown }) => object;
      dispatchEvent: (event: object) => boolean;
    };
    view.dispatchEvent(new view.MessageEvent("message", { data: { method, theme } }));
  }, { method: HTML_RENDER_THEME_MESSAGE, theme });
}



async function execute(page: Page, args: RenderAction): Promise<Omit<ActionPageReport, "renderId" | "image" | "console">> {
  if (args.action === "snapshot") return { action: "snapshot", elements: await currentElements(page, args.selector) };
  if (args.action === "click") {
    const target = page.locator(args.selector);
    if (await target.count() !== 1) throw new ChatError(422, "selector_ambiguous", "That selector must match exactly one actionable control in this page");
    const href = await target.getAttribute("href");
    if (href !== null && href !== "") throw new ChatError(422, "navigation_blocked", "Links that navigate away from this agent's preview are not supported; request only a control local to this page");
    await target.click({ noWaitAfter: true, timeout: ACTION_TIMEOUT });
    return { action: "click", elements: await currentElements(page) };
  }
  if (args.action === "fill") {
    const target = page.locator(args.selector);
    if (await target.count() !== 1) throw new ChatError(422, "selector_ambiguous", "That selector must match exactly one editable input");
    const editable = await target.evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      return ["input", "textarea", "select"].includes(tag) || el.getAttribute("contenteditable") === "true" || el.getAttribute("iscontenteditable") === "true";
    });
    if (!editable) throw new ChatError(422, "not_editable", "This control is not a standard input, select, editable textarea or contenteditable element");
    if (await target.evaluate((el) => el.getAttribute("contenteditable") === "true" || el.getAttribute("iscontenteditable") === "true")) {
      await target.evaluate((el, value) => { (el as unknown as { innerText: string }).innerText = value; }, args.value);
    } else {
      const tag = await target.evaluate((el) => el.tagName.toLowerCase());
      if (tag === "select") {
        try { await target.selectOption({ label: args.value }); }
        catch { throw new ChatError(422, "invalid_input", "No option has that label; the field did not change"); }
      }
      else await target.fill(args.value);
    }
    return { action: "fill", elements: await currentElements(page) };
  }
  if (args.action === "scroll") {
    await page.evaluate((amount) => (globalThis as unknown as { scrollBy(x: number, y: number): void }).scrollBy(0, amount), args.amount);
    return { action: "scroll", elements: await currentElements(page) };
  }
  return { action: "screenshot", elements: await currentElements(page) };
}

/** Validate target ownership inside the outer shared ChatManager; execute once. */
export async function performRenderAction(stateDir: string, chat: Chat, requested: RenderAction): Promise<ActionPageReport> {
  if (!chat.ownsHtmlRender(requested.renderId)) throw new ChatError(404, "render_missing", "The supplied chat did not publish this page");
  if (requested.action === "close") {
    await closeRenderPage(chat.chatId, requested.renderId);
    return { renderId: requested.renderId, action: "close", elements: [], console: [] };
  }
  const next = (lanes.get(`${chat.chatId}:${requested.renderId}`) ?? Promise.resolve()).then(async () => {
    const session = await openPage(stateDir, chat, requested.renderId, (requested.action === "snapshot" || requested.action === "screenshot") ? requested.theme : undefined);
    if (requested.action === "snapshot") await applyTheme(session.page, requested.theme);
    if (requested.action === "screenshot") await applyTheme(session.page, requested.theme);
    const result = await execute(session.page, requested);
    const report: ActionPageReport = { renderId: requested.renderId, ...result, console: session.logs.slice(0, 16) };
    if (requested.action === "screenshot") report.image = await session.page.screenshot({ type: "png", fullPage: false });
    return report;
  });
  lanes.set(`${chat.chatId}:${requested.renderId}`, next.catch(() => undefined));
  return next;
}
