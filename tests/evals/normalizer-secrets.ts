// The secrets the redaction promises to strip, as the eval and the tests probe for them.
//
// Each entry is a literal that appears in a fixture's output and must never appear in a request
// body: the egress test asserts it against the real `buildEgressState` → `fetch` path, and the
// replay run counts any body that still carries one (`leaks`, which must be 0).
export const SECRET_PROBES: readonly string[] = [
  // a GitHub token, and the same one behind an `Authorization: Bearer` line
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  // a URL's password
  "hunter2",
  // an OpenAI-shaped key
  "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  // a PEM block's body
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
];
