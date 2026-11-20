// Standalone probe for the OpenTUI 0.9.5 markdown list crash:
//   TypeError: undefined is not an object (evaluating 'shown.ordinal = count++')
// in MarkdownRenderable.updateList (packages/core/src/renderables/Markdown.ts).
//
// From the awui checkout (so a single solid-js copy is used):
//   bun --preload @opentui/solid/preload scripts/repro-opentui-list-crash.tsx
//
// The engine walks childrenOf() against the document while `_shown` may not
// yet have those items, when a renderBlock hook makes every top-level block
// "custom" and a list is re-shown mid-apply. No published version after 0.9.5
// fixes this. atui installs a guard (see src/atui/opentui-list-guard.ts).
// Pass --unguarded to skip the guard (upstream behaviour).
import { createSignal } from "solid-js";
import { BoxRenderable, MarkdownRenderable, type Renderable } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import { syntaxFor } from "../src/atui/ui/syntax.ts";
import { DARK } from "../src/atui/theme.ts";

const unguarded = process.argv.includes("--unguarded");
if (!unguarded) {
  await import("../src/atui/opentui-list-guard.ts");
}

const DOC = `# Streaming heading

A short intro paragraph about the flicker fix.

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

function chunks(s: string, step: number): string[] {
  const out: string[] = [];
  for (let i = step; i < s.length; i += step) out.push(s.slice(0, i));
  out.push(s);
  return out;
}

function wrap(block: { kind?: string; level?: number }, ctx: { defaultRender: () => Renderable | null }) {
  const kind = block.kind;
  if (kind !== "heading" && kind !== "quote" && kind !== "code") return undefined;
  const inner = ctx.defaultRender();
  if (!inner) return inner;
  if (kind === "heading" && (block.level ?? 1) > 2) return inner;
  const panel = new BoxRenderable(inner.ctx, { flexDirection: "column", width: "100%" });
  panel.add(inner);
  const outer = new BoxRenderable(inner.ctx, { flexDirection: "column", width: "100%" });
  outer.add(panel);
  return outer;
}

async function run(name: string, doc: string, step: number, useWrap: boolean) {
  const [text, setText] = createSignal("");
  const [streaming, setStreaming] = createSignal(true);
  const label = `${name} step=${step} wrap=${useWrap} guard=${!unguarded}`;
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
          renderBlock={useWrap ? wrap : undefined}
        />
      </box>
    );
  }, { width: 80, height: 28, exitOnCtrlC: false });
  try {
    for (const chunk of chunks(doc, step)) {
      setText(chunk);
      setStreaming(true);
      await setup.renderOnce();
    }
    setText(doc);
    setStreaming(false);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const ok = frame.includes("two items") || frame.includes("one item") || frame.includes("Streaming heading");
    console.log(`OK     ${label} visible=${ok}`);
  } catch (error) {
    console.log(`CRASH  ${label}\n  ${error instanceof Error ? error.stack ?? error.message : error}`);
  } finally {
    setup.renderer.destroy();
    await setup.dispose();
  }
}

const corePkg = await Bun.file("node_modules/@opentui/core/package.json").json() as { version: string };
console.log(`OpenTUI ${corePkg.version} unguarded=${unguarded}`);
await run("full-doc-ul", DOC, 12, true);
await run("full-doc-ul", DOC, 1, true);
await run("list-only", "- one item\n- two items\n", 3, true);
await run("list-only-nowrap", "- one item\n- two items\n", 3, false);
await run("ordered-nested", "# T\n\n1. one item\n   - nested a\n   - nested b\n2. two items\n", 4, true);

// Synthetic hole: the mid-apply race, invoked directly on the live instance.
{
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
          renderBlock={wrap}
        />
      </box>
    );
  }, { width: 40, height: 10, exitOnCtrlC: false });
  try {
    await setup.renderOnce();
    let md: MarkdownRenderable | undefined;
    const visit = (n: { getChildren?: () => unknown[] }) => {
      if (n instanceof MarkdownRenderable) md = n;
      for (const c of n.getChildren?.() ?? []) visit(c as { getChildren?: () => unknown[] });
    };
    visit(setup.renderer.root);
    if (!md) throw new Error("no MarkdownRenderable");
    const host = md as MarkdownRenderable & { updateList: (i: number, listed?: number[]) => void; _shown: unknown[]; childrenOf: (i: number) => number[] };
    let index = 0;
    for (let i = 0; i < host._shown.length; i++) {
      if (host.childrenOf(i).length > 0) {
        index = i;
        break;
      }
    }
    const items = host.childrenOf(index);
    const ghost = host._shown.length + 5;
    try {
      host.updateList(index, [...items, ghost]);
      console.log(`OK     synthetic-hole updateList([...items, ${ghost}]) guard=${!unguarded}`);
    } catch (error) {
      console.log(`CRASH  synthetic-hole updateList\n  ${error instanceof Error ? error.stack ?? error.message : error}`);
    }
  } finally {
    setup.renderer.destroy();
    await setup.dispose();
  }
}
