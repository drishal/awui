// Chromium's CommonJS backend belongs beside the compiled binary. Bun's virtual
// module filesystem cannot resolve it as if the executable were a Node package.
// Source runs use standard Node module resolution from this file.

import { createRequire } from "node:module";
import path from "node:path";

/** Only preview's CJS package is loaded through node_modules next to the built binary. */
export function packagedRequire<T>(id: string): T {
  return createRequire(process.versions.bun ? path.join(process.execPath, "..", "load.js") : import.meta.url)(id) as T;
}
