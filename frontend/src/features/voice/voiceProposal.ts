export const VOICE_PROPOSAL_EVENT = "note://voice-proposal";
export const MAX_VOICE_PROPOSAL_TEXT_LENGTH = 500;

export type VoiceProposalMode =
  | "assistant_command"
  | "note_dictation"
  | "quick_capture";
export type VoiceProposalSource = "typed" | "voice";

export type VoiceProposal = {
  proposalId: string;
  text: string;
  mode: VoiceProposalMode;
  source: VoiceProposalSource;
};

export type VoiceProposalRoute =
  | { kind: "assistant"; proposal: VoiceProposal }
  | { kind: "note_review"; proposal: VoiceProposal }
  | { kind: "quick_capture_review"; proposal: VoiceProposal };

const modes = ["assistant_command", "note_dictation", "quick_capture"] as const;
const sources = ["typed", "voice"] as const;
const proposalIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isSafeText(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  if (Array.from(value).length > MAX_VOICE_PROPOSAL_TEXT_LENGTH) return false;
  return !Array.from(value).some(
    (character) =>
      (character < " " && character !== "\n" && character !== "\t") || character === "\u007f",
  );
}

function parseVoiceProposal(value: unknown): VoiceProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (
    keys.length !== 4 ||
    keys.some((key) => !["proposalId", "text", "mode", "source"].includes(key)) ||
    typeof payload.proposalId !== "string" ||
    !proposalIdPattern.test(payload.proposalId) ||
    !isSafeText(payload.text) ||
    !isOneOf(payload.mode, modes) ||
    !isOneOf(payload.source, sources)
  ) {
    return null;
  }

  return {
    proposalId: payload.proposalId,
    text: payload.text,
    mode: payload.mode,
    source: payload.source,
  };
}

/** Pure trust-boundary validation and non-mutating destination selection. */
export function routeVoiceProposal(
  payload: unknown,
  handledProposalIds: ReadonlySet<string>,
): VoiceProposalRoute | null {
  const proposal = parseVoiceProposal(payload);
  if (!proposal || handledProposalIds.has(proposal.proposalId)) return null;

  switch (proposal.mode) {
    case "assistant_command":
      return { kind: "assistant", proposal };
    case "note_dictation":
      return { kind: "note_review", proposal };
    case "quick_capture":
      return { kind: "quick_capture_review", proposal };
  }
}
