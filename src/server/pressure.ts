// The resource-pressure sampler: the server watches its own machine (one-minute load
// per core, and the memory share) on a fixed cadence and warns after a few sustained
// high samples, recovers after more sustained low ones — each toast at most once per
// cooldown, so a flapping machine does not chatter. The decision is pure (readings in,
// verdicts out) so it is unit-tested; `PressureMonitor` holds the history and, when
// started, the interval. Nothing here touches a chat or a harness: pressure is the
// server's own condition, surfaced in /api/health, `awui doctor`, and a quiet toast on
// the overview stream.
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";

export type PressureVerdict = "warn" | "recover" | null;

export interface PressureReading {
  /** One-minute load average divided by the core count. */
  loadPerCore: number;
  /** The share of physical memory in use, 0–1. */
  memShare: number;
}

export interface PressureStatus {
  /** "warn" while the machine has been running hot for a while; "ok" otherwise. */
  state: "ok" | "warn";
  highSamples: number;
  lowSamples: number;
  /** Epoch ms of the last toast, for the cooldown. */
  lastToastAt: number | null;
}

export interface PressureLimits {
  /** Load per core past which a sample reads high (a busy machine, not a busy moment). */
  load: number;
  /** Memory share past which a sample reads high. */
  memory: number;
}

/** Tuned to a sustained problem, not a spike: one busy core among many is not pressure. */
export const DEFAULT_PRESSURE_LIMITS: PressureLimits = { load: 1.25, memory: 0.95 };

/** One sample against the limits. */
export function isHigh(reading: PressureReading, limits: PressureLimits = DEFAULT_PRESSURE_LIMITS): boolean {
  return reading.loadPerCore >= limits.load || reading.memShare >= limits.memory;
}

export interface PressureOpts {
  /** Consecutive high samples before a warning (3 at the 15 s cadence is 45 s of hot). */
  highToWarn?: number;
  /** Consecutive low samples after a warning before the recovery (6 is 90 s of cool). */
  lowToRecover?: number;
  /** No two toasts closer than this, whatever the samples do. */
  cooldownMs?: number;
}

/**
 * The history and the verdicts. `push` takes one sample and answers the toast to send,
 * if any: the third high sample warns, the sixth low one after a warning recovers, and
 * no toast repeats within the cooldown. The state change always lands; the cooldown
 * only holds the words back.
 */
export class PressureMonitor {
  private high = 0;
  private low = 0;
  private warned = false;
  private lastToastAt: number | null = null;

  constructor(
    private readonly limits: PressureLimits = DEFAULT_PRESSURE_LIMITS,
    private readonly opts: PressureOpts = {},
  ) {}

  /** A machine sample as the OS reports it right now. */
  static read(): PressureReading {
    const cores = Math.max(1, availableParallelism());
    return { loadPerCore: (loadavg()[0] ?? 0) / cores, memShare: 1 - freemem() / totalmem() };
  }

  push(reading: PressureReading, now: number): PressureVerdict {
    if (isHigh(reading, this.limits)) {
      this.high += 1;
      this.low = 0;
      if (this.warned || this.high < (this.opts.highToWarn ?? 3)) return null;
      this.warned = true;
    } else {
      this.low += 1;
      this.high = 0;
      if (!this.warned || this.low < (this.opts.lowToRecover ?? 6)) return null;
      this.warned = false;
    }
    const cooldown = this.opts.cooldownMs ?? 60_000;
    if (this.lastToastAt !== null && now - this.lastToastAt < cooldown) return null;
    this.lastToastAt = now;
    return this.warned ? "warn" : "recover";
  }

  get state(): "ok" | "warn" {
    return this.warned ? "warn" : "ok";
  }

  status(): PressureStatus {
    return { state: this.state, highSamples: this.high, lowSamples: this.low, lastToastAt: this.lastToastAt };
  }
}
