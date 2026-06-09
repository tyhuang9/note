# AI Assistant Architecture

## Goal

Add a local-first assistant that can connect to user-run LLM and speech-to-text
services. The app should not bundle model runtimes in this pass. Providers are
HTTP endpoints running on the user's machine, such as Ollama, LM Studio,
llama.cpp-compatible servers, or Whisper-compatible transcription servers.

## Stable Interfaces

All feature branches should share the contracts in `frontend/src/aiTypes.ts`.
Those types define:

- LLM provider configuration and chat request/response payloads.
- STT provider configuration and transcription request/response payloads.
- Notes context snapshots derived from the current app data.
- Assistant actions that can write AI output back into notes.

Branches can add implementation files that import these contracts, but they
should not change the shape of the contracts without updating this document.

## Branch Scopes

- `feature/ai-assistant-shell`: assistant panel UI, panel open/close state, and
  app layout styling. This branch should not implement provider HTTP calls.
- `feature/model-provider-abstraction`: local LLM/STT provider services and
  provider configuration helpers. This branch should avoid editing App layout.
- `feature/notes-context-service`: context extraction from folders, pages, and
  blocks. This branch should avoid UI edits.
- `feature/assistant-actions-interface`: narrow action helpers for inserting or
  appending assistant output to notes. This branch should avoid provider code.
- `feature/assistant-docs`: README and user-facing setup documentation.
- `feature/ai-assistant-integration`: merge the branches one at a time, wire the
  UI to provider/context/action services, and verify the full app.

## Provider Contract

The provider layer receives normalized chat/transcription requests and returns
normalized results. Provider implementations are responsible for translating
requests to their local endpoint format.

Supported initial provider shapes:

- LLM:
  - Ollama chat endpoint: `POST /api/chat`.
  - OpenAI-compatible chat endpoint: `POST /chat/completions`.
- STT:
  - OpenAI-compatible Whisper endpoint: `POST /audio/transcriptions`.

Provider base URLs are user-configurable and default to common local ports.

## Notes Context Contract

The context service builds a compact snapshot from current `AppData` without
changing persisted note data. The snapshot includes:

- Active page title and text blocks.
- Selected block text, when blocks are selected.
- Nearby page and folder metadata.
- A prompt-ready plaintext summary with size limits.

## Assistant Actions Contract

Assistant actions are declarative. UI code can request an action, and App-level
handlers perform the actual write using the existing note update/create paths.

Initial actions:

- Insert assistant text as a new text block on the current page.
- Append assistant text to the selected text block.
- Replace the selected text block with assistant text.

## Verification

Each branch should run the checks it can reasonably cover:

- `npm run build`
- `cd backend/src-tauri && cargo check`
- `git diff --check`

The integration branch must run all three after each merge and again before the
final handoff.
