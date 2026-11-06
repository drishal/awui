// The terminal clients the compiled awui binary carries, as the `awui:clients`
// module (scripts/build-binary.ts bundles this file with OpenTUI's Solid
// transform; src/server/clients.ts runs one by the command line).
export { main as atui } from "./main.js";
export { main as tern } from "../tern/main.js";
