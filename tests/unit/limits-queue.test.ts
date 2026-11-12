import { describe, expect, it, vi } from "vitest";
import { makeTestApp } from "../helpers/app.js";
import type { HarnessAdapter, HarnessEvent, LiveChat } from "../../src/server/harness/types.js";

const report = (healthy: boolean): HarnessEvent => ({
  type: "limits",
  account: { id: "xai-oauth:0", source: "omp", provider: "xai-oauth", limited: !healthy, at: Date.now(), windows: [] },
});

describe("provider-account lifecycle", () => {
  it("only recovers queued work for the matching reported harness source", async () => {
    const app = await makeTestApp();
    const adapter = app.registry.get("fake")!;
    const ws = await app.workspaces.open(app.project);
    const native = await app.manager.create(adapter, ws);
    native.setChain([{ id: "next", kind: "send", text: "stored while exhausted" }]);
    native.apply(report(false));
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(native.snapshot().chain).toHaveLength(1);
    native.apply(report(true));
    await vi.waitFor(() => expect(native.snapshot().chain.length).toBe(0));
  });

  it("uses this live session’s native pin, not a new child or a global preference override", async () => {
    const app = await makeTestApp();
    const adapter = app.registry.get("fake") as HarnessAdapter & { accounts?(cwd: string): Promise<Array<{ provider: string; index: number; id: string; supported: boolean }>>; };
    const open = adapter.openChat.bind(adapter);
    let child: LiveChat | null = null;
    const pin = vi.fn(async (_index: number) => {});
    adapter.openChat = async req => {
      child = await open(req);
      child.pinAccount = pin;
      return child;
    };
    adapter.accounts = async () => [{ provider: "fake", index: 2, id: "fake:2", supported: true }];
    const ws = await app.workspaces.open(app.project);
    const chat = await app.manager.create(adapter, ws);
    await chat.pinAccount("fake:2");
    await expect(chat.pinAccount("other-provider:2")).rejects.toThrowError();
    expect(pin).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledWith(2);
  });

  it("blocks an id from a different provider before reaching a live command", async () => {
    const app = await makeTestApp();
    const adapter = app.registry.get("fake")!;
    adapter.accounts = async () => [{ provider: "fake", index: 2, id: "fake:2", supported: true }];
    const ws = await app.workspaces.open(app.project);
    const chat = await app.manager.create(adapter, ws);
    await expect(chat.pinAccount("xai-oauth:2")).rejects.toThrow(/This session cannot choose/);
  });
});
