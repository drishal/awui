// The chat width setting as the terminal clients read it: atui's column in terminal
// characters, the Tern client's caps in CSS pixels, and the words both show for it.
import { describe, expect, it } from "vitest";
import { atuiColumn, chatWidthLabel, CHAT_WIDTHS, nextChatWidth, ternColumn } from "../../src/shared/chat-width.js";

describe("atui's column", () => {
  it("keeps the 104 characters it always drew for comfortable (and for no setting at all)", () => {
    expect(atuiColumn(null, 200)).toBe(104);
    expect(atuiColumn("comfortable", 200)).toBe(104);
  });

  it("gives wide 160, so a wide terminal still reads as a column", () => {
    expect(atuiColumn("wide", 200)).toBe(160);
    expect(atuiColumn("wide", 300)).toBe(160);
  });

  it("gives full the whole content width", () => {
    expect(atuiColumn("full", 200)).toBe(200);
    expect(atuiColumn("full", 100)).toBe(100);
  });

  it("never asks for more room than the terminal has beside the side panel", () => {
    expect(atuiColumn("comfortable", 90)).toBe(90);
    expect(atuiColumn("wide", 120)).toBe(120);
    expect(atuiColumn("wide", 0)).toBe(1);
  });
});

describe("Tern's caps", () => {
  it("keeps the sheet's 780px page and 792px dock for comfortable", () => {
    expect(ternColumn(null)).toEqual({ page: "780px", dock: "792px", recent: "560px" });
    expect(ternColumn("comfortable")).toEqual({ page: "780px", dock: "792px", recent: "560px" });
  });

  it("gives wide the web UI's 1400px column, the dock 12px wider", () => {
    expect(ternColumn("wide")).toEqual({ page: "1400px", dock: "1412px", recent: "1005px" });
  });

  it("gives full the pane", () => {
    expect(ternColumn("full")).toEqual({ page: "100%", dock: "100%", recent: "100%" });
  });
});

describe("the setting's words", () => {
  it("names each width, and comfortable for none", () => {
    expect(CHAT_WIDTHS.map((w) => chatWidthLabel(w))).toEqual(["Comfortable", "Wide", "Full"]);
    expect(chatWidthLabel(null)).toBe("Comfortable");
  });

  it("cycles comfortable, wide, full, and round again", () => {
    expect(nextChatWidth(null)).toBe("wide");
    expect(nextChatWidth("comfortable")).toBe("wide");
    expect(nextChatWidth("wide")).toBe("full");
    expect(nextChatWidth("full")).toBe("comfortable");
  });
});
