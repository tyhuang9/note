# AI Assistant Architecture

## Goal

Add a local-first assistant that can connect to user-run LLM services,
OpenAI-compatible endpoints, and cloud/API providers. The app should not bundle
model runtimes in this pass. Providers are HTTP endpoints such as Ollama, LM
Studio, llama.cpp-compatible servers, or OpenAI-compatible cloud APIs.

## Stable Interfaces

All feature branches should share the contracts in `frontend/src/aiTypes.ts`.
Those types define:

- Provider/model configuration and chat request/response payloads.
- STT provider configuration and transcription request/response payloads.
- Notes context snapshots derived from the current app data.
- Assistant actions that can write AI output back into notes.
- Adapter interfaces for testing connections, listing models, and sending chat.

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

The provider layer receives normalized chat requests and returns normalized
results. Provider implementations are responsible for translating requests to
their runtime-specific endpoint format. UI code must not call provider-specific
endpoints directly.

Required provider types:

- Ollama local server.
- LM Studio local server, treated as OpenAI-compatible.
- Generic OpenAI-compatible API.
- OpenAI API.
- Future providers through `AIProviderAdapter`.

Provider base URLs are user-configurable and default to common local ports.
The app assumes the model servers are already running; it does not start
Ollama, OpenAI-compatible chat servers, or cloud provider infrastructure.
Example local endpoints are:

- Ollama base URL: `http://localhost:11434`.
- LM Studio base URL: `http://localhost:1234/v1`.
- OpenAI-compatible base URL: `http://localhost:1234/v1`.
- OpenAI base URL: `https://api.openai.com/v1`.

API keys are isolated behind `CredentialStore` so a secure credential backend
can replace the current local implementation later.

## AI Providers Screen

The AI Providers screen owns provider connection UX:

- Provider list sidebar.
- Add Provider control with provider type selection.
- Provider detail form for name, type, base URL, API key, and enabled state.
- Test Connection and Refresh Models actions.
- Connection status indicator and clear error/status messages.
- Model list with inferred capabilities.
- Default chat model and default embedding model selectors.

The assistant panel only displays the selected default chat model and opens AI
Providers. It does not contain provider-specific endpoint or model-fetch logic.

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
