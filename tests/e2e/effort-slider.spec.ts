// The effort slider (ThinkingPicker.tsx, effort-spring.ts): the liquid thumb's drag geometry, the
// keyboard's commit timing, reduced motion's static path, and the contrast of the thumb and the dots
// against the track in both themes (Appendix B's four e2e cases).
import { expect, test, type Page } from "@playwright/test";
import { newChat, sendAndWait } from "./helpers.js";

const slider = (page: Page) => page.getByRole("slider", { name: "Thinking" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Thinking effort" });

/**
 * One chat on a folder this run picked: `newChat` keeps the server's current
 * folder, and a server with no folder yet sends nowhere, so name the folder
 * the way signInAndOpen does before the chat exists.
 */
async function openEffortChat(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose a project folder" });
  await expect(picker).toBeVisible();
  await picker.getByLabel("Or type a path").fill(`${process.env.AWUI_E2E_ROOT as string}/alpha`);
  await picker.getByRole("button", { name: "Open", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole("heading", { name: /^What should .*(do in|work on) alpha\?$/ })).toBeVisible();
  await sendAndWait(page, "hello");
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
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "high");
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
  // The goo layer ran while the springs moved and rests still after: the tail is under the thumb.
  await expect(page.locator(".effort-goo")).toBeAttached();
  await expect(page.locator(".effort-tail")).toBeAttached();
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
  await page.waitForTimeout(150);
  expect(picks).toHaveLength(0);
  // One commit for the gesture: 350 ms after the step one PATCH carries the level.
  await expect.poll(() => picks.length, { timeout: 5_000 }).toBe(1);
  await expect(picks[0]).toContain("high");
});

test("with reduced motion there is no tail, the goo is off, and the thumb jumps to the key's target", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPicker(page);
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "1");
  // No tail in the DOM and no goo layer: the static slider renders neither.
  await expect(page.locator(".effort-tail")).toHaveCount(0);
  await expect(page.locator(".effort-goo")).toHaveCount(0);
  // The thumb is at the target in the same frame as the key press.
  const stops = await stopCentres(page);
  await slider(page).press("End");
  await expect(slider(page)).toHaveAttribute("aria-valuenow", "2");
  const thumb = (await page.locator(".effort-thumb").boundingBox()) as { x: number; y: number; width: number };
  expect(Math.abs(thumb.x + thumb.width / 2 - stops[2]!.x)).toBeLessThanOrEqual(1);
});

test("the thumb and the passed dots clear 3:1 against the track in both themes", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
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
  }
});

test("the thumb, the dots and the fill stay inside the track at every stop", async ({ page }) => {
  await openPicker(page);
  const inside = async (label: string) => {
    const f = await page.evaluate(() => {
      const t = document.querySelector(".effort-track")!.getBoundingClientRect();
      const r = (sel: string) => [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect());
      const within = (b: DOMRect) => b.left >= t.left - 0.5 && b.right <= t.right + 0.5;
      const fill = document.querySelector(".effort-fill")!;
      // The wash's drawn width is its clip: `inset(0 calc(100% - N) 0 0)` leaves N px of the box visible.
      const clip = getComputedStyle(fill).clipPath;
      const m = /calc\(100% - ([\d.]+)px\)/.exec(clip);
      const box = fill.getBoundingClientRect();
      return { thumb: r(".effort-thumb").every(within), dots: r(".effort-stop").every(within), shine: r(".effort-shine").every(within), fillBox: within(box), washWidth: m ? box.width - (box.width - Number(m[1])) : -1, x: parseFloat(getComputedStyle(document.querySelector(".effort-track")!).getPropertyValue("--x")) };
    });
    expect(f.thumb, `${label}: thumb inside`).toBe(true);
    expect(f.dots, `${label}: dots inside`).toBe(true);
    expect(f.shine, `${label}: shine inside`).toBe(true);
    expect(f.fillBox, `${label}: fill box inside`).toBe(true);
    // The wash reaches the thumb's centre: its visible width is --x.
    expect(Math.abs(f.washWidth - f.x), `${label}: fill reaches the thumb centre`).toBeLessThanOrEqual(1);
  };
  await inside("rest");
  for (const key of ["End", "Home", "End"]) {
    await slider(page).press(key);
    await page.waitForTimeout(700);
    await inside(key);
  }
  // Every dot up to the value is lit, not only the first: the sibling rule that dimmed the later ones is gone.
  await slider(page).press("End");
  await page.waitForTimeout(700);
  const lit = await page.locator(".effort-stop").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(lit).size, "all passed dots share one colour at the last stop").toBe(1);
});
