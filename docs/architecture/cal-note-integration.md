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
| 2 — Calendar kernel | **Accepted** | SQLite/migrations, bounded domain/repository APIs, recurrence/occurrences, revisions, reminders, search/paging, ICS, verified backup/restore, authorization, typed client, 160 passing Rust tests, and the supported default Playwright run are complete. Commit `b3ad26584731e49bf5b564fe265338a789182752` deliberately configures one worker for the suite's shared Vite server and host/browser resources; the unchanged default command passed 39/39 three consecutive times (117/117 aggregate). See the Phase 2 record below. |
| 3 — React Agenda and Month | **Accepted** | Stable Agenda system tab with Agenda/Month, bounded native queries and rendering, accessible controlled editor, recurrence/reminder CRUD, responsive themed UI, and preserved Note workspace behavior. Final frontend E2E passed 65/65; see the Phase 3 record below. |
| 4 — Unified assistant and calendar tools | **Accepted** | Provider-neutral Note-owned runtime and registry, bounded Notes/Calendar grounding, expiring reviewed calendar creates, authorized native execution, and retained Note actions. Commit `a0cb007`. |
| 5 — App-managed models and credentials | **Accepted** | Native Ollama/provider state and bounded networking, app-owned credential abstraction/migration, progress/cancel/remove, typed settings, and nonblocking startup. Commit `41c808a`. |
| 6 — Native voice and quick command | **Accepted** | Native bounded CPAL capture and Whisper transcription, private staging, generation/session race handling, restricted quick-command lifecycle, global hold-to-talk, main-only Voice settings, and explicit typed/review fallback. |
| 7 — Widget and tray | **Accepted** | Restricted React widget and Rust-native tray/window service, deterministic bounded agenda, independent visibility, stable Floating placement, persisted Desktop-request→Floating fallback, strict main/widget capability separation, and tray recovery. |
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

## Phase 2 implementation record

Phase 2's calendar-kernel implementation is complete. It adapts Cal's framework-neutral Rust domain and persistence behavior to Note's application state, authorization, events, capabilities, typed frontend boundary, and startup model. It does not port Cal's Svelte shell, activate Agenda/Month UI, modify `note-data.json`, import existing Cal application data, or create a unified Note backup format.

### Implementation completed

- Added `<Note app data>/calendar.sqlite3` with six embedded SQLx migrations for calendars, timed/all-day events, recurrence, settings, reminders/delivery state, occurrence overrides, and import-source identities. A long-lived SQLite pool runs migrations once during asynchronous readiness initialization; notes remain in their existing JSON store and no cross-store transaction is implied.
- Added validated domain types and repositories for timed and all-day events, IANA time zones, half-open date/instant ranges, revisions, recurrence rules, occurrence projection, occurrence replacement/cancellation, settings, bounded search, and bidirectional opaque agenda cursors. Capacity ceilings fail explicitly rather than returning a silently incomplete result.
- Added main-window-only typed commands for list/page/search/get/create/update/delete, occurrence update/delete, settings, readiness/retry, notification permission/status, ICS import/export, and calendar backup/restore. Sensitive requests reject unknown fields and renderer responses do not expose SQL, database handles, or private paths.
- Added `frontend/src/native/calendarClient.ts` as the typed React boundary. Its command union is cross-checked against the build manifest, Rust invoke handler, and per-window capabilities.
- Added a dedicated widget-only `calendar_widget_agenda` command. Rust computes the current seven-civil-day range, caps output at 50 items, and returns only event ID, occurrence key, title, and time. The widget cannot call the general calendar read APIs or any mutation.
- Added asynchronous calendar readiness with `loading`, `ready`, and path-free `unavailable` states plus retry. `AppState` construction performs no database work, setup spawns initialization, calendar commands wait through a bounded readiness path, reminders start only after readiness, and note persistence never waits for calendar startup.
- Split note and calendar mutation admission. Each domain rejects conflicting same-domain work without queuing, while an unavailable/loading calendar cannot block an independent note save. Calendar commands await readiness before taking the calendar gate.
- Added the desktop reminder scheduler and notification permission boundary. Scheduling, horizon, candidate, delivery, catch-up, and polling work are bounded. Event/occurrence mutations and restore synchronize through a dispatch barrier and data generation; a claimed reminder is revalidated under the barrier immediately before OS enqueue. Sensitive status and catch-up payloads target only `main`.
- Added bounded ICS import preview/commit with native file selection, UTF-8 and byte/line/property/component/depth/item limits, strict temporal/domain parsing, source identity classification, explicit `skipExisting`/`createCopies` duplicate policy, private in-memory staging, opaque UUID session IDs, 15-minute expiry, transactional commit, and replay/mismatch rejection.
- Added bounded ICS export with validated inclusive date selection, recurrence/override materialization, stable UIDs, UTC timestamps, RFC text escaping and UTF-8 line folding, bounded complete output, private temporary files, synchronization, and no-clobber atomic publication.
- Added calendar-only backup and two-step restore. Backups use SQLite `VACUUM INTO`, private no-clobber staging, `quick_check`, `integrity_check`, foreign-key verification, and sync-before-publication. Restore stages a bounded immutable snapshot, rejects the live database, validates physical/logical size, exact migration lineage/checksums, schema definitions/columns, integrity and foreign keys, reinspects at commit, creates a verified recovery backup, replaces a fixed table set transactionally, and rolls back on injected failure.
- Added the Windows Common Controls v6 manifest through the Rust build script so notification-plugin-linked all-target tests and the application binary load consistently. Tauri's generated application manifest is disabled only for the Windows resource that would otherwise conflict; command metadata remains generated normally.

### Phase 2 verification evidence

| Evidence | Result |
|---|---|
| Rust formatting | Final `cargo fmt --all -- --check` passed in 0.524 s. |
| Rust lint | Final strict `cargo clippy --all-targets --all-features --locked --offline -- -D warnings` passed in 3.958 s. |
| Rust tests | Final `cargo test --all-targets --locked --offline` passed **160/160** in 1.662 s. The total includes the added persistent cross-midnight event test. |
| Release build | `cargo build --release --locked --offline` passed in 36.464 s after the final production-code repair; the later test-only overnight addition does not affect release code. |
| Frontend production build | Passed in 3.960 s; TypeScript and Vite completed and the auxiliary CSP/chunk verifier passed. The known `MainSurface` warning remains at 545.05 kB. |
| Existing Playwright suite | Separate commit `b3ad26584731e49bf5b564fe265338a789182752` deliberately sets the supported default to one worker because the suite shares one Vite server and host/browser resources such as clipboard. The unchanged `npm.cmd run test:e2e` passed 39/39 three consecutive times in 27.0 s, 28.0 s, and 27.0 s (117/117 aggregate); both formerly intermittent titles passed on every run. One initial post-commit sandboxed invocation failed before tests because Vite could not read the workspace/config under sandbox access; three approved local-server runs passed, so that invocation is environment-only. |
| Aggregate diff | `git diff --check` passed. Source/security reviews are GO after repairs. The sealed Codex Security diff scan covered the 32/32-file production implementation snapshot and reported Critical 0, High 0, Medium 0, Low 0. The post-seal delta is limited to one `#[cfg(test)]` overnight test, the separate Playwright config-only commit `b3ad26584731e49bf5b564fe265338a789182752`, and these architecture/ADR edits; the final aggregate review inspected those non-production changes separately, and production implementation remained unchanged, so a second security scan was not required. CodeRabbit CLI was unavailable. |

Before the worker policy, historical default 8-worker runs failed 38/39 twice, on unrelated existing tests:

1. Run one passed 38/39 in 8.438 s. `[chromium] › tests/e2e/image-paste.spec.ts:32:1 › pasting a clipboard image while editing a textbox inserts a rich image` failed at line 39 because `.text-block-image` was expected to have count `0` but had count `1` after 5 seconds.
2. Run two passed 38/39 in 9.030 s. The first failure passed, while `[chromium] › tests/e2e/surface-routing.spec.ts:17:3 › Widget renders an isolated accessible placeholder` failed at line 24 because `getByRole("main")` was not found/visible after 5 seconds.

`npm.cmd run test:e2e -- tests/e2e/image-paste.spec.ts` passed all four image-paste cases in 3.413 s, and the explicit `npm.cmd run test:e2e -- --workers=1` passed all 39 tests in 28.657 s, including both previously failing titles. The failures moved between unrelated cases on identical source and each passed unchanged in a later run, supporting runner/shared-resource isolation timing flakiness rather than a Phase 2 product regression. Commit `b3ad26584731e49bf5b564fe265338a789182752` therefore makes one worker the deliberate supported default for the shared Vite server and host/browser resources. This policy is not a claim that parallel mode is fixed: it trades approximately 27–28 s runtime and less concurrency diagnostics for repeatable default evidence. An optional multi-worker stress/debug lane is future, non-blocking work.

### Test coverage disposition

The 160-test native suite covers timed and all-day persistence; non-hour-offset and DST time-zone projection; ambiguous/nonexistent local times; overnight events crossing civil midnight; half-open intersections; recurrence grammar/count/until/monthly/yearly/leap-day/DST behavior; bounded expansion; occurrence replacement and cancellation; optimistic revision conflicts; search escaping/candidate/result limits; agenda cursor and exhaustion behavior; settings; reminders, catch-up, idempotence and stale-claim edit/delete/move/cancel/restore races; ICS parser/import/export limits and rollback; backup/WAL/integrity/schema/migration/recovery/rollback behavior; readiness/retry; independent mutation admission; widget DTO/range limits; individual capability-list and forbidden-window contracts; and existing bounded atomic note persistence. Exact cross-file parity among the build command manifest, Rust invoke handler, TypeScript command union, and capability grants was established by the final manual aggregate audit, not by one native parity test.

### Startup evidence

Calendar initialization is structurally off the startup critical section: native setup manages `AppState` immediately and spawns SQLite open/migration, readiness is observable and retryable, commands await it, reminder construction begins only after success, and tests hold an injected initializer blocked while note admission and note persistence continue.

Five warm launches of the final local Windows release reached a responding native `Note` window in 179.7–254.7 ms, with a 207.3 ms median. This is a time-to-responsive-window sample, not first-paint or first-interaction latency. A WebView2 diagnostics attempt did not expose a target/window within 30 seconds and was cleaned up; because Phase 0 also lacked a reliable first-frame signal, no percentage first-frame regression is claimed. Frontend/native performance marks and a supported first-frame harness remain Phase 9 work.

### Cal integrity proof

- Final Cal `HEAD` is exactly `032c4703bdb04d470b1aee5e23fb8c1c57b249c4`.
- The Phase 0 comparison command, `git status --porcelain=v1`, still produces exactly 22 lines and 820 UTF-8 bytes, byte-for-byte identical to the embedded baseline. Both streams have SHA-256 `bfa387d2e6c85f3ae8ccf728ad44e1cdc49adbedb5ae91701f4c752a09ebae34`.
- `git status --porcelain=v1 --untracked-files=all` necessarily expands the baseline `?? evals/` directory into its two existing files, producing 23 lines/872 bytes and SHA-256 `4d2c1a4f73d49afcdca90c5b1edd02898033c08e2318d6eb096a13885a0f97f1`. That flag cannot produce the recorded directory-collapsed 820-byte baseline; the difference is command semantics, not a Cal mutation.
- Cal was used read-only and no Cal process, build, formatter, test, staging, commit, or file write was performed.

### Independent review outcomes

The initial core scaffold was rejected because recurrence semantics were incomplete and was replaced with a faithful bounded adaptation. Aggregate review then found and repaired synchronous startup I/O, a stale reminder dispatch race, globally broadcast reminder details, overbroad widget reads, and cross-domain mutation admission. Two post-repair Sol source rechecks returned GO. The formal CodeRabbit path was unavailable because the CLI was not installed; manual Sol review provided the code-review fallback. The sealed Codex Security workflow completed with no reportable findings and complete 32-file coverage for the production implementation snapshot. After sealing, the only changes were the required `#[cfg(test)]` overnight case, the Playwright worker-policy commit, and this Phase 2 evidence/ADR documentation; the final integrator separately reviewed the non-production delta and found no security-relevant production change, so a second scan was not required. Final QA is green for native, build, the supported default Playwright command (39/39 three consecutive runs), Cal integrity, and diff checks. The historical 8-worker failures remain diagnosed as runner/shared-resource flakiness; parallel mode is not claimed fixed.

### Explicitly unverified

- A reliable first-painted or first-interactive frame measurement and a percentage comparison with Phase 0.
- Live native notification permission prompts and OS notification delivery on supported platforms.
- Live native dialogs and user-selected import/export/backup/restore flows outside the Rust service tests.
- Windows DACL/no-follow and symlink edge behavior; Unix private-file mode tests are compile-time platform-gated.
- macOS, Linux X11, and Linux Wayland builds and runtime behavior.
- Multi-worker Playwright stress/debug behavior beyond the supported one-worker default; this optional lane is future non-blocking work, and parallel mode is not claimed fixed.
- Agenda/Month/editor UI, actual widget activation, assistant/model/voice integration, existing Cal-data migration, and unified Note backup; these remain later phases.

## Phase 2 acceptance gate

Phase 2 is **accepted complete**. The calendar kernel and every Phase 2 native acceptance item are green. The supported default Playwright policy is one worker, deliberately recorded in commit `b3ad26584731e49bf5b564fe265338a789182752` for the suite's shared Vite server and host/browser resources; the unchanged default command passed 39/39 three consecutive times (27.0 s, 28.0 s, 27.0 s; 117/117 aggregate). This accepts the supported serial lane without claiming that multi-worker parallel mode is fixed.

- [x] SQLite initialization/migrations and separate `<Note app data>/calendar.sqlite3` are implemented without altering `note-data.json`.
- [x] Typed bounded commands create, query, page, search, update, and delete events/occurrences without exposing raw storage to React.
- [x] Recurrence, time zones, overnight/all-day/timed events, revisions, settings, reminders, notification state, ICS, backup/restore, and change events are implemented and tested.
- [x] Calendar startup is asynchronous, readiness is explicit, reminders start after readiness, and independent note persistence is not blocked.
- [x] Main/widget authorization, strict DTOs, bounds, private staging, atomic/no-clobber publication, verified restore, and fail-closed capacity behavior are covered.
- [x] Rust format, strict lint, 160/160 tests, release build, frontend production build, serial Playwright 39/39, aggregate diff check, source reviews, and the sealed production-snapshot security scan plus post-seal test/docs aggregate review pass.
- [x] The unchanged default `npm.cmd run test:e2e` passes 39/39 three consecutive times after the deliberate one-worker policy in `b3ad26584731e49bf5b564fe265338a789182752` (27.0 s, 28.0 s, 27.0 s; 117/117 aggregate), including both formerly intermittent titles on every run.
- [x] Cal `HEAD` and the exact Phase 0 820-byte/default-porcelain stream are unchanged.

## Phase 2 risk disposition

| Severity | Phase 2 disposition | Residual mitigation / next gate |
|---|---|---|
| High | Calendar data validation, revisions, recurrence limits, transactional persistence, import staging, and verified restore are implemented and tested. | Retain exact schema/migration verification and failure-injection coverage; exercise native dialogs and filesystem controls on every supported platform. |
| High | General calendar commands are main-only; widget access is a dedicated minimal bounded read and sensitive reminder events target `main`. | Keep capability/build/invoke/client parity tests and Rust caller checks authoritative when Phase 3 and Phase 7 activate UI. |
| High | Reminder stale-claim races across edit/delete/move/cancel/restore are protected by the dispatch barrier, generation, and final revalidation. | Add real OS notification lifecycle tests and suspend/resume soak coverage before release. |
| Medium | Initialization is asynchronous and cannot block note persistence; warm responsive-window median is 207.3 ms. | Add first-paint/first-interaction and calendar-readiness performance marks in Phase 9; do not interpret window readiness as painted UI. |
| Medium | The supported Playwright default uses one worker because the suite shares one Vite server and host/browser resources such as clipboard. It is repeatably green, but slower (~27–28 s) and provides less concurrency diagnostics; multi-worker parallel mode is not claimed fixed. | Keep the one-worker policy as the acceptance lane. Optionally add a separate multi-worker stress/debug lane later; it is non-blocking for Phase 2. |
| Medium | Calendar-only backup is verified; note/calendar unified backup and existing Cal-data migration are intentionally deferred. | Implement the explicit recovery-backed Cal migration and versioned unified backup in Phase 8 without weakening the calendar snapshot checks. |
| Low | `MainSurface` remains 545.05 kB and triggers the existing Vite warning. | Keep Phase 3 calendar UI lazy and preserve auxiliary chunk isolation; measure parse/render costs before release. |

## Phase 2 evidence references

- `backend/src-tauri/migrations/0001_local_calendar.sql` through `0006_event_import_sources.sql`
- `backend/src-tauri/src/app_state.rs`
- `backend/src-tauri/src/calendar/api.rs`
- `backend/src-tauri/src/calendar/domain.rs`
- `backend/src-tauri/src/calendar/recurrence.rs`
- `backend/src-tauri/src/calendar/reminders.rs`
- `backend/src-tauri/src/calendar/import.rs`
- `backend/src-tauri/src/calendar/export.rs`
- `backend/src-tauri/src/calendar/backup.rs`
- `backend/src-tauri/src/calendar/service.rs`
- `backend/src-tauri/src/calendar/settings.rs`
- `backend/src-tauri/src/calendar_store/sqlite.rs`
- `backend/src-tauri/src/calendar_store/backup.rs`
- `backend/src-tauri/src/calendar_store/private_file.rs`
- `backend/src-tauri/capabilities/main.json`
- `backend/src-tauri/capabilities/widget.json`
- `backend/src-tauri/src/lib.rs`
- `frontend/src/native/calendarClient.ts`
- Codex Security scan `6200646_20260724T191413Z`

## Phase 3 implementation record

Phase 3 is **accepted complete**. It adds Note-native Calendar workspace UI while retaining the Phase 2 Rust calendar service as the authoritative data, validation, revision, recurrence, and reminder boundary. The implementation does not modify the native calendar backend, `note-data.json`, Cal, auxiliary surfaces, import/migration, unified backup, assistant, model, voice, or widget scope.

### Implementation completed

- Added one stable Agenda system tab with internal `Agenda` and `Month` modes. `App.tsx` composes and lazy-loads the calendar workspace rather than owning calendar query/render logic; existing note tabs, canvas behavior, and persistence remain intact.
- Added bounded Agenda pages of exactly 32 days with earlier/later navigation, at most 64 retained days, occurrence de-duplication, stale request-generation discard, explicit source-owned loading/errors/settings snapshots, and `ResizeObserver`-measured windowed rendering when more than 100 occurrences are present.
- Added a 42-day Month grid with correct grid semantics, no more than two visible items per day, a bounded `+N` affordance, and a detail panel. Date controls retain 44 px targets; visible events and `+N` span the available cell content.
- Added bounded calendar search: 250 ms debounce, at most 200 input characters, 50 results, and a maximum 366-day range.
- Added a typed client-owned, coalesced refresh listener for `note://calendar-changed`; the UI does not create a second mutable calendar source. Projection preserves half-open intervals, display-zone conversion, all-day ranges, and overnight/timed continuation behavior.
- Added an accessible controlled event editor with source-owned errors, settings snapshot serialization, revision-conflict handling that preserves the appropriate draft, occurrence/series scope, native-valid recurrence and reminder controls, explicit delete confirmation, and modal isolation.
- Added responsive light/dark/forced-colors/reduced-motion styling, including touch-sized calendar controls and repaired inherited global 30 px button sizing. Month-specific width rules preserve date targets and cell-spanning event/`+N` controls.

### Verification evidence

| Evidence | Result |
|---|---|
| TypeScript | Final `npx tsc --noEmit` passed. |
| Frontend production build | `npm.cmd run build` passed: 129 modules and auxiliary CSP/chunk checks passed. The known `MainSurface` chunk remains over 500 kB. |
| Focused calendar UI | `npx.cmd playwright test tests/e2e/calendar-workspace.spec.ts` passed **22/22**. |
| Focused workspace aggregate | Final focused workspace aggregate passed **40/40**. |
| Full supported frontend E2E | Final `npm.cmd run test:e2e` passed **65/65** in **52.5 s**. |
| Native regression evidence | Final rerun passed `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features --locked --offline -- -D warnings`, and `cargo test --all-targets --locked --offline` (**160/160**). Backend source was unchanged. |
| Aggregate diff | `git diff --check` passed. |
| Cal integrity | Read-only Cal stayed at `032c4703bdb04d470b1aee5e23fb8c1c57b249c4`; default porcelain remained 22 lines/820 bytes with SHA-256 `bfa387d2e6c85f3ae8ccf728ad44e1cdc49adbedb5ae91701f4c752a09ebae34`. |

Two intermediate full-suite runs passed 64/65 but failed differently at the existing `tests/e2e/image-paste.spec.ts:32`; the focused image-paste suite passed 4/4. The final post-repair full run passed 65/65, supporting nondeterministic shared-runner isolation flakiness rather than a Phase 3 product failure. This history is retained as evidence, not hidden as a clean first-run claim.

### Independent review outcomes

- Code review: GO, 0 findings.
- Security review: GO, 0 findings.
- Accessibility review: initial 1 Must Fix and 2 Should Fix findings were repaired; re-review GO, 0 Must Fix and 0 Should Fix.
- UX review: GO, 0 findings.
- Performance review: GO, 0 blockers; one low/nit future optimization to profile scroll work through `requestAnimationFrame` before adding further work.
- QA and visual review: GO after the inherited global 30 px button sizing and Month selector specificity were repaired. Six ephemeral QA PNG scenarios were directly inspected; screenshots are evidence only and are not committed artifacts.

### Explicitly unverified

- Live Tauri UI authorization and persistence against the real database; frontend checks use mocked native calls and Rust remains authoritative.
- Real screen-reader use and automated contrast measurement.
- Production performance, scroll-stress behavior, telemetry, and first-paint measurement.
- Cross-platform runtime behavior and native notification/dialog flows.
- Pixel-by-pixel visual-regression automation.

### Phase 3 acceptance checklist

- [x] Agenda is one stable system tab with internal Agenda/Month modes; it is not a generated Note page.
- [x] Bounded Agenda/Month/search query and rendering limits, generation handling, refresh coalescing, and projection semantics are covered by focused tests.
- [x] The editor preserves drafts across revision conflicts, supports occurrence/series native-valid edits and reminders, confirms deletion, and isolates its modal interaction.
- [x] Responsive, dark, forced-colors, reduced-motion, keyboard/grid, and 44 px control behavior are covered by automated and direct visual QA.
- [x] Final frontend E2E is 65/65; production build, TypeScript, diff check, reviews, and Cal integrity evidence are green.

### Phase 3 risk disposition

| Severity | Phase 3 disposition | Residual mitigation / next gate |
|---|---|---|
| High | Calendar mutation correctness, authorization, recurrence, reminders, and durable persistence remain native Rust authority; UI uses bounded typed calls and expected revisions. | Exercise real native UI/database and caller-authorization flows before release. |
| Medium | Query/render work is explicitly bounded and windowed, but production scroll/load telemetry and first-paint evidence are absent. | Profile realistic large calendars and add performance marks in Phase 9. |
| Medium | One-worker E2E is the supported shared-resource lane; intermediate image-paste failures were isolated and final full evidence is green. | Keep serial acceptance; use a separate multi-worker stress lane when diagnosing runner isolation. |
| Low | Ephemeral visual inspection caught inherited button sizing; no committed pixel-baseline automation exists. | Add visual-regression coverage if UI churn justifies its maintenance cost. |

### Phase 3 evidence references

- `frontend/src/features/calendar/CalendarWorkspace.tsx`
- `frontend/src/features/calendar/EventEditor.tsx`
- `frontend/src/features/calendar/calendar.css`
- `frontend/src/features/calendar/calendarUtils.ts`
- `frontend/src/native/calendarClient.ts`
- `frontend/tests/e2e/calendar-workspace.spec.ts`
- `frontend/tests/e2e/native-workspace.spec.ts`
- `frontend/tests/e2e/workspace-state.spec.ts`
- Ephemeral direct-inspection evidence: `C:\tmp\phase3-calendar-qa\` (not committed)

## Phase 4 implementation record

Phase 4 is **accepted complete** in commit `a0cb007`. Note owns one tool registry and provider-neutral assistant runtime. Bounded notes and live calendar reads run through typed native clients; calendar creation is a reviewed, expiring native confirmation rather than a model-controlled mutation. The assistant remains window-authorized and keeps llama-harness as the optional tool-capable adapter.

## Phase 5 implementation record

Phase 5 is **accepted complete** in commit `41c808a`. Models & AI is a native-owned provider/model center: Ollama setup is bounded and cancellable, direct native providers are chat-only, and llama-harness remains the tool-capable option. Credential drafts are provider-bound and write-only; native storage binds credentials to the persisted provider kind, normalized endpoint, and data-sharing classification. Renderer startup is local-state-only, legacy secret migration is failure-safe, and model-progress subscriptions are scoped to the settings surface.

## Phase 6 implementation record

Phase 6 is **accepted complete**. Native Rust owns microphone enumeration/selection, bounded CPAL capture, private WAV staging, fixed-argv Whisper transcription, managed model verification/install/cancel/remove, hold-to-talk registration, session/generation state, and targeted events. Capture starts are idempotent, deadline and Stop race through one terminal claim, stale results are discarded, and completed sessions clear for repeat recording.

Quick Command remains a restricted auxiliary surface. It handshakes after mounting listeners, receives a bounded current-generation replay, and may submit only a sanitized proposal to `main`; it cannot access assistant credentials, models, notes, calendar mutation, or storage directly. Main handles the proposal as explicit assistant prefill or review-only dictation/quick-capture text. The main-only Voice settings surface exposes opaque device selection, model lifecycle/progress/cancel, and global shortcut retry/conflict state.

Final Phase 6 evidence: production build passed; focused Phase 4 assistant E2E passed 83/83, Phase 5 Models E2E 23/23, native workspace 9/9, and Rust 233/233. The complete 180-case frontend matrix had 174 passing; the six failures are the known date-dependent calendar fixture expectations for July 2026 and are unrelated to voice. Cal remained unchanged at its recorded reference SHA and raw porcelain digest.

## Phase 7 implementation record

Phase 7 is **accepted complete**. Rust owns versioned, bounded `widget-state.json` preferences, the dynamic `widget` webview lifecycle, close-to-hide behavior, fixed size presets, lock state, tray actions, and a main-only placement request. Floating is the supported effective mode. A requested Desktop placement is persisted but truthfully reports `floating`, `attached: false`, and the sanitized `desktop_attachment_unavailable` fallback; no platform desktop-attachment adapter is claimed.

The widget is a separate code-split React surface with only a bounded seven-day/50-item agenda read, typed status, lock/resize, and open-Agenda actions. Its client validates exact native DTO schemas before state updates, rejects malformed or expanded events/responses, discards stale refreshes, and cannot access note data, credentials, providers, microphone, files, network, or calendar mutations. Native navigation is a fixed, main-targeted Calendar request; widget actions never obtain main-window routing authority. Tray initialization degrades to a sanitized unavailable status rather than preventing Note from launching.

Final Phase 7 evidence: Rust format/check/strict Clippy and all-target tests passed (244); TypeScript, widget E2E 9/9, focused Calendar navigation/placement/retry E2E 3/3, surface routing 5/5, production build with CSP/chunk isolation verification, and diff checks passed. The complete Calendar E2E wrapper timed out twice with EPIPE before a test-level result, so it is unverified here; the previously diagnosed six fixed-date July 2026 calendar-fixture failures remain unrelated and deferred. Packaged Tauri permission/event enforcement, Windows tray/window/focus behavior, and high-contrast/screen-reader runtime behavior still require manual desktop validation. Cal remained exactly at its recorded reference SHA and raw porcelain digest.
