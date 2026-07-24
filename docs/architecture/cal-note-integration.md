# Cal-to-Note Integration Architecture

Status: Phase 1 complete (acceptance gate passed)

Last updated: 2026-07-24

Writable product: Note

Read-only reference: Cal

## Product objective

Deliver one installed, local-first application—Note—that preserves the existing React/TypeScript/TipTap canvas, folders, pages, tabs, search, and assistant experience while adding a first-class Agenda and month view, a mature local calendar engine, reminders, import/export and backups, an auxiliary agenda widget, app-managed local models, native voice capture and transcription, global quick commands, and one assistant grounded through bounded Note-owned tools.

The integration must feel native to Note. Cal contributes reference domain infrastructure and safety properties; it does not contribute a second application shell, a Svelte runtime, or an embedded Cal user experience. Calendar, model, voice, widget, or provider failures must not prevent local note editing.

## Source repositories and immutable baselines

| Repository | Role | Checkout / worktree | Branch | Pinned state |
|---|---|---|---|---|
| Note | Only writable repository | `C:\Users\huang\Documents\Projects\note-cal-integration` | `feature/integrate-cal-into-note` | Base and current Phase 0 source SHA: `d7fd7b13d0964ed631e846fe6a6cc1ed0add09d2`; created from `origin/main` at the same SHA. |
| Note primary checkout | Must remain outside integration writes | Git worktree record: `/home/huang/Documents/Projects/note` | `main` | Same base SHA when the integration worktree was recorded. All integration work remains in the sibling worktree above. |
| Cal | Read-only reference only | `C:\Users\huang\Documents\Projects\cal` (Git resolved top-level: `/home/huang/Documents/Projects/cal`) | `main` | Reference SHA: `032c4703bdb04d470b1aee5e23fb8c1c57b249c4`. |

Cal did **not** begin from a clean working tree. Its recorded starting state contains 15 modified tracked paths and 7 untracked paths. Those pre-existing changes belong to the developer. The exact starting `HEAD` and complete porcelain status—not merely the path counts—are immutable comparison evidence. Cal's final `HEAD` and porcelain output must match that starting state exactly. No branch switches, installs, builds, tests, formatters, generators, or writes may run in the Cal checkout. Reference reads do not authorize any mutation. Phase and final acceptance require an exact comparison against the recorded starting `HEAD` and porcelain output; this document must never describe Cal as clean.

The complete initial `git status --porcelain=v1` output captured before Phase 0 work is:

```text
 M src-tauri/src/assistant/contracts.rs
 M src-tauri/src/assistant/mod.rs
 M src-tauri/src/assistant/model.rs
 M src-tauri/src/assistant/service.rs
 M src-tauri/src/local_model/api.rs
 M src-tauri/src/local_model/client.rs
 M src-tauri/src/local_model/contracts.rs
 M src-tauri/src/local_model/mod.rs
 M src/lib/assistant/client.ts
 M src/lib/assistant/contracts.ts
 M src/lib/components/AssistantCommandBar.svelte
 M src/lib/components/AssistantCommandBar.test.ts
 M src/lib/components/SettingsPanel.svelte
 M src/lib/components/SettingsPanel.test.ts
 M src/routes/+page.svelte
?? docs/agent-implementation.md
?? evals/
?? src-tauri/src/assistant/agent_loop.rs
?? src-tauri/src/assistant/calendar_tools.rs
?? src-tauri/src/assistant/evals.rs
?? src-tauri/src/assistant/protocol.rs
?? src-tauri/src/local_model/agent.rs
```

## Current Note baseline

### Frontend concentration

`frontend/src/App.tsx` is 7,096 physical lines and 6,262 nonblank lines at the pinned Note SHA. It currently owns or coordinates:

- application state, initial load, debounced save, and error fallback;
- session and per-page viewport restoration;
- folders, pages, templates, bookmarks, tabs, workbench overlays, and responsive shell composition;
- canvas history, clipboard, selection, drag, resize, pan, zoom, insertion, search, and offscreen navigation;
- the TipTap formatting bridge and global formatting toolbar;
- assistant messages, llama-harness setup/capabilities/runs/tool results, provider settings, provider tests/model discovery, browser microphone capture, and STT;
- settings and modal composition.

The existing canvas remains valuable and behavior-rich. This concentration is a migration risk, not a reason for a big-bang rewrite.

### Persistence and native boundary

The current native backend is `backend/src-tauri/src/lib.rs`. It resolves the application-data directory and stores all persisted Note content in `note-data.json`.

The only direct renderer Tauri calls are:

| Call site | Command | Current purpose |
|---|---|---|
| `frontend/src/App.tsx:1585` | `invoke<AppData>("load_app_data")` | Load folders, pages, blocks, theme, session, open tabs, and viewports during the mount effect. |
| `frontend/src/App.tsx:1839` | `invoke("save_app_data", { data })` | Debounced persistence after data, theme, session, tab, or viewport changes. |

The complete native command inventory is:

| Native source | Command | Behavior |
|---|---|---|
| `backend/src-tauri/src/lib.rs:84-93` | `load_app_data` | Reads and deserializes `<app-data>/note-data.json`, or returns empty data when absent. |
| `backend/src-tauri/src/lib.rs:96-105` | `save_app_data` | Creates the parent directory and writes pretty JSON to `<app-data>/note-data.json`. |
| `backend/src-tauri/src/lib.rs:110` | handler registration | Registers only `load_app_data` and `save_app_data`. |

No calendar database or calendar command exists in the Phase 0 Note source.

## Non-negotiable architecture decisions

1. Note remains the primary application and retains React, TypeScript, TipTap, the canvas model, the Note identifier, and the Note visual language. Svelte and Cal's application shell are not introduced.
2. Cal is a read-only reference for native domain behavior, tests, validation, recurrence, reminders, storage, import/export, backup, model, voice, shortcut, tray, and widget patterns. Ported code is adapted to Note contracts and `note://...` event names.
3. Note data remains backward-compatible in `note-data.json`; calendar records live separately in `calendar.sqlite3`. Migrating all notes to SQLite is a separate future decision.
4. Agenda and Month are live system views. They are never generated Note pages and never use note blocks as their calendar source of truth.
5. `main`, `widget`, `quick-command`, and an optional later `event-editor` are distinct surfaces with least-privilege capabilities and independent lifecycle. Floating widget placement is the stable default; desktop attachment is experimental with honest fallback.
6. One application-owned assistant runtime and versioned tool registry serve notes and calendar. Providers propose structured work; Note validates and executes it.
7. Sensitive and performance-critical work is native Rust authority: storage, credentials, provider mediation where practical, voice, transcription, model management, shortcuts, windows, tray, import/export, backup/restore, notifications, and private-file operations.
8. Existing plaintext credentials must migrate out of webview storage into an OS-backed or isolated native credential abstraction. No new API key is written to `localStorage`.
9. `App.tsx` is reduced incrementally into composition and routing boundaries before substantial calendar UI is added. The canvas is protected by tests and extracted in behavior-preserving slices.
10. Local models are app-managed, not bundled. Native Whisper is the target STT path; Ollama is a managed external local runtime; OpenAI-compatible providers remain optional; llama-harness remains an optional adapter. Model or provider availability never blocks startup.
11. Existing Cal data moves only through a later explicit, previewed, recovery-backed, transactional import. There is no silent discovery-and-move migration.
12. Each phase stays buildable, preserves Note behavior, adds relevant tests, passes its gate, and lands as a focused commit before the next phase begins.

## Target module boundaries

Target paths are directional rather than a license for a bulk move. Boundaries may be refined when implementation evidence warrants it, but ownership must remain explicit.

```text
frontend/src/
  app/                         surface resolution, composition, workspace/session routing
  surfaces/
    MainSurface.tsx            full Note workbench
    WidgetSurface.tsx          restricted agenda widget; no canvas import
    QuickCommandSurface.tsx    lightweight capture/command state machine
    EventEditorSurface.tsx     optional later focused editor
  features/
    notes/                     note workspace and canvas-facing orchestration
    calendar/                  Agenda, Month, event editor, projections
    assistant/                 unified runtime UI, tool review, provider-neutral state
    models/                    setup, status, install progress, cancellation
    voice/                     voice modes and session state
    widget/                    preferences and widget view model
    settings/                  coherent Note settings experience
  native/
    notesClient.ts             typed load/save bridge
    calendarClient.ts          typed bounded calendar commands
    assistantClient.ts         tools, confirmations, provider mediation
    modelClient.ts             model/runtime lifecycle
    voiceClient.ts             native capture/transcription lifecycle
    widgetClient.ts            restricted widget/window operations
    shellClient.ts             navigation, tray, shortcut, window requests
  shared/                      wire types, errors, limits, design tokens, pure helpers

backend/src-tauri/src/
  lib.rs                       state construction, plugin setup, command registration only
  notes/                       backward-compatible note JSON service and commands
  calendar/                    domain types, validation, recurrence, reminders, commands
  calendar_store/              SQLite migrations, pool, queries, transactions
  assistant/                   registry, policy, pending actions, result sanitation
  models/                      manifest, runtime checks, downloads, cancellation
  voice/                       device enumeration, capture, transcription, lifecycle
  desktop_widget/              window state, placement, fallback, refresh coordination
  shell/                       surfaces, navigation, shortcuts, tray, notifications
  credentials/                 native credential abstraction and legacy migration
  migration/                   explicit Cal import and unified backup/restore
  mutation.rs                  shared mutation/concurrency gates
  private_file.rs              private temporary files and atomic publication
```

The intended call path is:

```text
React surface
  -> typed native client
  -> bounded Tauri command with caller-window authorization
  -> Rust domain service / policy
  -> Rust-owned storage, OS service, local runtime, or explicitly approved provider
```

Feature components do not scatter raw `invoke` calls. React never receives SQL, filesystem paths that confer authority, credential values outside an explicit edit flow, or process handles. Auxiliary renderers do not call each other; navigation and refresh coordination pass through authenticated native commands and sanitized `note://...` events.

## Storage strategy

All paths below are under Note's Tauri application-data directory unless the operating system credential store or an explicitly managed model location is used.

| Data | File / store | Authority and lifecycle |
|---|---|---|
| Existing notes, folders, pages, blocks, theme, and initial session compatibility | `note-data.json` | Preserved during the calendar integration. The `load_app_data` / `save_app_data` contract is moved behind a typed notes client and Rust notes module without changing user data. |
| Calendars, events, recurrences, occurrence overrides, revisions, reminder state, and calendar settings | `calendar.sqlite3` | New Rust-owned SQLite database with versioned migrations, a long-lived pool, bounded queries, revision checks, and transactional calendar mutations. Calendar data never enters `note-data.json`. |
| Widget preferences and recoverable placement state | `widget-state.json` | Native-managed, bounded, non-secret preferences such as enabled, requested/effective placement, lock, click-through, and workspace visibility. It is not a duplicate calendar store. |
| Voice preferences | `voice-config.json` | Native-managed non-secret device/mode configuration. Temporary recordings use private files and are removed during normal completion, cancellation, and startup cleanup. |
| Model metadata | model-related app data | Versioned manifest, install state, checksums, progress metadata, and Note ownership markers. Large weights are app-managed rather than bundled; deletion is limited to Note-managed artifacts. |
| Provider secrets | OS credential store or isolated native credential abstraction | Never added to JSON or browser storage. The abstraction must support safe migration of existing webview credentials and permit platform-specific secure backends. |
| Non-secret provider/model preferences | versioned native preferences | Provider IDs, endpoint policy, selected model, and capability metadata may be backed by native app data; secrets remain separate. |

`note-data.json` and `calendar.sqlite3` intentionally do not share a transaction. Each domain must remain independently recoverable. Phase 8 adds a versioned application backup manifest and a coordinated snapshot procedure that can include note data, a verified SQLite snapshot, non-secret preferences, and asset metadata. Unified backups exclude API keys, provider secrets, temporary recordings, and model weights unless a later design explicitly opts in.

Writes that replace files use private staging and atomic publication where supported. Calendar restore and import operate on verified snapshots and publish only after integrity checks. The exact duplicate policy and cross-file backup consistency marker are defined and tested before Phase 8 acceptance.

## Workspace and system-view model

The current workbench models open tabs as Note page IDs. It will evolve to a discriminated model before Agenda UI work:

```ts
type WorkspaceView =
  | { kind: "note"; pageId: string }
  | { kind: "agenda"; view: "agenda" | "month" }
  | { kind: "settings"; section?: string };

type WorkspaceTab = {
  id: string;
  view: WorkspaceView;
  title: string;
};
```

Session restoration records the discriminant and bounded view state. Existing page tab IDs are migrated compatibly into `{ kind: "note" }` entries. Agenda has a stable system identity and may be opened, focused, closed, and restored, but cannot be renamed, placed in a folder, duplicated as a note, or deleted as note content.

Agenda and Month query the native calendar service, preserve event IDs, occurrence keys, time zones, and expected revisions, and refresh on `note://calendar-changed`. They use half-open intervals, cursor-backed paging, bounded rendering, and explicit loading/error/readiness states. A future “create planning note” action may explicitly materialize a snapshot into blocks; that snapshot is never the calendar source of truth.

## Surface and window model

| Surface label | Purpose | Allowed authority | Explicitly excluded |
|---|---|---|---|
| `main` | Note workbench, canvas, Agenda, settings, assistant, full review/edit flows | Note read/write, bounded calendar read/write, assistant proposals and confirmations, credential edit requests, model/voice/widget management | Raw SQL, direct secret persistence, arbitrary native filesystem/process access |
| `widget` | Deterministic compact current/upcoming agenda and navigation | Bounded upcoming calendar read, sanitized calendar-change events, open/focus Note or Agenda, request quick add through main, move/lock/hide/resize itself | Note contents, credentials, provider/network access, microphone, arbitrary filesystem, unrestricted or destructive calendar mutation |
| `quick-command` | Immediate push-to-talk/typed command feedback and routing | Native capture session control, transcription status, cancellation, submit a bounded proposal to main/native policy | Full canvas data, credential access, direct calendar/note writes, broad provider or filesystem authority |
| `event-editor` (optional) | Later focused event editor after the main editor is stable | Bounded event read and validated, revision-checked mutation for the event being edited | Notes, provider credentials, voice/model administration, unrestricted calendar access |

Window label is a security input, not merely a routing hint. Every sensitive command verifies the caller label in Rust in addition to Tauri capability configuration. Main and widget visibility are independent. Widget preferences distinguish requested placement from effective placement. `floating` is stable/default; `desktop` is experimental and preserves the requested preference while reporting a sanitized fallback reason when unavailable. Disabling or closing the widget never replaces or closes the main workbench.

Browser-only development resolves to `main`. Auxiliary entries must be code-split so the widget and quick command do not load the full canvas bundle.

## Unified assistant and tool boundary

Note owns one provider-neutral runtime and one registry. llama-harness, Ollama, OpenAI-compatible providers, and a future embedded runtime are adapters behind that contract, not separate assistant identities.

Every versioned tool definition includes:

- stable tool ID and schema version;
- bounded JSON input and output schemas, with unknown fields rejected for sensitive payloads;
- risk classification and confirmation policy;
- input, result, range, string, and collection limits;
- authorized window labels;
- cancellation and timeout behavior;
- provider data-sharing classification;
- result sanitization and non-content diagnostics policy.

Initial registry:

| Policy | Tools |
|---|---|
| Read-only; may run automatically after bounded validation | `notes.read_selection`, `notes.read_page`, `notes.search`, `calendar.query`, `calendar.search`, `calendar.get_event` |
| Write; main-window only and app-owned | `notes.insert_text`, `notes.append_text`, `notes.replace_text`, `calendar.create_event` |
| Deferred until create/revision policy is proven | `calendar.update_event`, `calendar.delete_event` |

Calendar questions use live native tools; they do not scrape Agenda UI, infer events from note text, or serialize the full calendar into a prompt. Note context is assembled only when requested from the current page, selected blocks, bounded nearby metadata, or bounded search results.

Read-only calls may execute automatically. A remote or local model never writes storage directly. Calendar creation requires a validated review card and an expiring native pending-action token by default; execution revalidates the token, caller, payload, time zone, limits, recurrence, reminders, and current state. Update/delete remain deferred until expected-revision and occurrence-scope behavior meet the same standard. Note writes remain main-window-only and require an explicit user-initiated assistant action; policy may require review for broader or destructive future note tools.

Before a remote provider receives data, the UI identifies local versus remote processing and the bounded data categories to be shared. Only the minimum prompt/context/tool result needed for the chosen request is sent. Provider credentials never enter tool results, prompts, logs, or auxiliary windows. Diagnostics record timings, IDs/classes, and sanitized errors—not note content, event titles, prompts, transcripts, or secrets.

## Security boundary and current gap inventory

### Current configuration

- `backend/src-tauri/tauri.conf.json:25` sets CSP to `null`.
- `backend/src-tauri/capabilities/default.json` targets only `main` and grants `core:default`.
- The two current Rust commands do not perform explicit caller-window authorization; the main-window capability is the present outer boundary.
- The current note persistence commands are unbounded: `load_app_data` reads and deserializes the entire JSON file, while `save_app_data` accepts unrestricted collection counts, strings, rich JSON depth, and base64 image data before serializing and directly writing the whole document. A compromised or defective main renderer could exhaust memory or disk or corrupt the only note-data file.
- `note.aiProviders.settings.v1` stores provider/model settings in webview `localStorage`.
- `note.aiProviders.credentials.v1` stores provider API keys as plaintext JSON in webview `localStorage`. This is an existing high-risk condition and must be migrated to native credential storage; it must not be copied forward.
- `note.llamaHarness.selectedAgentId.v1` stores the selected harness agent ID in `localStorage`; this is preference data, not a credential.
- The current assistant records through browser `getUserMedia`/`MediaRecorder`. The target voice boundary is native and must not depend on browser microphone permission.

### Explicit renderer network inventory

| Renderer source | Transport and destinations | Current wiring status |
|---|---|---|
| `frontend/src/services/aiProviderAdapters.ts:278` | Generic JSON `fetch` for Ollama and OpenAI-compatible endpoints derived from user-configurable base URLs; request methods include model discovery, connection tests, and exported chat. OpenAI-compatible callers may attach `Authorization: Bearer <API key>`. | Connection tests and model listing are actively called by `App.tsx`. Provider chat is exported through `assistantService.ts` but is not imported/wired by `App.tsx`; treat it as latent/ambiguous, not an active chat path. |
| `frontend/src/services/aiProviderAdapters.ts:314` | Root `GET` fallback for OpenAI-compatible connection testing, with the same optional Bearer header. | Active only as the connection-test fallback. |
| `frontend/src/services/localModelProviders.ts:246` | JSON `POST` helper for configurable Ollama `api/chat` and OpenAI-compatible `chat/completions` URLs. | The chat helpers are exported but not wired by `App.tsx`; latent/ambiguous. |
| `frontend/src/services/localModelProviders.ts:268` | Multipart `POST` helper for configurable OpenAI-compatible `audio/transcriptions`. | Active: `App.tsx:3943` sends browser-recorded assistant audio to this path. |
| `frontend/src/services/llamaHarnessAssistant.ts:161` | JSON `fetch` to fixed loopback origin `http://127.0.0.1:8787` for setup status, Note capabilities, runs, and tool-result continuation. | Active assistant path through `App.tsx`; refresh occurs when the assistant opens, including when an open assistant is restored from session. |

No renderer `XMLHttpRequest`, `WebSocket`, or `EventSource` call exists at the pinned SHA.

### Target controls

1. Replace `csp: null` with a tested restrictive CSP and explicit per-surface capabilities during Phase 1.
2. Treat Rust as the authority for command authorization, storage, secrets, filesystem/process work, native voice, and sensitive/performance-critical network mediation. Capabilities are defense in depth, not the sole authorization check.
3. Move provider credentials to the native credential abstraction. Migrate legacy plaintext values only through a one-time, failure-aware flow that deletes the legacy copy after verified native storage and never logs either value.
4. Remove arbitrary provider egress from restricted surfaces. Where renderer provider calls remain temporarily, confine them to `main`, validate destination and response bounds, and track removal. Prefer a bounded Rust provider gateway with scheme/host/loopback policy, explicit remote-data disclosure, proxy policy, timeouts, cancellation, and response-size limits.
5. Use strict Rust deserialization, unknown-field rejection, numeric/string/collection bounds, recurrence scan bounds, revision checks, expiring confirmations, and sanitized structured errors.
6. Use private temporary files, checksum verification, safe staging/atomic publication, path normalization, and symlink/path-traversal protections for models, voice, imports, exports, and backups. Never interpolate model or voice arguments through a shell.
7. Emit only sanitized `note://...` events. Event payloads do not carry secrets or broad note/calendar content to unauthorized windows.
8. Bound the preserved note persistence contract before it becomes a broader native foundation: reject oversized `note-data.json` files before allocation/deserialization; cap Tauri command payload bytes, folder/page/block counts, string and decoded image sizes, rich-content nesting depth, and total serialized output; validate limits on both load and save; then stage and atomically publish validated writes.

## Incremental migration strategy

1. **Protect the baseline.** Finish Phase 0 measurements and verification at the pinned Note SHA, record exact Cal comparison evidence, and commit documentation only.
2. **Create seams before features.** In Phase 1, add surface resolution, typed native clients, per-window capabilities, native error/state boundaries, and the discriminated workspace model. Extract assistant/settings and persistence orchestration from `App.tsx` in small behavior-preserving changes.
3. **Port the kernel behind Rust contracts.** Add `calendar.sqlite3`, migrations, repositories, recurrence, reminders, search, import/export, and backup logic without changing note JSON or adding raw SQL to React. Calendar readiness may initialize asynchronously; commands await it without blocking note editing.
4. **Add lazy system UI.** Build Agenda/Month and the main event editor against typed calendar clients, preserving page tabs and canvas behavior. Load calendar UI only when opened.
5. **Unify policy before expanding automation.** Consolidate assistant runtime/tools, then native model management and credentials. Stabilize `calendar.create_event` review before update/delete.
6. **Add native voice and auxiliary surfaces.** Use generation/session IDs, cancellation, stale-result rejection, and lightweight code-split quick-command/widget entries. Keep floating widget placement as the reliable path.
7. **Import explicitly and harden.** Add previewed transactional Cal import and coordinated backups only after Note's calendar schema is stable. Finish performance, accessibility, security, cross-platform, and failure-path validation before release.

Each step has a rollback boundary: the previous commit remains buildable, note JSON remains readable, calendar migrations are versioned and tested, incomplete features remain unavailable in production UI, and no phase depends on modifying Cal.

## Phase checklist

| Phase | Status | Scope and acceptance evidence |
|---|---|---|
| 0 — Baseline, documentation, measurements | **Complete** | Source/state inventory, architecture records, toolchain, builds, tests, bundle sizes, and the startup-probe limitation are recorded. Aggregate documentation and security review passed after the complete initial Cal porcelain output was embedded and the unbounded note-persistence risk was made explicit. Final Cal `HEAD` and raw porcelain bytes match the recorded baseline exactly. |
| 1 — Modular shell and native surface routing | **Complete** | Surface resolver and main/browser fallback, five HTML entries, typed notes client, workspace union and legacy restoration, extracted provider/assistant/settings boundaries, modular Rust state/error/event/mutation/notes/private-file/security modules, restrictive CSP, four exact-label capabilities, caller-label and bounded persistence tests; no calendar behavior. See the Phase 1 record below. |
| 2 — Calendar kernel | Not started | SQLite/migrations, bounded domain/repository APIs, recurrence/occurrences, revisions, reminders, search/paging, ICS, verified backup/restore, authorization, and adapted Rust tests. |
| 3 — React Agenda and Month | Not started | First-class system tabs, real service queries, bounded rendering, accessible editor, CRUD/recurrence/reminders, existing canvas/tabs intact. |
| 4 — Unified assistant and calendar tools | Not started | Provider-neutral runtime, one registry, bounded grounding, expiring reviewed create-event actions, authorized windows, retained Note actions. |
| 5 — App-managed models and credentials | Not started | Native Ollama management, unified model/provider state, progress/cancel/remove, native credential abstraction/migration, nonblocking startup. |
| 6 — Native voice and quick command | Not started | Native device/capture/transcription, private files, cancellation/session race handling, global shortcuts, lightweight overlay, typed input fallback. |
| 7 — Widget and tray | Not started | Restricted React widget, deterministic agenda, independent main/window lifecycle, stable floating mode, honest desktop fallback, bounded refresh, tray recovery. |
| 8 — Cal import and unified backups | Not started | Read-only source validation/preview, duplicate policy, recovery backup, transactional import and count verification, versioned secret-free unified backup/restore. |
| 9 — Release hardening | Not started | Instrumentation, measured budgets, accessibility/security review, synthetic performance data, supported-platform builds/tests and documented limitations; Cal unchanged. |

## Known risks

| Severity | Risk | Mitigation / gate |
|---|---|---|
| High | `App.tsx` couples persistence, canvas, workbench, assistant, provider, and voice behavior; adding features directly would amplify regressions and rerenders. | Phase 1 extraction before calendar UI; pure helpers, typed clients, focused tests, incremental aggregate-diff review; no big-bang canvas rewrite. |
| High | CSP is currently disabled and renderer endpoints are configurable, including remote origins and Bearer credentials. | Restrictive CSP, native provider mediation, destination/loopback policy, explicit cloud disclosure, response/time bounds, and per-window egress denial. |
| High | Existing API keys are plaintext in `localStorage`. | Native credential abstraction and verified one-time migration; delete legacy values only after successful native write; never log secrets; no new plaintext writes. |
| High | Current assistant tool execution is renderer-owned and write-capable; calendar tooling would raise impact. | One versioned registry, strict schemas/limits, Rust execution, caller auth, review cards, expiring confirmation tokens, revision checks, and no model-direct mutations. |
| High | Recurrence, time zones, occurrence scope, reminders, restore, and revision conflicts have subtle data-integrity edge cases. | Adapt Cal's bounded domain logic and tests; add DST, all-day, overnight, occurrence mutation, revision, invalid restore, and reminder lifecycle coverage before UI reliance. |
| High | Cal contains pre-existing developer changes, so even an apparently harmless command could alter its status or artifacts. | No execution in Cal; read-only reference only; compare exact starting/final SHA and porcelain text, not a “clean” assumption or count alone. |
| High | Current note load/save accepts an unbounded whole-file JSON document, including unrestricted collections, strings, rich-content depth, and base64 images; a compromised or defective main renderer could exhaust memory/disk or corrupt the sole note-data file. | Enforce pre-read file limits and command/collection/string/image/depth/output limits on load and save, reject invalid data with structured errors, and publish validated writes through private atomic staging. |
| Medium | Note JSON save currently uses a direct write, and split stores cannot share one transaction. | Preserve compatibility first; add private atomic note writes where safely reviewable; independently recoverable stores; coordinated verified snapshots with a manifest in Phase 8. |
| Medium | Calendar initialization, reminder startup, model checks, or restored-assistant networking could regress first interaction. | Asynchronous readiness, lazy features, no provider/model wait on startup, long-lived SQLite pool, instrumentation, and ≤10% first-frame regression gate. |
| Medium | Multiple windows create stale state, overbroad capability, and spoofed navigation/mutation risks. | Rust caller-label checks, per-window capabilities, sanitized native events, generation/revision IDs, no renderer-to-renderer authority, restricted surface tests. |
| Medium | Native voice and global shortcuts are race- and platform-sensitive. | Explicit session state machine, generation IDs, cancellation, cleanup, late-result rejection, device removal/sleep tests, typed input fallback, per-platform limitations. |
| Medium | Desktop attachment and tray behavior differ across Windows, macOS, X11, and Wayland. | Floating default, capability-based implementations, feature-gated experimental paths, requested/effective mode reporting, recoverable reset, honest compatibility documentation. |
| Medium | Duplicate provider/chat implementations are present, and some are exported but not wired, which can lead to accidental parallel assistant paths. | Inventory active versus latent routes, consolidate behind one runtime, delete dead/duplicate paths only after tests prove replacement, keep UI provider-neutral. |
| Medium | The existing Rust suite discovers zero tests, so successful `cargo test` does not validate native behavior. | Add focused command, authorization, storage, migration, recurrence, reminder, model, voice, and widget tests in the phase that introduces each boundary. |
| Low | Baseline dependency installation reports one low-severity audit advisory and blocks esbuild postinstall/build scripts. | Review the advisory and npm build-script policy before release; approve scripts only after dependency provenance review. Keep the successful clean production build as evidence, not proof that all platform installs behave identically. |
| Low | `note.llamaHarness.selectedAgentId.v1` remains renderer preference state. | Treat as non-secret; migrate with other preferences when native settings become authoritative, without blocking security-critical credential migration. |

## Performance baseline

### Source-derived baseline

| Measure | Baseline evidence |
|---|---|
| `App.tsx` size | 7,096 physical lines; 6,262 nonblank lines. |
| Direct renderer invokes | 2 (`load_app_data`, `save_app_data`). |
| Registered native commands | 2 (`load_app_data`, `save_app_data`). |
| Renderer fetch call sites | 5 physical `fetch` sites across three service families; active/latent status is recorded above. |
| Other streaming transports | No `XMLHttpRequest`, `WebSocket`, or `EventSource`. |
| Current persisted note store | One `note-data.json` file in Note app data. |

Source startup path: `frontend/src/main.tsx` mounts `App` in React strict mode; `App` initializes the full workbench/canvas state, reads local provider preferences, and starts `load_app_data` from a mount effect. The load result normalizes pages, session state, open tabs, and viewports before setting `isLoaded`. Save is subsequently debounced. Provider settings load from `localStorage` without network. A restored open assistant can trigger background llama-harness setup/capability requests; this is not evidence of a measured first-frame delay, but future startup must not wait for it.

### Phase 0 QA evidence

The independent baseline run produced the following exact evidence on the Windows host:

| Evidence ID | Check | Result |
|---|---|---|
| `QA-01` | Host | Windows host. A startup first-frame measurement was not obtainable; see `QA-13`. |
| `QA-02` | `node --version` | `v24.15.0` |
| `QA-03` | `npm --version` | `11.12.1` |
| `QA-04` | `rustc --version` | `1.96.0` |
| `QA-05` | `cargo --version` | `1.96.0` |
| `QA-06` | Local Tauri CLI | `tauri-cli 2.11.2` |
| `QA-07` | Lockfile install | `npm ci` in `frontend` passed in 4.292 s. npm reported one low-severity audit advisory and warned that esbuild postinstall/build scripts were blocked. |
| `QA-08` | Frontend production build | `npm run build` passed in 3.893 s. Vite warned that the minified application JS chunk was 735.82 kB. This is a chunk measurement, not an asserted total renderer or installer size. |
| `QA-09` | Rust checks | `cargo fmt --all -- --check` passed in 0.434 s. `cargo clippy --all-targets --all-features -- -D warnings` passed in 45.283 s. `cargo test --all-targets --locked` passed in 47.276 s, with zero Rust tests discovered/executed. |
| `QA-10` | Existing e2e tests | The first Playwright run failed only because the pinned Chromium runtime was absent. After installing that pinned runtime, `npm run test:e2e` passed 16/16 tests in 4.571 s. |
| `QA-11` | Tauri release build | `npm run tauri:build` passed in 88.181 s. |
| `QA-12` | Release artifacts | `backend/src-tauri/target/release/note.exe`: 9,060,864 bytes; `backend/src-tauri/target/release/bundle/msi/Note_0.1.0_x64_en-US.msi`: 3,162,112 bytes; `backend/src-tauri/target/release/bundle/nsis/Note_0.1.0_x64-setup.exe`: 2,108,016 bytes. |
| `QA-13` | Startup probe | **Inconclusive / unverified.** The release Note process remained alive for 14.4 s but exposed no main window handle and therefore no reliable first-frame timestamp. Probe PID 23280 was stopped. The 14.4 s observation is not startup latency and must not be used as a baseline denominator. Phase 9 requires explicit startup instrumentation. |
| `QA-14` | Final repository integrity | Note's aggregate Phase 0 change contains only the two architecture documents. Cal `HEAD` remained `032c4703bdb04d470b1aee5e23fb8c1c57b249c4`. A raw comparison of final `git status --porcelain=v1` stdout against the complete initial output embedded above matched exactly: 820 expected bytes, 820 actual bytes, including the trailing newline. |

The intended Phase 9 first-frame gate is no more than 10% slower than a reliable baseline. Because `QA-13` could not establish that baseline, instrumentation must first establish a reproducible pre-integration or nearest-comparable baseline before the percentage can be evaluated. Additional engineering targets are Agenda warm p95 <150 ms, Agenda cold p95 <300 ms, local calendar search p95 <150 ms on a representative dataset, calendar mutation p95 <100 ms excluding OS notification work, widget refresh p95 <150 ms, shortcut visual feedback <100 ms, capture-ready <200 ms where hardware permits, assistant context assembly <50 ms for normal current-page context, progress visibility within 250 ms, and no material canvas interaction regression with a 60 FPS target. None is considered met without recorded measurements.

## Phase 0 acceptance gate

Phase 0 is **complete**. Every item below has recorded evidence:

- [x] Integration worktree, branch, Note base SHA, Cal reference SHA, and non-clean Cal starting state are recorded.
- [x] Product, storage, workspace, surface, assistant, native authority, security, migration, risk, and phase architecture are documented.
- [x] `App.tsx` size/responsibilities, direct Tauri invokes, native commands, persistence file, CSP/capability state, localStorage keys, and renderer network calls are explicitly inventoried.
- [x] Material architecture decisions are recorded in `cal-note-integration-decisions.md`.
- [x] Toolchain and host evidence are recorded in `QA-01` through `QA-06`.
- [x] Lockfile installation and existing Note frontend build succeed; npm/esbuild and Vite chunk warnings are documented.
- [x] Existing Rust format, clippy, and test commands succeed; the zero-test coverage gap is documented.
- [x] Existing Playwright tests pass 16/16 after installing the pinned browser runtime; the initial environment-only failure is documented.
- [x] Tauri release build and exact executable/installer sizes are recorded.
- [x] The attempted startup probe and its explicit inability to establish first-frame latency are recorded without treating process lifetime as latency.
- [x] Note aggregate diff contains only the two intended Phase 0 architecture documents; generated dependency, test, and release artifacts remain ignored.
- [x] Cal final `HEAD` exactly equals `032c4703bdb04d470b1aee5e23fb8c1c57b249c4`, and its complete final porcelain stdout is byte-for-byte identical to the embedded starting output (820 bytes, including the trailing newline).

No Phase 1 implementation begins before this gate passes. No Phase 0 activity authorizes any Cal mutation.

## Phase 1 implementation record

Phase 1 is **complete**. It prepares Note for multiple native domains and surfaces without adding calendar behavior or changing the Cal reference repository. The historical Phase 0 baseline above remains the comparison point; the current Phase 1 implementation reduces `frontend/src/App.tsx` to 7,074 physical lines.

### Implementation completed

- Added a modular surface resolver that reads the Tauri window label and falls back to `main` for browser-only development. Main, widget, quick-command, event-editor, and unsupported routing are code-split through dedicated surface entries.
- Added five production HTML entries (`index.html`, `widget.html`, `quick-command.html`, `event-editor.html`, and `unsupported.html`). The three configured auxiliary Tauri windows are `create: false` and hidden until native code explicitly creates them; an auxiliary build verifier confirms they do not reach the main canvas bundle.
- Added the typed `frontend/src/native/notesClient.ts` boundary. It is the sole direct-invoke module: load uses the existing typed command, save sends bounded raw JSON bytes, and feature components do not scatter raw `invoke` calls.
- Added the canonical discriminated workspace model: `WorkspaceView` is `{ kind: "note", pageId }`, `{ kind: "agenda", view: "agenda" | "month" }`, or `{ kind: "settings", section? }`. Existing page-tab/session fields restore compatibly through the legacy representation.
- Extracted the provider controller and moved assistant and settings views into feature modules while preserving the existing canvas/workbench behavior. Browser STT and microphone capture were removed from application behavior.
- Split the minimal Rust backend into `error`, `app_state`, `events`, `mutation`, `notes`, `private_file`, and `security` modules. Native failures now cross the boundary as structured errors, and `note://...` event names are centralized as constants.
- Restricted note persistence to the exact `main` window label. The native boundary caps raw bytes before deserialization, uses strict save DTOs with unknown-field rejection, keeps persisted loads tolerant for forward-compatible legacy data, applies cumulative record/string/rich-content/decoded-image/output bounds, and publishes validated writes through private atomic staging.
- Replaced the disabled CSP with a restrictive Tauri CSP and added a separate restrictive meta CSP to every auxiliary HTML entry. Four capabilities use the exact labels `main`, `widget`, `quick-command`, and `event-editor`; they contain no globs, `core:default`, `core:event:allow-emit`, or `core:event:allow-emit-to` permissions. The browser-media initialization shim remains defense in depth only; native voice is not implemented in Phase 1.

### Phase 1 verification evidence

| Evidence | Result |
|---|---|
| Production frontend build | Passed: 124 modules and all five HTML entries emitted; the auxiliary CSP/chunk verifier passed. Vite reported the expected `MainSurface` warning of 545.05 kB (170.96 kB gzip). |
| Playwright | `39/39` tests passed. |
| Rust formatting | `cargo fmt --all -- --check` passed. |
| Rust lint | Strict locked clippy passed with `-D warnings`. |
| Rust tests | `24/24` tests passed. |
| Tauri release | No-bundle Tauri release build passed. |
| Direct invoke audit | Exactly one direct-invoke boundary module remains: `frontend/src/native/notesClient.ts`. |
| Static security invariants | No application browser media APIs, no `csp: null`, no capability globs, and no default/event emit capability were found. The media shim is documented only as defense in depth. |

### Independent review outcomes

Code, security, accessibility, UI/UX, and QA reviews were all **GO after fixes**. The canonical Codex Security diff scan was unavailable because Python was not installed; the manual security fallback was **GO**.

### Explicitly unverified

The following are not claimed by the Phase 1 evidence and remain focused release/manual validation work: live native auxiliary-window creation, live capability-denial behavior, live media-permission behavior, behavior with representative installed user data, Windows DACL/no-follow behavior, macOS and Linux builds/runs, and focused manual provider/settings flows. The automated checks and static audits above do not substitute for those environment-specific checks.

## Phase 1 acceptance gate

Phase 1 is **accepted complete for the modular-shell scope**. The implementation, static boundaries, build outputs, tests, and reviews above satisfy the branch gate; no calendar behavior was introduced. The explicit unverified items remain release-validation work and are not represented as passing evidence.

- [x] Surface resolver, browser `main` fallback, five HTML entries, and non-created auxiliary Tauri windows are implemented.
- [x] Typed notes client is the only direct renderer invoke boundary; raw IPC and structured native errors are bounded.
- [x] Canonical workspace union and legacy note-tab/session restoration are implemented.
- [x] Assistant/settings/provider extraction and modular Rust boundaries are implemented without a canvas rewrite.
- [x] Restrictive CSP, auxiliary meta CSP, exact-label capabilities, caller-label authorization, and browser-media defense-in-depth checks are implemented.
- [x] Production build, auxiliary verifier, Playwright `39/39`, Rust format, strict locked clippy, Rust `24/24`, and no-bundle Tauri release checks pass.
- [x] Code, security, accessibility, UI/UX, and QA reviews are GO after fixes; manual security fallback is GO with the canonical Codex Security scan unavailable.
- [ ] Live native auxiliary creation/denial/media, representative installed data, Windows DACL/no-follow, macOS/Linux, and focused provider/settings manual checks remain unverified.

## Phase 1 risk disposition

| Severity | Phase 1 disposition | Residual mitigation / next gate |
|---|---|---|
| High | `App.tsx` remains large at 7,074 physical lines, although provider control and assistant/settings views are extracted. | Continue behavior-preserving extraction before calendar UI; do not add calendar logic to the canvas component. |
| High | Note load/save now has pre-deserialization, strict-save, tolerant-load, cumulative, and atomic-write controls. | Exercise representative installed data and hostile files on each supported platform; retain the bounded contract as the native foundation. |
| High | Restrictive CSP, four exact-label capabilities, main-only note authorization, and no renderer event emission are implemented. | Verify live auxiliary creation and denial behavior in native packaging; keep Rust caller checks authoritative. |
| High | Existing provider credentials remain a Phase 5 migration concern; Phase 1 does not claim native secret storage. | Migrate legacy webview credentials through a verified native abstraction before provider/model release work. |
| Medium | The browser media shim can deny renderer capture but is explicitly not an OS permission boundary. | Replace renderer voice paths with native capture in Phase 6 and test device/platform races. |
| Medium | Rust coverage is now 24/24 for Phase 1 boundaries, but platform-specific DACL/no-follow and macOS/Linux behavior are unverified. | Add supported-platform release validation and filesystem security checks before Phase 9 acceptance. |
| Low | The production build warns that `MainSurface` is 545.05 kB (170.96 kB gzip). | Keep auxiliary chunks isolated and measure release performance when calendar surfaces are added. |

## Evidence references

- `frontend/src/App.tsx`
- `frontend/src/main.tsx`
- `frontend/src/types.ts`
- `frontend/src/components/workbench/WorkspaceTabs.tsx`
- `frontend/src/services/aiProviderAdapters.ts`
- `frontend/src/services/aiProviderStorage.ts`
- `frontend/src/services/assistantService.ts`
- `frontend/src/services/localModelProviders.ts`
- `frontend/src/services/llamaHarnessAssistant.ts`
- `backend/src-tauri/src/lib.rs`
- `backend/src-tauri/tauri.conf.json`
- `backend/src-tauri/capabilities/main.json`
- `backend/src-tauri/capabilities/widget.json`
- `backend/src-tauri/capabilities/quick-command.json`
- `backend/src-tauri/capabilities/event-editor.json`
- `backend/src-tauri/src/app_state.rs`
- `backend/src-tauri/src/error.rs`
- `backend/src-tauri/src/events.rs`
- `backend/src-tauri/src/mutation.rs`
- `backend/src-tauri/src/notes.rs`
- `backend/src-tauri/src/private_file.rs`
- `backend/src-tauri/src/security.rs`
- `frontend/src/surfaces/resolveSurface.ts`
- `frontend/src/native/notesClient.ts`
- `frontend/src/features/workspace/workspaceState.ts`
- `frontend/tests/build/verify-auxiliary-output.mjs`
- `docs/ai-assistant-architecture.md`
- Master implementation brief attached to the Phase 0 task
