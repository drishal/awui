// The mesh attach daemon (P1.5): the running awui service is also the mesh's
// target. While config.yml has the mesh on, one Unix socket accepts peer
// links; each one runs the P1 serve() loop with this service's identity,
// name, pins, policy getters, audit log, and a TaskHost whose tasks outlive
// the link that opened them. The socket follows the mesh switch without a
// restart — the config getter is polled the way the rest of the server
// re-reads config.yml (at most every 2 s), and turning the mesh off closes
// the listener and every attached link. Host tasks are never persisted: they
// die with the service, and a leader reconnecting after a restart gets a
// closed link and a not_found, exactly as the docs say.
import { socketPath, startAttachListener, type AttachForced, type AttachLink, type AttachListener } from "./attach.js";
import type { AuditLog } from "./audit.js";
import type { TaskHost } from "./host.js";
import type { NodeIdentity } from "./identity.js";
import type { PinStore } from "./pins.js";
import { serve, type ServeDeps } from "./serve.js";
import type { HarnessRegistry } from "../harness/registry.js";
import type { MeshConfig } from "../user-config.js";

export interface MeshAttachDeps {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  /** The node's mesh identity, loaded once on the first link that needs it. */
  identity: () => Promise<NodeIdentity>;
  /** This node's mesh name, what the client pins beside the key. */
  name: () => string;
  pins: PinStore;
  audit: AuditLog;
  registry: Pick<HarnessRegistry, "get" | "available">;
  /** The mesh block as config.yml has it now; re-read by the caller, cached. */
  config: () => MeshConfig | undefined;
  enabled: () => boolean;
  home: string;
  /** What makes this daemon mode: tasks the host owns survive a link's close. */
  host: TaskHost;
  log?: (message: string) => void;
}

export interface MeshAttachHandle {
  /** Stops the poll, closes the listener, and with it every attached link. */
  stop(): void;
}

/**
 * Starts the attach side of the mesh against a running service and follows
 * the mesh switch for the life of that service. Inert by construction: with
 * the mesh off no socket exists, and a start that is refused (a foreign file
 * at the path, another awui already listening) stays refused until the mesh
 * is turned off and on again, so a person sees one log line, not one per tick.
 */
export function startMeshAttach(deps: MeshAttachDeps): MeshAttachHandle {
  const log = deps.log ?? (() => undefined);
  let identity: Promise<NodeIdentity> | null = null;
  let listener: AttachListener | null = null;
  /** The mesh was on at the last poll: a failed start only retries after a full off/on cycle. */
  let wanted = false;
  let stopped = false;

  const onLink = (link: AttachLink, forced: AttachForced): void => {
    void (async () => {
      let who: NodeIdentity;
      try {
        who = await (identity ??= deps.identity());
      } catch (error) {
        log(`an attached link could not load the mesh identity: ${error instanceof Error ? error.message : String(error)}`);
        link.input.destroy();
        link.output.end();
        return;
      }
      // The P1 serve loop over the link: preamble, signed handshake, then the
      // method table, every call held to the inbound policy resolved fresh.
      // `forced` is the prologue's pair, the authorized_keys ceiling; `host` is
      // what makes the tasks this link opens outlive it.
      const served = serve({ input: link.input, output: link.output }, {
        identity: who,
        name: deps.name(),
        pins: deps.pins,
        audit: deps.audit,
        registry: deps.registry,
        config: deps.config,
        enabled: deps.enabled,
        home: deps.home,
        host: deps.host,
        ...(forced !== null ? { forced } : {}),
        log,
      } satisfies ServeDeps);
      void served.closed.then((reason) => {
        if (reason !== "eof" && reason !== "closed") log(`an attached link ended: ${reason}`);
      });
    })();
  };

  const start = (): void => {
    void (async () => {
      let at: string;
      try {
        at = await socketPath(deps.env, deps.stateDir);
      } catch (error) {
        log(`the attach socket path could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (stopped) return;
      const made = startAttachListener({ path: at, onLink, log });
      if (stopped) made.close();
      else listener = made;
    })();
  };

  const stopListener = (): void => {
    listener?.close();
    listener = null;
  };

  const poll = (): void => {
    if (stopped) return;
    const on = deps.enabled();
    if (on && !wanted) {
      wanted = true;
      start();
    } else if (!on && wanted) {
      wanted = false;
      stopListener();
      // Off is off for the whole node: the host's tasks end too, running or detached.
      void Promise.resolve(deps.host.disposeAll("the mesh was turned off")).catch(() => undefined);
    }
  };
  poll();
  const timer = setInterval(poll, 2000);
  timer.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      stopListener();
    },
  };
}
