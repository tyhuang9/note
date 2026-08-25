import { describe, expect, it, vi } from "vitest";
import {
  getDocumentPositionFromTextOffset,
  resolveEditorCaretPosition,
} from "../../src/editor/caretPlacement";

function createEditorStub(
  pointPosition: number | null,
  textNodes: Array<{ position: number; text: string }> = [
    { position: 1, text: "hello" },
  ],
  documentSize = 6,
) {
  return {
    state: {
      doc: {
        content: { size: documentSize },
        descendants: (
          visitor: (
            node: { isText: boolean; text: string },
            position: number,
          ) => boolean,
        ) => {
          for (const textNode of textNodes) {
            visitor(
              { isText: true, text: textNode.text },
              textNode.position,
            );
          }
        },
      },
    },
    view: {
      posAtCoords: vi.fn(() => pointPosition === null
        ? null
        : { inside: -1, pos: pointPosition }),
    },
  };
}

describe("caret placement", () => {
  it("prefers TipTap client-coordinate placement", () => {
    const editor = createEditorStub(4);

    expect(resolveEditorCaretPosition(editor as never, {
      clientX: 250,
      clientY: 160,
      textOffset: 1,
    })).toBe(4);
    expect(editor.view.posAtCoords).toHaveBeenCalledWith({
      left: 250,
      top: 160,
    });
  });

  it("uses the DOM text offset when a transformed hit collapses to the start", () => {
    const editor = createEditorStub(1);

    expect(resolveEditorCaretPosition(editor as never, {
      clientX: 250,
      clientY: 160,
      textOffset: 3,
    })).toBe(4);
  });

  it("maps offsets across formatted text nodes and clamps beyond content", () => {
    const editor = createEditorStub(
      null,
      [
        { position: 1, text: "rich" },
        { position: 7, text: " text" },
      ],
      12,
    );

    expect(getDocumentPositionFromTextOffset(editor as never, 6)).toBe(9);
    expect(getDocumentPositionFromTextOffset(editor as never, 99)).toBe(12);
  });

  it("falls back safely to the document end when no point or offset resolves", () => {
    const editor = createEditorStub(null, [], 9);

    expect(resolveEditorCaretPosition(editor as never, {
      clientX: 10,
      clientY: 20,
    })).toBe(9);
  });
});
