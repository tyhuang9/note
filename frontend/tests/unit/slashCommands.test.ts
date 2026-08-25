import { describe, expect, it } from "vitest";
import {
  getSlashCommandItems,
  slashCommands,
} from "../../src/editor/slashCommands";

describe("slash command registry", () => {
  it("keeps the complete command list in its authored group order", () => {
    expect(slashCommands.map((command) => command.id)).toEqual([
      "paragraph",
      "heading1",
      "heading2",
      "heading3",
      "bulletList",
      "orderedList",
      "blockquote",
      "codeBlock",
      "horizontalRule",
    ]);
  });

  it("normalizes query whitespace and ranks exact matches before aliases", () => {
    expect(getSlashCommandItems("  H1 ")[0]?.id).toBe("heading1");
    expect(getSlashCommandItems("  paragraph ")[0]?.id).toBe("paragraph");
    expect(getSlashCommandItems("divider")[0]?.id).toBe("horizontalRule");
  });

  it("returns no commands for an unmatched query", () => {
    expect(getSlashCommandItems("does-not-exist")).toEqual([]);
  });
});
