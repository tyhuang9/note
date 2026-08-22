import type { Editor } from "@tiptap/core";

export type CaretPlacementRequest = Readonly<{
  clientX: number;
  clientY: number;
  textOffset?: number | null;
}>;

type CaretPositionEditor = Pick<Editor, "state" | "view">;

type PointCaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/**
 * Resolve a text offset while the read-only rich-text DOM is still mounted.
 * TipTap's document position remains authoritative after the editor mounts;
 * this offset is only the cross-browser fallback when posAtCoords cannot
 * resolve the original client point.
 */
export function getTextOffsetAtClientPoint(
  container: HTMLElement,
  request: Pick<CaretPlacementRequest, "clientX" | "clientY">,
): number | null;
export function getTextOffsetAtClientPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  fallbackOffset: number,
): number;
export function getTextOffsetAtClientPoint(
  container: HTMLElement,
  requestOrClientX: Pick<CaretPlacementRequest, "clientX" | "clientY"> | number,
  clientY?: number,
  fallbackOffset: number | null = null,
) {
  const request = typeof requestOrClientX === "number"
    ? { clientX: requestOrClientX, clientY: clientY ?? 0 }
    : requestOrClientX;
  const ownerDocument = container.ownerDocument as PointCaretDocument;
  const caretPosition = ownerDocument.caretPositionFromPoint?.(
    request.clientX,
    request.clientY,
  );

  if (caretPosition && container.contains(caretPosition.offsetNode)) {
    return getTextOffsetFromDomPosition(
      container,
      caretPosition.offsetNode,
      caretPosition.offset,
    );
  }

  const caretRange = ownerDocument.caretRangeFromPoint?.(
    request.clientX,
    request.clientY,
  );

  if (caretRange && container.contains(caretRange.startContainer)) {
    return getTextOffsetFromDomPosition(
      container,
      caretRange.startContainer,
      caretRange.startOffset,
    );
  }

  return fallbackOffset;
}

export function getTextOffsetFromDomPosition(
  container: HTMLElement,
  caretNode: Node,
  caretOffset: number,
) {
  const ownerDocument = container.ownerDocument;
  const maximumOffset = caretNode.nodeType === 3
    ? caretNode.textContent?.length ?? 0
    : caretNode.childNodes.length;
  const range = ownerDocument.createRange();
  range.selectNodeContents(container);

  try {
    range.setEnd(
      caretNode,
      Math.max(0, Math.min(caretOffset, maximumOffset)),
    );
    return range.toString().length;
  } catch {
    return container.textContent?.length ?? 0;
  } finally {
    range.detach();
  }
}

export function getDocumentPositionFromTextOffset(
  editor: Pick<Editor, "state">,
  textOffset: number,
) {
  let remainingOffset = Math.max(0, textOffset);
  let documentPosition = 1;
  let didResolve = false;

  editor.state.doc.descendants((node, position) => {
    if (didResolve) {
      return false;
    }

    if (!node.isText) {
      return true;
    }

    const textLength = node.text?.length ?? 0;

    if (remainingOffset <= textLength) {
      documentPosition = position + remainingOffset;
      didResolve = true;
      return false;
    }

    remainingOffset -= textLength;
    return true;
  });

  return didResolve ? documentPosition : editor.state.doc.content.size;
}

/** Resolve client coordinates first, then the display-DOM offset, then end. */
export function resolveEditorCaretPosition(
  editor: CaretPositionEditor,
  request: CaretPlacementRequest | null,
  fallbackTextOffset: number | null = request?.textOffset ?? null,
) {
  const offsetPosition = fallbackTextOffset !== null
    ? getDocumentPositionFromTextOffset(editor, fallbackTextOffset)
    : null;
  const pointPosition = request
    ? editor.view.posAtCoords({
        left: request.clientX,
        top: request.clientY,
      })?.pos ?? null
    : null;

  if (pointPosition !== null) {
    // Some browsers return the document start for a transformed DOM hit even
    // when their read-only caret API found a meaningful character offset.
    if (pointPosition <= 1 && offsetPosition !== null && offsetPosition > 1) {
      return offsetPosition;
    }

    return pointPosition;
  }

  return offsetPosition ?? editor.state.doc.content.size;
}

export function placeEditorCaret(
  editor: Editor,
  request: CaretPlacementRequest | null,
  fallbackTextOffset: number | null = request?.textOffset ?? null,
) {
  const position = resolveEditorCaretPosition(
    editor,
    request,
    fallbackTextOffset,
  );
  editor.commands.focus();
  editor.commands.setTextSelection(position);
  return position;
}
