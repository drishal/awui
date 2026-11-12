import { describe, expect, it, vi } from "vitest";
import { makeTestApp } from "../helpers/app.js";
import type { HarnessAdapter, LiveChat } from "../../src/server/harness/types.js";

describe("native /session pin", () => {
  it("acts on its current child with the id chosen from its own provider pool", async () => {
    const t = await makeTestApp();
    const fake = t.registry.get("fake") as HarnessAdapter & { accounts?: () => Promise<Array<{ provider: string; index: number; id: string; supported: boolean }>> };
    const orig = fake.openChat.bind(fake);
    const pin = vi.fn(async (_index: number) => {});
    fake.openChat = async req => {
      const child: LiveChat = await orig(req);
      child.pinAccount = pin;
      return child;
    };
    fake.accounts = async () => [{ provider: "fake", index: 2, id: "fake:2", supported: true }];
    const chat = await t.manager.create(fake, await t.workspaces.open(t.project));
    expect(chat.supportsAccountSelection()).toBe(true);
    await chat.pinAccount("fake:2");
    expect(pin).toHaveBeenCalledWith(2);
  });
});
