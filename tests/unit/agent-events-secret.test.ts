// Which Pi-family `input` dialogs are drawn as masked fields: the ones that ask for a password, or say they are secret.
import { describe, expect, it } from "vitest";
import { asksForSecret } from "../../src/server/harness/agent-events.js";

describe("asksForSecret", () => {
  it("masks an input that asks for a password or passphrase, in its title, message or placeholder", () => {
    expect(asksForSecret({ method: "input", title: "sudo password required\n\nReason: install", placeholder: "" })).toBe(true);
    expect(asksForSecret({ method: "input", title: "Unlock", placeholder: "Passphrase" })).toBe(true);
    expect(asksForSecret({ method: "input", title: "Vault", message: "Enter the secret" })).toBe(true);
  });
  it("believes a request that says it is secret", () => {
    expect(asksForSecret({ method: "input", title: "Token", secret: true })).toBe(true);
  });
  it("leaves ordinary inputs and every other dialog alone", () => {
    expect(asksForSecret({ method: "input", title: "Commit message", placeholder: "Describe the change" })).toBe(false);
    expect(asksForSecret({ method: "select", title: "Enter your password" })).toBe(false);
    expect(asksForSecret({ method: "input", title: "Compass" })).toBe(false);
  });
});
