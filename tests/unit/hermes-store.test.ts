import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesAdapter } from "../../src/server/harness/hermes.js";
import { tempDir } from "../helpers/app.js";

// readTranscript's fast path: a plain session answers from the home's own state.db (about a
// millisecond) instead of a gateway attach (measured tenths of a second per session). No gateway
// runs here, and the launcher points nowhere, so a transcript can only come from the store.
const savedHome = process.env.HERMES_HOME;
let home: string;
let project: string;
let other: string;
let adapter: HermesAdapter;

beforeEach(() => {
  home = tempDir("awui-hermes-store-");
  project = path.join(home, "proj");
  other = path.join(home, "other");
  mkdirSync(project);
  mkdirSync(other);
  process.env.HERMES_HOME = home;
  adapter = new HermesAdapter({ launcher: path.join(home, "no-such-hermes") });
  const db = new DatabaseSync(path.join(home, "state.db"));
  // The columns of Hermes's own messages table this read touches.
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, parent_session_id TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_name TEXT,
      tool_call_id TEXT, tool_calls TEXT, reasoning TEXT, timestamp REAL, active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0, display_kind TEXT, display_metadata TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0,
      codex_message_items TEXT)`);
  const session = db.prepare("INSERT INTO sessions (id, cwd, title, parent_session_id) VALUES (?, ?, ?, ?)");
  const message = db.prepare(
    "INSERT INTO messages (session_id, role, content, tool_name, tool_call_id, tool_calls, reasoning, timestamp, display_kind, compacted, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  session.run("plain", project, "A plain chat", null);
  message.run("plain", "user", "what is in notes.txt?", null, null, null, null, 1_700_000_000, null, 0, 1);
  message.run(
    "plain",
    "assistant",
    "",
    null,
    null,
    // A tool call's arguments live on the assistant row, as Hermes stores them.
    JSON.stringify([{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/notes.txt"}' } }]),
    "the file is short",
    1_700_000_001,
    null,
    0,
    1,
  );
  message.run("plain", "tool", "short file", "read_file", "call_1", null, null, 1_700_000_002, null, 0, 1);
  // A steer row, a folded (compacted) row, and a lineage child: the gateway's display projection
  // reshapes each of them, so they are not this read's to answer.
  for (const [id, kind] of [["steered", "steer"], ["folded", null], ["child", null]] as const) {
    session.run(id, project, `A ${id} chat`, id === "child" ? "plain" : null);
    message.run(id, "user", "a prompt", null, null, null, null, 1_700_000_000, kind, id === "folded" ? 1 : 0, 1);
  }
  db.close();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
});

describe("a session read from the home's store", () => {
  it("answers a plain chat without a gateway, with its tool call named and argued", async () => {
    const transcript = await adapter.readTranscript({ cwd: project, nativeId: "plain" });
    expect(transcript?.title).toBe("A plain chat");
    expect(transcript?.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
    expect(transcript?.items.find((item) => item.kind === "user")).toMatchObject({ text: "what is in notes.txt?" });
    expect(transcript?.items.find((item) => item.kind === "assistant")).toMatchObject({ text: "", thinking: "the file is short" });
    expect(transcript?.items.find((item) => item.kind === "tool")).toMatchObject({
      name: "read_file",
      args: '{\n  "path": "/tmp/notes.txt"\n}',
      summary: "/tmp/notes.txt",
      paths: ["/tmp/notes.txt"],
      status: "done",
      output: "short file",
    });
  });

  it("still refuses a session that belongs to another folder", async () => {
    expect(await adapter.readTranscript({ cwd: other, nativeId: "plain" })).toBeNull();
  });

  it("leaves a typed, folded, or lineage session to the gateway", async () => {
    for (const nativeId of ["steered", "folded", "child"]) {
      expect(await adapter.readTranscript({ cwd: project, nativeId })).toBeNull();
    }
  });
});
