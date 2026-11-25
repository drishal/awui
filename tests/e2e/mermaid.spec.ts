// A ```mermaid fence in an answer, drawn by Pele (src/web/components/MermaidDiagram.tsx).
// The fake harness's `mermaidflow` answer is one complete flowchart streamed in small
// chunks, so the fence is unparseable for the first second of the run: the answer must
// not flash an error, and the finished diagram must be the SVG, not the fence's text.
// `mermaidbad` is text Pele rejects once it settles: the source stays, with one quiet line.
import { expect, test } from "@playwright/test";
import { newChat, send, sendAndWait, signInAndOpen } from "./helpers.js";

test("a mermaid fence draws as a diagram, with its source one click away", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await send(page, "mermaidflow please");
  const diagram = page.getByTestId("turn").last().getByTestId("answer").getByTestId("mermaid-diagram");
  const canvas = diagram.getByTestId("mermaid-svg");
  const svg = canvas.locator("svg.pele");
  // The fence exists and is still growing: nothing about it is an error yet.
  await expect(diagram).toBeVisible();
  await expect(diagram.getByTestId("mermaid-note")).toHaveCount(0);
  await expect(svg).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-status")).toHaveText("Idle");
  await expect(diagram.getByTestId("mermaid-note")).toHaveCount(0);
  for (const label of ["Start", "Render", "SVG"]) await expect(svg).toContainText(label);
  // Pele's own declarations cross the page's CSP (style-src 'self') by being replayed through the
  // CSSOM: the root's max-width and a shape's radius are what a refused style attribute would lose.
  await expect(svg).toHaveCSS("max-width", "100%");
  await expect(canvas.locator(".pele-node rect").first()).toHaveCSS("rx", "10px");
  // It rendered: the fence's own text is not what the answer shows.
  await expect(diagram.locator("pre.mermaid-source")).toHaveCount(0);
  await expect(diagram.getByRole("button", { name: "Copy mermaid source", exact: true })).toBeVisible();

  const toggle = diagram.getByRole("button", { name: "Source", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(diagram.locator("pre.mermaid-source")).toContainText("flowchart LR");
  await expect(canvas).toBeHidden();
  await toggle.click();
  await expect(canvas).toBeVisible();
  await expect(svg).toBeVisible();
  await expect(diagram.locator("pre.mermaid-source")).toHaveCount(0);
});

test("a diagram follows the page's theme tokens without a redraw", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "mermaidflow please");
  const diagram = page.getByTestId("turn").last().getByTestId("answer").getByTestId("mermaid-diagram");
  const svg = diagram.locator("svg.pele");
  await expect(svg).toBeVisible();
  const colour = () => svg.evaluate((el) => getComputedStyle(el).color);
  await svg.evaluate((el) => el.setAttribute("data-probe", "kept"));
  // Both schemes leave the same element on the page: the theme never redraws a diagram.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(svg).toBeVisible();
    await expect(svg).toHaveAttribute("data-probe", "kept");
    await expect(diagram.getByTestId("mermaid-note")).toHaveCount(0);
  }
  // Pele's colours are the page's tokens (styles/pele.css): setting one repaints the SVG,
  // which a re-render would have replaced.
  await page.evaluate(() => document.documentElement.style.setProperty("--text", "#123456"));
  await expect.poll(colour).toBe("rgb(18, 52, 86)");
  await expect(svg).toHaveAttribute("data-probe", "kept");
});

test("a fence Pele rejects keeps its source and says why, quietly", async ({ page }) => {
  await signInAndOpen(page);
  await newChat(page);
  await sendAndWait(page, "mermaidbad please");
  const diagram = page.getByTestId("turn").last().getByTestId("answer").getByTestId("mermaid-diagram");
  await expect(diagram.locator("pre.mermaid-source")).toContainText("flowchart LR");
  await expect(diagram.getByTestId("mermaid-note")).toHaveText(/^Couldn't draw this diagram as Mermaid\. /);
  // Whatever was drawn while the text grew is not shown as if it were this diagram.
  await expect(diagram.getByTestId("mermaid-svg")).toBeHidden();
  await expect(diagram.getByRole("button", { name: "Source", exact: true })).toHaveCount(0);
});
