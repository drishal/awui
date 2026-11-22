// The tool-card normalizer's eval, run from a checkout:
//
//   node scripts/normalizer-eval.mjs               recorded replay, no network (as CI runs it)
//   node scripts/normalizer-eval.mjs --sweep       the same replies at 0.4–0.9 thresholds
//   node scripts/normalizer-eval.mjs --live        opt-in, spends money, needs CMD_API_KEY
//
// The scoring lives in tests/evals/normalizer-eval.ts so the replay test and this script cannot drift;
// it is TypeScript, so this file is only the launcher, loading it through the tsx dev dependency the
// repo already runs `npm run dev` with.
import { tsImport } from "tsx/esm/api";

const entry = new URL("../tests/evals/normalizer-eval.ts", import.meta.url);
const { main } = await tsImport(entry.href, import.meta.url);
process.exitCode = await main(process.argv.slice(2));
