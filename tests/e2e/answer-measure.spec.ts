// An answer's prose takes the chat column Settings' Chat width chose; nothing else caps it.
import { expect, test } from "@playwright/test";
import { signInAndOpen } from "./helpers.js";

test("a paragraph, a list and a quote in an answer are not capped at a reading measure", async ({ page }) => {
  await signInAndOpen(page);
  const caps = await page.evaluate(() => {
    const host = document.createElement("div");
    host.className = "answer";
    host.innerHTML = `<div class="md"><p>text</p><ul><li>x</li></ul><ol><li>y</li></ol><blockquote>q</blockquote><h2>h</h2><h3>h</h3></div>`;
    document.body.append(host);
    const out = [...host.querySelectorAll(".md > *")].map((el) => `${el.tagName.toLowerCase()}:${getComputedStyle(el).maxWidth}`);
    host.remove();
    return out;
  });
  expect(caps, "no prose block carries its own max-width").toEqual(["p:none", "ul:none", "ol:none", "blockquote:none", "h2:none", "h3:none"]);
});
