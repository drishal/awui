// The board's worker row: role, host and model name the seat and stay whole; the title takes what is left, clipped at its end.
import { describe, expect, it } from "vitest";
import { workerRow } from "../../src/atui/worker-row.js";

describe("workerRow", () => {
  const worker = { title: "Reply with the word child exactly", role: "test", host: null, model: "fake/echo", state: "" };
  it("keeps everything when it fits", () => {
    expect(workerRow(worker, 60)).toMatchObject({ title: "Reply with the word child exactly", role: "test", model: "fake/echo" });
  });
  it("keeps the role and model whole and clips the title at its end", () => {
    const row = workerRow(worker, 40);
    expect(row).toMatchObject({ role: "test", model: "fake/echo" });
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.title.length + 3 + row.role.length + 3 + row.model.length + 2).toBeLessThanOrEqual(40);
  });
  it("lets the model and host go before the title is squeezed to a stub, while the role stays named", () => {
    const row = workerRow(worker, 30);
    expect(row).toMatchObject({ role: "test", model: "" });
    expect(row.title.length).toBeGreaterThanOrEqual(10);
    expect(workerRow({ ...worker, host: "laptop" }, 24)).toMatchObject({ role: "test", host: "", model: "" });
  });
  it("drops the model first, then the host, then the role, only when the facts themselves do not fit", () => {
    expect(workerRow(worker, 10)).toMatchObject({ role: "test", model: "" });
    expect(workerRow({ ...worker, host: "laptop" }, 10)).toMatchObject({ role: "test", host: "", model: "" });
    expect(workerRow(worker, 4)).toMatchObject({ role: "", model: "" });
  });
  it("keeps the state words", () => {
    expect(workerRow({ ...worker, state: " needs you" }, 40).state).toBe(" needs you");
  });
});
