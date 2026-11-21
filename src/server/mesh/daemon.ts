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
import { ApprovalQueue } from "./approvals.js";
import { socketPath, startAttachListener, type AttachForced, type AttachLink, type AttachListener } from "./attach.js";
import type { AuditLog } from "./audit.js";
import { ensureTlsCertificate } from "./cert.js";
import type { TaskHost } from "./host.js";
import type { NodeIdentity } from "./identity.js";
import { InviteStore } from "./pairing.js";
import type { PinStore } from "./pins.js";
import { serve, type ServeDeps } from "./serve.js";
import { startTlsListener, type TlsListener, type TlsMeshLink } from "./tls.js";
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
  /** The service's shared ask-approval queue (P2 §2): every attached link waits on this one. */
  readonly approvals: ApprovalQueue;
  /** The service's live invites (P2 §3): `local.invite.create` mints from this one store. */
  readonly invites: InviteStore;
}

/** The running service's approval queue, for the owner-facing routes and UI (P2 §4); null when no daemon is attached. */
let currentApprovals: ApprovalQueue | null = null;
/** The running service's invite store, same reach as the approval queue above. */
let currentInvites: InviteStore | null = null;

/**
 * The one service-level pair of P2 stores, shared by every daemon this process
 * runs (the attach socket and the TLS listener both serve links, and a card or
 * an invite must not depend on which of the two the peer arrived through).
 * Acquired by each daemon at start and released at its stop; the globals above
 * clear only when the last holder is gone.
 */
interface ServiceStores {
  approvals: ApprovalQueue;
  invites: InviteStore;
  users: number;
}

let serviceStores: ServiceStores | null = null;

function acquireStores(): ServiceStores {
  if (serviceStores === null) serviceStores = { approvals: new ApprovalQueue(), invites: new InviteStore(), users: 0 };
  serviceStores.users++;
  currentApprovals = serviceStores.approvals;
  currentInvites = serviceStores.invites;
  return serviceStores;
}

function releaseStores(stores: ServiceStores): void {
  stores.users--;
  if (stores.users <= 0 && serviceStores === stores) {
    serviceStores = null;
    currentApprovals = null;
    currentInvites = null;
  }
}

/** The mesh attach daemon's shared ask-approval queue, or null when no service has attached the mesh. */
export function meshApprovalQueue(): ApprovalQueue | null {
  return currentApprovals;
}

/** The mesh attach daemon's invite store, or null when no service has attached the mesh. */
export function meshInviteStore(): InviteStore | null {
  return currentInvites;
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
  // The two P2 stores are the service's, not a link's: every attached link and
  // the owner-facing CLI/REST surfaces see the same pending cards and invites —
  // and so does the TLS listener, which shares the same pair.
  const stores = acquireStores();
  const approvals = stores.approvals;
  const invites = stores.invites;
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
        approvals,
        invites,
        // The attach socket is this uid's and the prologue is trusted exactly as
        // the CLI is (P1.5), so its links may serve the owner's local.* methods.
        origin: "attach",
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
    approvals,
    invites,
    stop(): void {
      stopped = true;
      clearInterval(timer);
      stopListener();
      releaseStores(stores);
    },
  };
}

export interface MeshTlsDeps {
  stateDir: string;
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
  /**
   * config.yml's `mesh.listen` (default port applied): while it names an
   * address and the mesh is on, the TLS listener answers peers on it. Null —
   * or the mesh off — is no listener at all, exactly as before P2.
   */
  listen: () => { host: string; port: number } | null;
  log?: (message: string) => void;
}

/**
 * The direct TLS listener (P2), following the attach socket's shape exactly:
 * the same 2 s poll of config.yml, a start on the mesh's rising edge, a close
 * on the falling one, and a refused start (port taken, key unreadable) that
 * stays refused until the mesh is turned off and on again, so a person sees
 * one log line, not one per tick. Each accepted socket runs the same serve()
 * loop as the attach socket, with this service's TaskHost and no forced
 * policy (a TLS link's ceiling is the pin's, never a prologue's), and with
 * the channel binding folded into its handshake. The certificate is
 * re-checked hourly and a renewal restarts the listener with the new one.
 */
export function startMeshTls(deps: MeshTlsDeps): MeshAttachHandle {
  const log = deps.log ?? (() => undefined);
  // The same pair of P2 stores the attach socket waits on: a card raised over
  // TLS is answered from the same CLI/REST surfaces, and one invite store
  // serves both, so a join over TLS and an invite minted from the CLI agree.
  const stores = acquireStores();
  let identity: Promise<NodeIdentity> | null = null;
  let listener: TlsListener | null = null;
  /** The certificate the running listener serves; a different one is a restart. */
  let servedCert: string | null = null;
  let lastCertCheck = 0;
  /** The listener was wanted at the last poll: a failed start only retries after a full off/on cycle. */
  let wanted = false;
  let stopped = false;

  const onLink = (link: TlsMeshLink, binding: Buffer, remoteAddress: string): void => {
    void (async () => {
      let who: NodeIdentity;
      try {
        who = await (identity ??= deps.identity());
      } catch (error) {
        log(`a TLS link from ${remoteAddress} could not load the mesh identity: ${error instanceof Error ? error.message : String(error)}`);
        link.input.destroy();
        link.output.end();
        return;
      }
      // The same serve loop the attach socket runs: preamble, signed handshake
      // (binding included, which is what makes the pin MITM-proof), then the
      // method table, every call held to the inbound policy resolved fresh.
      const served = serve({ input: link.input, output: link.output }, {
        identity: who,
        name: deps.name(),
        pins: deps.pins,
        audit: deps.audit,
        registry: deps.registry,
        config: deps.config,
        enabled: deps.enabled,
        home: deps.home,
        binding,
        host: deps.host,
        approvals: stores.approvals,
        invites: stores.invites,
        // A TLS link is a peer's, never the owner's CLI: local.* stays attach-only.
        origin: "tls",
        log,
      } satisfies ServeDeps);
      // The listener lifts its 10 s deadline and the unauthenticated caps on
      // its own, at the client's peer.auth line: the serve loop keeps the
      // handshake private, and every other pre-auth misbehavior closes the
      // link within one reply anyway.
      void served.closed.then((reason) => {
        if (reason !== "eof" && reason !== "closed") log(`a TLS link from ${remoteAddress} ended: ${reason}`);
      });
    })();
  };

  const start = (): void => {
    void (async () => {
      let material: Awaited<ReturnType<typeof ensureTlsCertificate>>;
      try {
        material = await ensureTlsCertificate(deps.stateDir);
      } catch (error) {
        log(`the mesh TLS certificate could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (stopped) return;
      const at = deps.listen();
      if (at === null) return;
      const made = startTlsListener({ host: at.host, port: at.port, key: material.keyPem, cert: material.cert, onLink, log });
      if (stopped) made.close();
      else {
        listener = made;
        servedCert = material.cert;
      }
    })();
  };

  const stopListener = (): void => {
    listener?.close();
    listener = null;
    servedCert = null;
  };

  const poll = (): void => {
    if (stopped) return;
    const on = deps.enabled() && deps.listen() !== null;
    if (on && !wanted) {
      wanted = true;
      lastCertCheck = Date.now();
      start();
    } else if (!on && wanted) {
      wanted = false;
      stopListener();
    } else if (on && listener !== null && Date.now() - lastCertCheck > 60 * 60 * 1000) {
      // The certificate renews with more than 30 days left, so an hourly check
      // never serves an expired one; a renewal restarts the listener (existing
      // links keep their own TLS session and finish on their own).
      lastCertCheck = Date.now();
      void ensureTlsCertificate(deps.stateDir)
        .then((material) => {
          if (stopped || !wanted || listener === null) return;
          if (material.cert !== servedCert) {
            log("the mesh TLS certificate was renewed; restarting the listener with the new one");
            stopListener();
            start();
          }
        })
        .catch((error: unknown) => log(`the mesh TLS certificate could not be re-checked: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
  poll();
  const timer = setInterval(poll, 2000);
  timer.unref?.();

  return {
    approvals: stores.approvals,
    invites: stores.invites,
    stop(): void {
      stopped = true;
      clearInterval(timer);
      stopListener();
      releaseStores(stores);
    },
  };
}
