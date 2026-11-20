// Workarounds for OpenTUI 0.9.5 markdown (no published fix after 0.9.5).
//
// 1) updateList assumes every list child is already in `_shown`. When a
//    `renderBlock` hook is set, every top-level block is treated as custom, so
//    a list may be re-shown mid-apply (`show` always builds a fresh list box)
//    and `updateList` walks `childrenOf` against the new document before those
//    items exist in `_shown`:
//      TypeError: undefined is not an object (evaluating 'shown.ordinal = count++')
//    Skip items that are not shown yet; the next apply recounts once they are.
//
// 2) apply() splices trailing shown entries, then destroys each removed
//    `renderable` at the end. For a default block, `old.default === old.renderable`
//    so the engine clears `old.renderable` when it reuses the block. A
//    `renderBlock` wrapper is not the default, so a reused heading or code
//    wrapper is still destroyed after atui returns it, which blanks the block
//    (caret / commit transitions trip this). Skip destroying a renderable that
//    is already the new `_shown` entry's renderable.
//
// Safe to call more than once.
import { MarkdownRenderable } from "@opentui/core";

type Shown = { renderable?: { isDestroyed?: boolean; destroyRecursively?: () => void } };

type MarkdownHost = {
  updateList?: (index: number, listed?: number[]) => void;
  childrenOf?: (index: number) => number[];
  apply?: (changes: unknown) => void;
  _shown?: Shown[];
  __awuiListGuard?: boolean;
  __awuiApplyGuard?: boolean;
};

const isOrdinalCrash = (error: unknown) => error instanceof TypeError && /ordinal/.test(error.message);

function installUpdateListGuard(proto: MarkdownHost): void {
  if (proto.__awuiListGuard) return;
  const orig = proto.updateList;
  if (typeof orig !== "function") return;
  proto.__awuiListGuard = true;
  proto.updateList = function (this: MarkdownHost, index: number, listed?: number[]) {
    const shown = this._shown;
    const origChildrenOf = this.childrenOf;
    if (typeof origChildrenOf === "function" && shown) {
      this.childrenOf = (at: number) => origChildrenOf.call(this, at).filter((item) => shown[item] != null);
    }
    const present = listed?.filter((item) => !shown || shown[item] != null);
    try {
      return orig.call(this, index, present ?? listed);
    } catch (error) {
      if (isOrdinalCrash(error)) return;
      throw error;
    } finally {
      this.childrenOf = origChildrenOf;
    }
  };
}

function installApplyReuseGuard(proto: MarkdownHost): void {
  if (proto.__awuiApplyGuard) return;
  const orig = proto.apply;
  if (typeof orig !== "function") return;
  proto.__awuiApplyGuard = true;
  proto.apply = function (this: MarkdownHost, changes: unknown) {
    const rows = this._shown;
    if (!rows || typeof rows.splice !== "function") return orig.call(this, changes);
    const origSplice = rows.splice;
    rows.splice = function (this: Shown[], start: number, deleteCount?: number, ...items: Shown[]) {
      const removed = origSplice.call(this, start, deleteCount ?? rows.length - start, ...items);
      rows.splice = origSplice;
      for (const entry of removed) {
        const renderable = entry?.renderable as (Shown["renderable"] & { destroyRecursively: () => void }) | undefined;
        if (!renderable || typeof renderable.destroyRecursively !== "function") continue;
        const destroy = renderable.destroyRecursively.bind(renderable);
        renderable.destroyRecursively = () => {
          if (rows.some((row) => row.renderable === renderable)) return;
          return destroy();
        };
      }
      return removed;
    } as typeof rows.splice;
    try {
      return orig.call(this, changes);
    } finally {
      rows.splice = origSplice;
    }
  };
}

export function installOpenTuiListGuard(): void {
  const proto = MarkdownRenderable.prototype as unknown as MarkdownHost;
  installUpdateListGuard(proto);
  installApplyReuseGuard(proto);
}

installOpenTuiListGuard();
