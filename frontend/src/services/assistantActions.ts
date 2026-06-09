import type { AssistantActionKind, AssistantActionRequest } from "../aiTypes";

export type AssistantActionMetadata = {
  description: string;
  kind: AssistantActionKind;
  label: string;
  requiresSelectedBlock: boolean;
};

export type AssistantActionValidationResult =
  | {
      ok: true;
      request: AssistantActionRequest;
    }
  | {
      message: string;
      ok: false;
    };

export const assistantActionKinds = [
  "insert-text-block",
  "append-to-selected-block",
  "replace-selected-block",
] as const satisfies readonly AssistantActionKind[];

export const assistantActionMetadata: Record<
  AssistantActionKind,
  AssistantActionMetadata
> = {
  "insert-text-block": {
    description: "Create a new text block on the current page.",
    kind: "insert-text-block",
    label: "Insert text block",
    requiresSelectedBlock: false,
  },
  "append-to-selected-block": {
    description: "Add assistant output to the end of the selected text block.",
    kind: "append-to-selected-block",
    label: "Append to selected block",
    requiresSelectedBlock: true,
  },
  "replace-selected-block": {
    description: "Replace the selected text block with assistant output.",
    kind: "replace-selected-block",
    label: "Replace selected block",
    requiresSelectedBlock: true,
  },
};

export const assistantActionOptions = assistantActionKinds.map(
  (kind) => assistantActionMetadata[kind],
);

export function normalizeAssistantActionContent(content: string) {
  return content.replace(/\r\n?/g, "\n").trim();
}

export function isAssistantActionKind(
  value: string,
): value is AssistantActionKind {
  return assistantActionKinds.includes(value as AssistantActionKind);
}

export function validateAssistantActionRequest(
  value: unknown,
): AssistantActionValidationResult {
  if (!isObjectRecord(value)) {
    return { message: "Assistant action must be an object.", ok: false };
  }

  const { content, kind } = value;

  if (typeof kind !== "string" || !isAssistantActionKind(kind)) {
    return { message: "Choose a supported assistant action.", ok: false };
  }

  if (typeof content !== "string") {
    return { message: "Assistant action content must be text.", ok: false };
  }

  return buildAssistantActionRequest(kind, content);
}

export function buildAssistantActionRequest(
  kind: string,
  content: string,
): AssistantActionValidationResult {
  if (!isAssistantActionKind(kind)) {
    return { message: "Choose a supported assistant action.", ok: false };
  }

  const normalizedContent = normalizeAssistantActionContent(content);

  if (!normalizedContent) {
    return { message: "Assistant output is empty.", ok: false };
  }

  return {
    ok: true,
    request: {
      content: normalizedContent,
      kind,
    },
  };
}

export function buildInsertTextBlockAction(content: string) {
  return buildAssistantActionRequest("insert-text-block", content);
}

export function buildAppendToSelectedBlockAction(content: string) {
  return buildAssistantActionRequest("append-to-selected-block", content);
}

export function buildReplaceSelectedBlockAction(content: string) {
  return buildAssistantActionRequest("replace-selected-block", content);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
