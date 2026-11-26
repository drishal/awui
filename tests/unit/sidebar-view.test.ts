// The sidebar's saved view: recent until a person picks projects, and anything else saved falls back to recent.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

describe("sidebar view", () => {
  it("is recent by default", async () => {
    const { readSidebarView } = await import("../../src/web/sidebar-view.js");
    expect(readSidebarView()).toBe("recent");
  });
  it("remembers projects, and clears the key when switched back", async () => {
    const { readSidebarView, writeSidebarView } = await import("../../src/web/sidebar-view.js");
    writeSidebarView("projects");
    expect(readSidebarView()).toBe("projects");
    expect(store.get("awui.sidebarView")).toBe('"projects"');
    writeSidebarView("recent");
    expect(readSidebarView()).toBe("recent");
    expect(store.has("awui.sidebarView")).toBe(false);
  });
  it("ignores a value it does not know", async () => {
    store.set("awui.sidebarView", '"grid"');
    const { readSidebarView } = await import("../../src/web/sidebar-view.js");
    expect(readSidebarView()).toBe("recent");
  });
});
