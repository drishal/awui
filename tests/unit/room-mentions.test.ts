import { describe, expect, it } from "vitest";
import type { RoomMemberView } from "../../src/shared/protocol.js";
import { handleFrom, insertMention, matchMembers, mentionRange, mentionTokens, resolveMentions } from "../../src/web/room-mentions.js";

const member = (id: string, handle: string, extra: Partial<RoomMemberView> = {}): RoomMemberView => ({
  id,
  botId: `bot-${id}`,
  name: handle.toUpperCase(),
  handle,
  rank: 0,
  canLead: true,
  consultable: true,
  consultants: [],
  enabled: true,
  accent: null,
  harnessId: "pi",
  model: null,
  thinkingLevel: null,
  role: "",
  permissionMode: null,
  ...extra,
});

const roster = [
  member("m1", "atlas", { rank: 0 }),
  member("m2", "scout", { rank: 1 }),
  member("m3", "skeptic", { rank: 2 }),
  member("m4", "off", { rank: 3, enabled: false }),
];

describe("mentionRange", () => {
  it("finds the mention at the start of a draft", () => {
    expect(mentionRange("@sc", 3)).toEqual({ start: 0, end: 3, query: "sc" });
  });

  it("finds one after whitespace, whatever the caret does deeper in the word", () => {
    expect(mentionRange("compare @ske", 12)).toEqual({ start: 8, end: 12, query: "ske" });
    expect(mentionRange("compare @ske", 9)).toEqual({ start: 8, end: 9, query: "" });
  });

  it("does not open inside an address or a word", () => {
    expect(mentionRange("me@example.com", 14)).toBeNull();
    expect(mentionRange("a@b", 3)).toBeNull();
    expect(mentionRange("done@", 5)).toBeNull();
  });

  it("does not open after punctuation", () => {
    expect(mentionRange("(@scout)", 7)).toBeNull();
  });

  it("gives up once what was typed cannot be a handle", () => {
    expect(mentionRange("@scout more", 11)).toBeNull();
    expect(mentionRange(`@${"a".repeat(40)}`, 41)).toBeNull();
  });

  it("opens on a bare @ after whitespace", () => {
    expect(mentionRange("hi @", 4)).toEqual({ start: 3, end: 4, query: "" });
  });
});

describe("matchMembers", () => {
  it("matches prefixes case-insensitively, in rank order", () => {
    expect(matchMembers(roster, "s").map((m) => m.handle)).toEqual(["scout", "skeptic"]);
    expect(matchMembers(roster, "SC").map((m) => m.handle)).toEqual(["scout"]);
  });

  it("offers every enabled member for an empty query, and never a disabled one", () => {
    expect(matchMembers(roster, "").map((m) => m.handle)).toEqual(["atlas", "scout", "skeptic"]);
    expect(matchMembers(roster, "off")).toEqual([]);
  });

  it("breaks rank ties by member id", () => {
    const tied = [member("z", "zulu", { rank: 1 }), member("a", "alpha", { rank: 1 })];
    expect(matchMembers(tied, "").map((m) => m.id)).toEqual(["a", "z"]);
  });
});

describe("insertMention", () => {
  it("replaces what was typed and leaves the caret after a space", () => {
    const range = mentionRange("@sc", 3);
    if (!range) throw new Error("no range");
    expect(insertMention("@sc", range, "scout")).toEqual({ text: "@scout ", caret: 7 });
  });

  it("does not double the space when one is already there", () => {
    const text = "ask @sc and wait";
    const range = mentionRange(text, 7);
    if (!range) throw new Error("no range");
    expect(insertMention(text, range, "scout")).toEqual({ text: "ask @scout and wait", caret: 10 });
  });
});

describe("mentionTokens", () => {
  it("finds handles at a start or after whitespace only", () => {
    expect(mentionTokens("@atlas and @skeptic, not me@home.com").map((t) => t.handle)).toEqual(["atlas", "skeptic"]);
  });

  it("reports where each token sits", () => {
    expect(mentionTokens("x @a")).toEqual([{ handle: "a", start: 2, end: 4 }]);
  });
});

describe("resolveMentions", () => {
  it("turns handles into ids in room rank order, whatever order they were typed", () => {
    expect(resolveMentions("@skeptic @atlas compare", roster)).toEqual({ ids: ["m1", "m3"], unknown: [] });
  });

  it("is case-insensitive and collapses duplicates", () => {
    const handles = Array.from({ length: 24 }, () => "@Atlas").join(" ");
    expect(resolveMentions(handles, roster)).toEqual({ ids: ["m1"], unknown: [] });
  });

  it("reports handles nobody in the room has, and handles of disabled members", () => {
    expect(resolveMentions("@ghost @off", roster)).toEqual({ ids: [], unknown: ["ghost", "off"] });
  });

  it("is empty for a bare message (the lead is the server's choice, not a mention)", () => {
    expect(resolveMentions("hello room", roster)).toEqual({ ids: [], unknown: [] });
  });
});

describe("handleFrom", () => {
  it("makes a safe handle from a name", () => {
    expect(handleFrom("Atlas Prime")).toBe("atlas-prime");
    expect(handleFrom("  Scout!! ")).toBe("scout");
  });

  it("falls back rather than making an empty handle", () => {
    expect(handleFrom("!!!")).toBe("bot");
  });

  it("keeps the handle within the wire's length", () => {
    expect(handleFrom("a".repeat(60)).length).toBe(32);
  });
});
