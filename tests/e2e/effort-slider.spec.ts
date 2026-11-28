// The effort slider (ThinkingPicker.tsx, effort-spring.ts): the analytic liquid layers, the
// keyboard's commit timing, reduced motion's static path, and the contrast of the thumb and the dots
// against the track in both themes (Appendix B's four e2e cases).
import { expect, test, type Page } from "@playwright/test";
import { openChat, signInAndOpen } from "./helpers.js";

const slider = (page: Page) => page.getByRole("slider", { name: "Thinking" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Thinking effort" });

/** Open a chat on a folder this run picks, including when the suite's last picker is empty. */
async function openEffortChat(page: Page): Promise<void> {
  await signInAndOpen(page);
  await openChat(page);
}

/** Open the picker and let the panel's own morphs finish, so the track is at rest before measuring. */
async function openPicker(page: Page): Promise<void> {
  await openEffortChat(page);
  await page.getByTestId("thinking-picker").click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

/** The stop dots' centres in page px, from their --atx share of the track's span. */
async function stopCentres(page: Page): Promise<Array<{ x: number; y: number }>> {
  const track = (await page.locator(".effort-track").boundingBox()) as { x: number; y: number; width: number; height: number };
  const count = await page.locator(".effort-stop").count();
  const inset = track.height / 2;
  // The dot's centre is the stop's centre, and the thumb's centre lands on it (model-picker.css).
  return Array.from({ length: count }, (_, i) => ({
    x: track.x + inset + (i / (count - 1)) * (track.width - inset * 2),
    y: track.y + track.height / 2,
  }));
}

test("dragging from the first stop to the last moves the thumb there and commits once", async ({ page }) => {
  await openPicker(page);
  // The fake chat starts on its default level (low, stop 1); the slider carries three stops (off, low, high).
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "1");
  const stops = await stopCentres(page);
  // Drag 1:1 with the pointer (the thumb follows, not snapped), then release on the last stop.
  await page.mouse.move(stops[1]!.x, stops[1]!.y);
  await page.mouse.down();
  await page.mouse.move((stops[1]!.x + stops[2]!.x) / 2, stops[1]!.y, { steps: 8 });
  await page.mouse.move(stops[2]!.x, stops[2]!.y, { steps: 8 });
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "2");
  await page.mouse.up();
  // Released on the last stop: committed immediately, one change.
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "2");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "High");
  await expect(page.locator(".effort-value .effort-roll")).toHaveText("High");
  await expect(page.getByTestId("thinking-picker")).toHaveAccessibleName("Thinking: high");
  // Once the thumb's transform is idle its centre is within 1px of the last stop's centre.
  await expect
    .poll(() => {
      return page.locator(".effort-thumb").evaluate((el): number => {
        const r = el.getBoundingClientRect();
        const track = el.closest(".effort-track");
        const stops = track?.querySelectorAll<HTMLElement>(".effort-stop") ?? [];
        const last = stops[stops.length - 1];
        if (!last) return 999;
        const s = last.getBoundingClientRect();
        return Math.abs(r.left + r.width / 2 - (s.left + s.width / 2)) + Math.abs(r.top + r.height / 2 - (s.top + s.height / 2));
      });
    })
    .toBeLessThanOrEqual(1);
  // The analytic liquid layer stays mounted; its rest neck needs no separate bead geometry.
  await expect(page.locator(".effort-liquid")).toBeAttached();
  await expect(page.locator(".effort-neck")).toHaveAttribute("d", "");
  await expect(page.locator(".effort-goo")).toHaveCount(0);
  await expect(page.locator(".effort-thumb")).toHaveCSS("filter", "none");
});

test("two arrow-right steps commit once, after the settle time", async ({ page }) => {
  await openPicker(page);
  const picks: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && req.url().includes("/config") && req.postData()?.includes("thinkingLevel")) picks.push(req.postData() ?? "");
  });
  // The chat starts on low (1); one ArrowRight lands on high (2), the last stop.
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "1");
  await slider(page).press("ArrowRight");
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "2");
  // The step has not settled: nothing is sent inside 150 ms.
  await expect.poll(() => picks.length, { intervals: [150], timeout: 150 }).toBe(0);
  // One commit for the gesture: 350 ms after the step one PATCH carries the level.
  await expect.poll(() => picks.length, { timeout: 5_000 }).toBe(1);
  await expect(picks[0]).toContain("high");
});

test("with reduced motion the liquid paths are hidden and the thumb jumps to the key's target", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPicker(page);
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "1");
  // A low-end coarse pointer and reduced motion leave only the static wash: no neck or rings.
  await expect(page.locator(".effort-liquid")).toBeHidden();
  await expect(page.locator(".effort-neck")).toHaveCount(0);
  await expect(page.locator(".effort-stop.is-passed")).toHaveCount(2);
  // The thumb is at the target in the same frame as the key press.
  const stops = await stopCentres(page);
  await slider(page).press("End");
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "2");
  const thumb = (await page.locator(".effort-thumb").boundingBox()) as { x: number; y: number; width: number };
  expect(Math.abs(thumb.x + thumb.width / 2 - stops[2]!.x)).toBeLessThanOrEqual(1);
});

test("the thumb, eye cues and the full text caption clear 3:1 against the track in both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    // Reduced motion draws passed stops directly; normal motion wets them only while the liquid passes.
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await openEffortChat(page);
    await page.getByTestId("thinking-picker").click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    // The thumb (nearly white) against the track (surface-2), and a passed dot (thinking) against it.
    // Chrome resolves color-mix() to oklab() or color(srgb ...); parse both to 0-255 sRGB.
    const parsed = (color: string): [number, number, number] => {
      const rgb = color.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
      if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
      const srgb = color.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
      const oklab = color.match(/oklab\(([-\d.]+)%? ([-\d.]+)%? ([-\d.]+)%?/);
      if (oklab) {
        // Björn Ottosson's oklab → linear sRGB, then gamma.
        const [L, a, b] = [Number(oklab[1]), Number(oklab[2]), Number(oklab[3])];
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.291485548 * b;
        const lin = [l_ ** 3, m_ ** 3, s_ ** 3] as const;
        const gamma = (c: number): number => {
          const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
          return Math.max(0, Math.min(255, v * 255));
        };
        const [l0, l1, l2] = lin;
        return [gamma(4.0767416621 * l0 - 3.3077115913 * l1 + 0.2309699292 * l2), gamma(-1.2684380046 * l0 + 2.6097574011 * l1 - 0.3413193965 * l2), gamma(-0.0041960863 * l0 - 0.7034186147 * l1 + 1.707614701 * l2)];
      }
      return [0, 0, 0];
    };
    const ratio = (a: [number, number, number], b: [number, number, number]): number => {
      const lum = ([r, g, bl]: [number, number, number]) => {
        const f = (c: number) => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
      };
      const [hi, lo] = lum(a) > lum(b) ? [a, b] : [b, a];
      return (lum(hi) + 0.05) / (lum(lo) + 0.05);
    };
    const thumbFill = await page.locator(".effort-thumb").evaluate((el) => getComputedStyle(el).backgroundColor);
    const trackFill = await page.locator(".effort-track").evaluate((el) => getComputedStyle(el).backgroundColor);
    const dotFill = await page.locator(".effort-stop.is-passed").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    // The thumb against the track reads through its shine's tint in the dark scheme; the fill itself is
    // what contrast is checked on.
    expect(ratio(parsed(thumbFill), parsed(trackFill))).toBeGreaterThanOrEqual(3);
    expect(ratio(parsed(dotFill), parsed(trackFill))).toBeGreaterThanOrEqual(3);
    for (const dot of await page.locator(".effort-stop:not(.is-passed)").all()) {
      const unlit = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(ratio(parsed(unlit), parsed(trackFill)), `${theme}: unlit stop ${unlit} vs track ${trackFill}`).toBeGreaterThanOrEqual(3);
    }
    const hint = await page.locator(".composer-input").evaluate((el) => getComputedStyle(el, "::before").color);
    const face = await page.locator(".composer-card").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(ratio(parsed(hint), parsed(face)), `${theme}: prompt hint ${hint} vs composer ${face}`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the thumb, dots and analytic paths stay inside the track at every stop", async ({ page }) => {
  await openPicker(page);
  const inside = async (label: string) => {
    const f = await page.evaluate(() => {
      const track = document.querySelector(".effort-track")!.getBoundingClientRect();
      // Analytic SVG paths use the specified 1px broad-phase bound; HTML bead and dots keep the tighter 0.5px check.
      const within = (b: { left: number; right: number; top: number; bottom: number }, tolerance = 1) => b.left >= track.left - tolerance && b.right <= track.right + tolerance && b.top >= track.top - tolerance && b.bottom <= track.bottom + tolerance;
      const boxes = (selector: string) => [...document.querySelectorAll(selector)].map((el) => within(el.getBoundingClientRect(), 0.5));
      // SVG's viewport box is the track-sized <svg>, not the path. getBBox plus its screen transform
      // measures the material itself, including any bridge or droplet extending from the bead.
      const pathBox = (selector: string) => {
        const path = document.querySelector<SVGPathElement>(selector)!;
        const matrix = path.getScreenCTM()!;
        const b = path.getBBox();
        // A conservative screen-space bound of a possibly transformed path.
        const xs = [b.x, b.x + b.width].flatMap((x) => [b.y, b.y + b.height].map((y) => matrix.a * x + matrix.c * y + matrix.e));
        const ys = [b.x, b.x + b.width].flatMap((x) => [b.y, b.y + b.height].map((y) => matrix.b * x + matrix.d * y + matrix.f));
        return within({ left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) });
      };
      const x = parseFloat(getComputedStyle(document.querySelector(".effort-stops")!).getPropertyValue("--x"));
      const wash = document.querySelector<SVGPathElement>(".effort-wash-body")!.getBBox();
      return {
        thumb: boxes(".effort-thumb"), dots: boxes(".effort-stop"), liquid: pathBox(".effort-liquid"),
        neck: pathBox(".effort-neck"), wash: pathBox(".effort-wash-body"), washWidth: wash.x + wash.width, x,
        passed: [...document.querySelectorAll(".effort-stop.is-passed")].length,
      };
    });
    expect(f.thumb.every(Boolean), `${label}: thumb inside`).toBe(true);
    expect(f.dots.every(Boolean), `${label}: dots inside`).toBe(true);
    expect(f.liquid, `${label}: analytic liquid paths inside`).toBe(true);
    expect(f.neck, `${label}: analytic neck inside`).toBe(true);
    expect(f.wash, `${label}: wash inside ${JSON.stringify(f)}`).toBe(true);
    // --x is the bead centre; the wash may lead it by the small specified head, but must stay track-bound.
    expect(f.washWidth >= f.x && f.washWidth - f.x <= 10, `${label}: wash stays on the bead's leading edge`).toBe(true);
    expect(f.passed, `${label}: selection alone does not wet dots`).toBe(0);
  };
  await inside("rest");
  for (const key of ["End", "Home", "End"]) {
    await slider(page).press(key);
    await page.waitForTimeout(700);
    await inside(key);
  }
});

test("the neck exists during a jump and rings stay bounded", async ({ page }) => {
  await openPicker(page);
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "1");
  await slider(page).press("End");
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "2");
  // Sample in the page, not through screenshots: a bridge must exist at some point, but never leave the track
  // (within the specified 1px), and the ring pool must never have more than two running animations.
  const sampler = page.evaluate(() => new Promise<{ sawNeck: boolean; maxRings: number; escaped: boolean }>((resolve) => {
    const track = document.querySelector(".effort-track")!.getBoundingClientRect();
    let sawNeck = false;
    let maxRings = 0;
    let escaped = false;
    const start = performance.now();
    const sample = () => {
      const path = document.querySelector<SVGPathElement>(".effort-neck")!;
      const box = path.getBBox();
      const matrix = path.getScreenCTM()!;
      const xs = [box.x, box.x + box.width].flatMap((x) => [box.y, box.y + box.height].map((y) => matrix.a * x + matrix.c * y + matrix.e));
      const ys = [box.x, box.x + box.width].flatMap((x) => [box.y, box.y + box.height].map((y) => matrix.b * x + matrix.d * y + matrix.f));
      if (box.width >= 16) sawNeck = true;
      escaped ||= Math.min(...xs) < track.left - 1 || Math.max(...xs) > track.right + 1 || Math.min(...ys) < track.top - 1 || Math.max(...ys) > track.bottom + 1;
      maxRings = Math.max(maxRings, [...document.querySelectorAll(".effort-ring")].filter((el) => el.getAnimations().some((a) => a.playState === "running")).length);
      if (performance.now() - start < 400) requestAnimationFrame(sample);
      else resolve({ sawNeck, maxRings, escaped });
    };
    sample();
  }));
  const result = await sampler;
  expect(result.sawNeck && result.escaped === false && result.maxRings <= 2, JSON.stringify(result)).toBe(true);
});

test("forced colors show a track-wide value without the liquid layer", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openPicker(page);
  await expect(page.locator(".effort-liquid")).toBeHidden();
  // Let forced colors resolve Highlight on the page itself; its RGB is platform-defined.
  await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "Highlight";
    probe.id = "effort-system-highlight-probe";
    document.body.append(probe);
  });
  const washFill = await page.locator(".effort-wash-body").evaluate((el) => getComputedStyle(el).fill);
  const highlight = await page.locator("#effort-system-highlight-probe").evaluate((el) => { const color = getComputedStyle(el).color; el.remove(); return color; });
  expect(washFill === highlight, `wash uses the system's Highlight: ${washFill} / ${highlight}`).toBe(true);
  const path = () => page.locator(".effort-wash-body").getAttribute("d");
  const before = await path();
  await slider(page).press("End");
  await expect.poll(path).not.toBe(before);
});

test("a coarse-pointer, low-end browser keeps the static path", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await context.addInitScript(() => { Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 }); });
  try {
    const page = await context.newPage();
    await openEffortChat(page);
    // At this width the config sheet carries the effort control. Take focus with the message box, then open it.
    await page.getByRole("textbox", { name: "Message" }).click();
    await page.getByTestId("config-chip").click();
    await page.getByRole("dialog", { name: "Chat settings" }).getByTestId("thinking-picker").click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await expect(page.locator(".effort-liquid")).toBeHidden();
    await expect(page.locator(".effort-neck")).toHaveCount(0);
    await expect(slider(page)).toHaveAttribute("aria-valuenow", "1");
    await slider(page).press("End");
    await expect(slider(page)).toHaveAttribute("aria-valuenow", "2");
    await expect(page.locator(".effort-stop.is-passed")).toHaveCount(3);
    await expect(page.locator(".effort-neck")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("an unlit stop dot paints a colour of its own, not a transparent one", async ({ page }) => {
  await openPicker(page);
  // The dot's background once named a token that does not exist (--muted-foreground), which computes to transparent:
  // at rest only the lit dots showed, and the stops ahead of the bead were invisible.
  await slider(page).press("Home");
  await page.waitForTimeout(700);
  const dots = await page.locator(".effort-stop").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(dots.length).toBeGreaterThanOrEqual(3);
  for (const color of dots) expect(color).not.toBe("rgba(0, 0, 0, 0)");
});

test("the bead has its shadow layer: sized, with a shadow and a hairline", async ({ page }) => {
  await openPicker(page);
  // The stylesheet once named .effort-thumb-shadow while the markup says .effort-shadow, so the layer was 0 px wide with
  // no shadow: on a light track the white bead had no edge at all.
  const shadow = await page.locator(".effort-shadow").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: el.getBoundingClientRect().width, boxShadow: cs.boxShadow };
  });
  expect(shadow.width).toBeGreaterThanOrEqual(19);
  expect(shadow.boxShadow).not.toBe("none");
});


test("the keyboard ring uses the theme accent, leaving a system colour to forced colors", async ({ page }) => {
  await openPicker(page);
  const accent = await slider(page).evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    el.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  // Establish keyboard modality and a genuine visible keyboard focus before reopening.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await page.getByTestId("thinking-picker").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => slider(page).evaluate((el) => document.activeElement === el && el.matches(":focus-visible"))).toBe(true);
  expect(await slider(page).evaluate((el) => getComputedStyle(el).outlineColor)).toBe(accent);
  await page.emulateMedia({ forcedColors: "active" });
  await expect(slider(page)).toBeFocused();
  expect(await slider(page).evaluate((el, expected) => getComputedStyle(el).outlineColor !== expected && getComputedStyle(el).outlineWidth === "2px", accent)).toBe(true);
});
