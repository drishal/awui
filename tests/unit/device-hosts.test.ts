// Device hosts (G13's interface): the read-only listing route against the fake host,
// and the refusal when none is configured. Real-device verification is outstanding.
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";
import { fakeDeviceHost } from "../helpers/fake-device-host.js";

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); });

describe("device hosts", () => {
  it("answers 404 when no host is configured", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const res = await agent.get("/api/devices");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no_device_hosts");
  });

  it("lists the fake host's devices read-only", async () => {
    t = await makeTestApp({ deviceHosts: [fakeDeviceHost()] });
    const agent = await signedIn(t);
    const res = await agent.get("/api/devices");
    expect(res.status).toBe(200);
    const hosts = res.body.hosts as Array<{ host: string; devices: Array<{ id: string; name: string; kind: string; status: string }> }>;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.host).toBe("fake");
    expect(hosts[0]?.devices).toEqual([
      { id: "fake:pixel-8", hostId: "fake", name: "Pixel 8", kind: "android", status: "running" },
      { id: "fake:iphone-16", hostId: "fake", name: "iPhone 16", kind: "ios", status: "stopped" },
    ]);
  });

  it("reports a broken host's failure as an error string, not a 500", async () => {
    const broken = fakeDeviceHost("broken");
    broken.list = async () => ({ devices: [], error: "adb is not installed" });
    t = await makeTestApp({ deviceHosts: [broken] });
    const agent = await signedIn(t);
    const res = await agent.get("/api/devices");
    expect(res.status).toBe(200);
    const hosts = res.body.hosts as Array<{ host: string; devices: unknown[]; error?: string }>;
    expect(hosts[0]?.error).toBe("adb is not installed");
    expect(hosts[0]?.devices).toEqual([]);
  });
});
