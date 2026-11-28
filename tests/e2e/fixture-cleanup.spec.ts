// A test server's own sandbox has a bounded owner. Cleanup runs after the server
// and its fake harnesses close; other test sandboxes and environment stay intact.
import { test, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { startFixture } from "./global-setup.js";

test("the E2E sandbox is removed only after its own resources close", async () => {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const previous = {
    root: process.env.AWUI_E2E_ROOT,
    herdr: process.env.AWUI_E2E_HERDR,
    opencode: process.env.AWUI_OPENCODE_STATE,
  };
  let base: string | undefined;
  try {
    const cleanup = await startFixture(port);
    base = dirname(process.env.AWUI_E2E_ROOT!);
    expect(existsSync(base)).toBe(true);
    await cleanup();
  } finally {
    if (previous.root === undefined) delete process.env.AWUI_E2E_ROOT;
    else process.env.AWUI_E2E_ROOT = previous.root;
    if (previous.herdr === undefined) delete process.env.AWUI_E2E_HERDR;
    else process.env.AWUI_E2E_HERDR = previous.herdr;
    if (previous.opencode === undefined) delete process.env.AWUI_OPENCODE_STATE;
    else process.env.AWUI_OPENCODE_STATE = previous.opencode;
  }
  expect(base).toBeDefined();
  expect(existsSync(base!)).toBe(false);
});

test("a rejected startup removes its own sandbox too", async () => {
  const roots = () => readdirSync(tmpdir()).filter(name => name.startsWith("awui-e2e-")).sort();
  const before = roots();
  // PORT has a documented 1024 minimum. This child exits before any agent starts.
  await expect(startFixture(80)).rejects.toThrow();
  expect(roots()).toEqual(before);
});
