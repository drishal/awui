// OpenTUI 0.9.5 list updates and atui's cached markdown wrappers.
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { BoxRenderable, MarkdownRenderable, type Renderable } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import { installOpenTuiListGuard } from "../../src/atui/opentui-list-guard.js";
import { renderDecoratedBlock } from "../../src/atui/ui/transcript.js";
import { syntaxFor } from "../../src/atui/ui/syntax.js";
import { DARK } from "../../src/atui/theme.js";

installOpenTuiListGuard();

const DOC = `# Streaming heading

A short intro paragraph about the flicker fix.

> A quoted thought while it streams.

\`\`\`ts
export function greet(name: string) {
  const message = \`hello \${name}\`
  return message
}
\`\`\`

## Second heading

The closing thought after the code.

- one item
- two items
`;

function chunks(text: string, step: number): string[] {
  const out: string[] = [];
  for (let i = step; i < text.length; i += step) out.push(text.slice(0, i));
  out.push(text);
  return out;
}

function walk(node: { getChildren?: () => { getChildren?: () => unknown[] }[] }, visit: (n: unknown) => void) {
  visit(node);
  for (const child of node.getChildren?.() ?? []) walk(child as { getChildren?: () => { getChildren?: () => unknown[] }[] }, visit);
}

const findMarkdown = (root: Renderable): MarkdownRenderable | undefined => {
  let hit: MarkdownRenderable | undefined;
  walk(root, (n) => {
    if (n instanceof MarkdownRenderable) hit = n;
  });
  return hit;
};

describe("atui OpenTUI 0.9 markdown stream", () => {
  it("keeps heading rules, quote bars, tinted code, and lists while streaming, and reuses wrappers", async () => {
    const [text, setText] = createSignal("");
    const [streaming, setStreaming] = createSignal(true);
    const cache = new Map();
    let creates = 0;
    const setup = await testRender(() => {
      const renderer = useRenderer();
      const renderBlock = (block: Parameters<typeof renderDecoratedBlock>[2], ctx: Parameters<typeof renderDecoratedBlock>[3]) => {
        const before = cache.size;
        const result = renderDecoratedBlock(DARK, cache, block, ctx);
        if (cache.size > before) creates += 1;
        return result;
      };
      return (
        <box width="100%" height="100%">
          <markdown
            content={text()}
            syntaxStyle={syntaxFor(DARK, renderer.nativeScene)}
            fg={DARK.text}
            conceal
            streaming={streaming()}
            renderBlock={renderBlock}
          />
        </box>
      );
    }, { width: 72, height: 28, exitOnCtrlC: false });
    try {
      for (const chunk of chunks(DOC, 12)) {
        setText(chunk);
        setStreaming(true);
        await setup.renderOnce();
      }
      setText(DOC);
      setStreaming(false);
      await setup.flush({ maxPasses: 8 });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Streaming heading");
      expect(frame).toMatch(/─{8,}/);
      expect(frame).toContain("quoted thought");
      expect(frame).toContain("export function greet");
      expect(frame).toContain("Second heading");
      expect(frame).toContain("one item");
      expect(frame).toContain("two items");
      // Heading, quote, and code each get one wrapper; they must be reused, not remounted per chunk.
      expect(creates).toBeLessThanOrEqual(6);
      expect(cache.size).toBeGreaterThanOrEqual(3);
    } finally {
      setup.renderer.destroy();
      await setup.dispose();
    }
  });

  it("streams a trailing list item without crashing", async () => {
    const [text, setText] = createSignal("");
    const [streaming, setStreaming] = createSignal(true);
    const cache = new Map();
    const setup = await testRender(() => {
      const renderer = useRenderer();
      return (
        <box width="100%" height="100%">
          <markdown
            content={text()}
            syntaxStyle={syntaxFor(DARK, renderer.nativeScene)}
            fg={DARK.text}
            conceal
            streaming={streaming()}
            renderBlock={(block, ctx) => renderDecoratedBlock(DARK, cache, block, ctx)}
          />
        </box>
      );
    }, { width: 72, height: 24, exitOnCtrlC: false });
    try {
      const source = "# Title\n\n- one item\n- two items\n";
      for (const chunk of chunks(source, 4)) {
        setText(chunk);
        await setup.renderOnce();
      }
      setStreaming(false);
      setText(source);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("one item");
      expect(frame).toContain("two items");
    } finally {
      setup.renderer.destroy();
      await setup.dispose();
    }
  });

  it("guards updateList when a list child is not yet in _shown", async () => {
    const setup = await testRender(() => {
      const renderer = useRenderer();
      return (
        <box width="100%" height="100%">
          <markdown
            content={"- one item\n- two items\n"}
            syntaxStyle={syntaxFor(DARK, renderer.nativeScene)}
            fg={DARK.text}
            conceal
            streaming
          />
        </box>
      );
    }, { width: 40, height: 10, exitOnCtrlC: false });
    try {
      await setup.renderOnce();
      const md = findMarkdown(setup.renderer.root);
      expect(md).toBeDefined();
      const host = md as unknown as { updateList: (index: number, listed?: number[]) => void; _shown: unknown[]; childrenOf: (index: number) => number[] };
      // Pick the first block that has children (the list).
      let index = -1;
      for (let i = 0; i < host._shown.length; i++) {
        if (host.childrenOf(i).length > 0) {
          index = i;
          break;
        }
      }
      expect(index).toBeGreaterThanOrEqual(0);
      const items = host.childrenOf(index);
      expect(items.length).toBeGreaterThan(0);
      // A hole like the 0.9.5 mid-apply race: a child index with no shown entry.
      const ghost = host._shown.length + 5;
      expect(() => host.updateList(index, [...items, ghost])).not.toThrow();
      expect(() => host.updateList(index)).not.toThrow();
    } finally {
      setup.renderer.destroy();
      await setup.dispose();
    }
  });
});
