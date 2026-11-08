import { describe, expect, it } from "vitest";
import { endpointFromResolved, grantFromAttach, verdictFromIdentify, verdictFromResolve } from "../../src/server/harness/hermes-gateway.js";

const HOME = "/home/someone/.hermes";

const resolved = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  resolve_protocol: 1,
  state: "ready",
  reason_code: "ready",
  attachable: true,
  update_fenced: false,
  control: "self",
  install_code_sha: "aaaa1111",
  endpoint: {
    profile_id: HOME,
    instance_id: "instance-1",
    capabilities: ["session-authority-v1"],
    code_version: "0.24.0",
    code_sha: "bbbb2222",
    api_origin: "http://127.0.0.1:40233",
    ws_url: "ws://127.0.0.1:40233/api/ws",
    ws_protocol: "hermes-gateway-v1",
    ticket_protocol_prefix: "hermes-gateway-ticket.",
  },
  ...overrides,
});

describe("gatewayVerdict's decoding of resolve-profile", () => {
  it("takes the endpoint the owner names, with the URL and protocols it dials with", () => {
    const verdict = verdictFromResolve(resolved());
    expect(verdict).toMatchObject({ state: "ready", attachable: true, legacy: false, installCodeSha: "aaaa1111" });
    expect(verdict.endpoint).toEqual({
      apiOrigin: "http://127.0.0.1:40233",
      profileId: HOME,
      instanceId: "instance-1",
      wsUrl: "ws://127.0.0.1:40233/api/ws",
      wsProtocol: "hermes-gateway-v1",
      ticketPrefix: "hermes-gateway-ticket.",
      version: "0.24.0",
      codeSha: "bbbb2222",
    });
  });

  it("derives the origin from the WebSocket URL when the owner names no api_origin", () => {
    const endpoint = endpointFromResolved({ profile_id: HOME, instance_id: "i", ws_url: "ws://127.0.0.1:5000/api/ws" });
    expect(endpoint?.apiOrigin).toBe("http://127.0.0.1:5000");
  });

  it("refuses an endpoint that is not loopback, and says the owner named nothing to dial", () => {
    const verdict = verdictFromResolve(resolved({ endpoint: { profile_id: HOME, instance_id: "i", api_origin: "http://10.0.0.5:1", ws_url: "ws://10.0.0.5:1/api/ws" } }));
    expect(verdict.attachable).toBe(false);
    expect(verdict.endpoint).toBeNull();
    expect(verdict.message).toContain("no endpoint to dial");
  });

  it("keeps the owner's verdict when it cannot be attached to", () => {
    const verdict = verdictFromResolve(resolved({ state: "incompatible", reason_code: "update_fenced", attachable: false, update_fenced: true, endpoint: null, message: "gateway incompatible: update_fenced" }));
    expect(verdict).toMatchObject({ state: "incompatible", reasonCode: "update_fenced", attachable: false, updateFenced: true, endpoint: null });
    expect(verdict.message).toBe("gateway incompatible: update_fenced");
  });
});

describe("grantFromAttach (hermes gateway attach --json)", () => {
  // The shape the real command prints, from a live install (the ticket is a credential).
  const grant = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      state: "ready",
      reason_code: null,
      detail: null,
      client_code_sha: "dddd4444",
      url: "ws://127.0.0.1:61975/api/ws",
      protocol: "hermes-gateway-v1",
      protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.TICKET"],
      ticket: "TICKET",
      endpoint: {
        profile_id: HOME,
        instance_id: "instance-1",
        api_origin: "http://127.0.0.1:61975",
        code_sha: "eeee5555",
        runtime_protocol: 1,
        capabilities: ["session-authority-v1"],
        control_home: null,
        supervisor: "systemd",
      },
      ...overrides,
    });

  it("reads the URL, the protocols and the endpoint it names", () => {
    const parsed = grantFromAttach(grant());
    expect(parsed).toMatchObject({ url: "ws://127.0.0.1:61975/api/ws", ticket: "TICKET", protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.TICKET"], clientCodeSha: "dddd4444" });
    expect(parsed?.endpoint).toMatchObject({ profileId: HOME, instanceId: "instance-1", apiOrigin: "http://127.0.0.1:61975", wsUrl: "ws://127.0.0.1:61975/api/ws", wsProtocol: "hermes-gateway-v1", codeSha: "eeee5555" });
  });

  it("refuses a verdict that is not attachable, and an endpoint that is not loopback", () => {
    expect(grantFromAttach(grant({ state: "absent", url: null, ticket: null, protocols: [] }))).toBeNull();
    expect(grantFromAttach(grant({ url: "ws://10.0.0.5:61975/api/ws" }))).toBeNull();
    expect(grantFromAttach(grant({ ticket: "" }))).toBeNull();
    expect(grantFromAttach("not json")).toBeNull();
  });
});

describe("gatewayVerdict's decoding of identify (Hermes 0.23 and earlier)", () => {
  const identity = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    runtime_protocol: 1,
    state: "ready",
    served_profiles: [{ profile_id: HOME, home: HOME }],
    capabilities: ["session-authority-v1"],
    instance_id: "instance-1",
    api_origin: "http://127.0.0.1:40233",
    code_version: "0.23.0",
    code_sha: "cccc3333",
    ...overrides,
  });

  it("attaches to a ready owner that serves this home", () => {
    const verdict = verdictFromIdentify(identity(), HOME);
    expect(verdict).toMatchObject({ state: "ready", attachable: true, legacy: true });
    expect(verdict.endpoint).toMatchObject({ apiOrigin: "http://127.0.0.1:40233", version: "0.23.0", instanceId: "instance-1" });
  });

  it("does not attach to an owner that serves another home, and names its state", () => {
    const verdict = verdictFromIdentify(identity({ served_profiles: [{ profile_id: "/home/someone/.hermes-work", home: "/home/someone/.hermes-work" }] }), HOME);
    expect(verdict).toMatchObject({ state: "ready", attachable: false, endpoint: null, legacy: true });
    expect(verdict.message).toBe("gateway ready: ready");
  });

  it("does not attach to an owner that is still starting", () => {
    expect(verdictFromIdentify(identity({ state: "starting" }), HOME)).toMatchObject({ state: "starting", attachable: false, endpoint: null });
  });

  it("does not attach without the session authority", () => {
    expect(verdictFromIdentify(identity({ capabilities: [] }), HOME).attachable).toBe(false);
  });
});
