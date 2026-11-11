// The orchestration surface's bounds in one place: the built-in defaults, and the shape
// config.yml's `orchestration:` block fills in (config.ts). Everything that counts — depth,
// children, tasks, the wall clock, calls and wakes — reads the effective set through the
// orchestrator's deps instead of a module constant, so a change in the file applies without a
// restart. This module imports nothing: the settings schema, the server config, and the
// orchestrator all load it without pulling a chat or a harness behind it.
export interface OrchestrationLimits {
  /** False: no chat is given the tools, and every call answers orch_off. */
  enabled: boolean;
  /** Tasks one chat may run at once. */
  maxChildrenPerChat: number;
  /** Tasks one chat may ever start (finished ones count). */
  maxTasksPerChat: number;
  /** Tasks this server runs at once, across chats. */
  maxLiveTasks: number;
  /** Delegation depth: 2 lets a child delegate once, and stops at grandchildren. */
  maxDepth: number;
  /** A task still working after this is stopped and recorded failed. */
  taskWallClockMs: number;
  /** Wake a parent's agent with a finished child's result. */
  wakeParents: boolean;
  /** Wake prompts one parent may receive in an hour. */
  maxWakesPerHour: number;
  /** Tool calls one chat may make in a minute. */
  callsPerMinute: number;
}

export const DEFAULT_ORCHESTRATION_LIMITS: OrchestrationLimits = {
  enabled: true,
  maxChildrenPerChat: 4,
  maxTasksPerChat: 32,
  maxLiveTasks: 12,
  maxDepth: 2,
  taskWallClockMs: 2_700_000,
  wakeParents: true,
  maxWakesPerHour: 20,
  callsPerMinute: 60,
};
