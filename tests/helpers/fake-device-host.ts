// A stand-in device host (G13): one deterministic emulator farm for the devices
// route's tests, the only DeviceHost implementation until a real adb/xcrun
// integration ships. Its devices are stable, so tests assert shapes, not guesses.
import type { DeviceHost, DeviceInfo } from "../../src/server/device-host.js";

export function fakeDeviceHost(id = "fake", devices: DeviceInfo[] = [
  { id: `${id}:pixel-8`, hostId: id, name: "Pixel 8", kind: "android", status: "running" },
  { id: `${id}:iphone-16`, hostId: id, name: "iPhone 16", kind: "ios", status: "stopped" },
]): DeviceHost {
  return {
    id,
    list: async () => ({ devices }),
  };
}
