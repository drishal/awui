// Device hosts (G13's interface): an emulator or simulator farm a future terminal
// surface could drive. The interface is the whole of this slice: one host lists its
// devices, and a device can be probed read-only. Nothing here starts one, and no
// real adb/xcrun integration ships yet — the fake host (tests/helpers) is the only
// implementation, and real-device verification is documented as outstanding
// (docs/architecture.md, docs/testing.md).
export interface DeviceInfo {
  /** Opaque host-scoped id: `<hostId>:<device>`, never a serial the client could mistype. */
  id: string;
  /** The host that holds it (config.yml's own hosts today, one fake in tests). */
  hostId: string;
  /** A human label the host reports ("Pixel 8", "iPhone 16"). */
  name: string;
  /** "android" | "ios" | "custom" — what the host says it is, nothing is inferred. */
  kind: string;
  /** The host's own words about state (running, stopped); not normalised here. */
  status: string;
}

/** One device host: lists what it holds and answers a bounded read-only probe. */
export interface DeviceHost {
  /** The host's id in config.yml's `hosts:` (or `fake` in tests). */
  readonly id: string;
  /** What the host holds right now; a broken host reports the failure as an error string. */
  list(): Promise<{ devices: DeviceInfo[]; error?: string }>;
}
