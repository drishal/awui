#!/usr/bin/env node
// A deterministic gh for the terminal clients' GitHub tests: the record is
// test-owned (a JSON file named by AWUI_GH_FIXTURE), and every write call is
// appended to AWUI_GH_CALLS when that is set, so a test can assert what the
// client asked gh to do without any network call.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const fixturePath = process.env.AWUI_GH_FIXTURE;
if (!fixturePath) throw new Error("AWUI_GH_FIXTURE is required");
const record = JSON.parse(readFileSync(fixturePath, "utf8"));
const calls = process.env.AWUI_GH_CALLS;
// The calls logged before this one: a create's URL number counts them, so the append must come after.
const priorCreates = calls && existsSync(calls) && readFileSync(calls, "utf8").trim() !== "" ? readFileSync(calls, "utf8").trim().split("\n").filter((l) => l.includes("create")).length : 0;
if (calls) appendFileSync(calls, `${JSON.stringify(args)}\n`);
const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (args.includes("--version")) process.stdout.write("gh version 2.75.0\n");
else if (args[0] === "auth" && args[1] === "status") process.exit(0);
else if (args[0] === "pr" && args[1] === "checks") reply(record.checks ?? []);
else if (args[0] === "pr" && args[1] === "view") {
  const number = args.find((a, i) => args[i - 1] === "view" && /^\d+$/.test(a));
  const fields = String(args[args.indexOf("--json") + 1]).split(",");
  const pr = number ? (record.prs ?? {})[number] : record.current;
  if (!pr) fail(`no pull request ${number ?? "for this branch"} in the fixture`);
  reply(Object.fromEntries(fields.filter((key) => key in pr).map((key) => [key, pr[key]])));
} else if (args[0] === "pr" && args[1] === "diff") process.stdout.write(record.diff ?? "");
else if (args[0] === "pr" && args[1] === "create") {
  // gh's own shape: a progress line, then the URL alone on its line (the server takes the last URL line).
  process.stdout.write(`Creating pull request for the checked-out branch...\nhttps://github.com/acme/repo/pull/${(record.nextPr ?? 10) + priorCreates}\n`);
} else if (args[0] === "pr" && args[1] === "merge") process.exit(0);
else fail(`unsupported gh invocation: ${args.join(" ")}`);
