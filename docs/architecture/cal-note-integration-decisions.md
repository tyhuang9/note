# Cal-to-Note Integration Decision Log

Status: Accepted architecture baseline

Date: 2026-07-24

Applies to: Note integration worktree at base SHA `d7fd7b13d0964ed631e846fe6a6cc1ed0add09d2`; Cal read-only reference SHA `032c4703bdb04d470b1aee5e23fb8c1c57b249c4`

## ADR-001 — Note and React remain primary

**Status:** Accepted

**Decision:** Keep Note's React/TypeScript/TipTap application, identifier, canvas, workbench, tabs, and visual language. Use Cal only as a read-only domain-infrastructure reference; do not introduce Svelte or Cal's shell.

**Rationale:** The product is an evolution of Note, and a second framework/shell would fragment UX, state, packaging, and security.

**Consequences:** Cal UI behavior is reimplemented as Note-native React features. Ported native code, commands, events, tests, and messages are adapted to Note contracts and `note://...` names.

## ADR-002 — Calendar data uses a separate SQLite database

**Status:** Accepted

**Decision:** Preserve notes in `note-data.json` and store calendars, events, recurrence, occurrence overrides, revisions, and reminder state in `<Note app data>/calendar.sqlite3`.

**Rationale:** Calendar queries, migrations, transactions, revisions, and recurrence need a relational store, while changing existing note persistence would add unrelated migration risk.

**Consequences:** The two stores do not share a transaction and remain independently recoverable. A later versioned backup coordinates verified snapshots. Moving notes to SQLite requires a separate ADR and migration review.

## ADR-003 — Agenda is a system view

**Status:** Accepted

**Decision:** Model Agenda and Month with a discriminated `WorkspaceView`, not as generated pages or blocks.

**Rationale:** Live calendar identity, occurrence keys, revisions, time zones, recurrence, and refresh semantics do not fit persisted note content.

**Consequences:** Agenda can participate in tabs and session restoration but cannot be renamed, filed, duplicated, or deleted like a note. Only an explicit future action may materialize a non-authoritative planning snapshot.

## ADR-004 — Auxiliary windows are restricted and floating is stable

**Status:** Accepted

**Decision:** Use distinct Tauri surfaces for `main`, `widget`, `quick-command`, and an optional later `event-editor`, with per-window capabilities and Rust caller-label authorization. Floating widget placement is the stable/default mode; desktop attachment is experimental.

**Rationale:** The surfaces have different data needs, latency budgets, and threat boundaries. Platform desktop attachment is not uniformly reliable.

**Consequences:** Main and widget visibility remain independent. Restricted surfaces do not receive credentials, broad note contents, microphone/provider access, arbitrary filesystem access, or unrestricted mutation. Desktop fallback reports requested and effective modes honestly.

## ADR-005 — Note owns one assistant tool registry

**Status:** Accepted

**Decision:** Consolidate provider chat, llama-harness adaptation, note actions, and calendar tools behind one provider-neutral runtime and one versioned Note-owned registry.

**Rationale:** Schemas, limits, authorization, confirmation, data sharing, and diagnostics must not vary by provider or UI path.

**Consequences:** Read tools may run automatically after bounded validation. Models never mutate storage directly. Calendar creates require validated review and an expiring native confirmation; update/delete remain deferred until revision and occurrence-scope controls are proven.

## ADR-006 — Rust is native authority

**Status:** Accepted

**Decision:** Keep sensitive and performance-critical capabilities behind bounded Rust commands and services, including storage, credentials, provider mediation where practical, voice, transcription, model management, shortcuts, windows, tray, import/export, backup/restore, and notifications.

**Rationale:** Native policy can enforce window identity, strict payloads, filesystem/process safety, response bounds, cancellation, and concurrency independently of renderer code.

**Consequences:** Frontend features use typed native clients. Raw SQL, arbitrary shell execution, broad filesystem authority, and model-controlled mutation are unavailable to renderers.

## ADR-007 — Credentials move to a native abstraction

**Status:** Accepted

**Decision:** Replace the existing plaintext `note.aiProviders.credentials.v1` webview storage with an OS-backed credential store or a clearly isolated native credential abstraction.

**Rationale:** `localStorage` is not an acceptable secret boundary for provider API keys.

**Consequences:** No new plaintext credential is stored in the renderer. Legacy migration must verify the native write before deleting the old value, be failure-aware and resumable, and never log or expose the secret to auxiliary windows.

## ADR-008 — Extract `App.tsx` incrementally before feature UI

**Status:** Accepted

**Decision:** Introduce surface, workspace, typed-client, assistant/settings, and feature boundaries through small behavior-preserving extractions before adding substantial calendar UI.

**Rationale:** The 7,096-line `App.tsx` owns mature canvas behavior and many unrelated domains; a rewrite would create disproportionate regression risk.

**Consequences:** The canvas is not redesigned as part of integration. Every extraction is tested, buildable, and reviewable, and `App.tsx` trends toward composition/routing rather than acquiring calendar, widget, voice, or model logic.

## ADR-009 — Models are app-managed, not bundled, and startup is nonblocking

**Status:** Accepted

**Decision:** Manage native Whisper and external local Ollama setup/status from Note, retain optional OpenAI-compatible providers, and keep llama-harness optional. Do not bundle large weights or wait for models/providers during startup.

**Rationale:** Large bundled runtimes increase package, licensing, update, disk, and cross-platform risk; local or remote services can be unavailable without affecting notes.

**Consequences:** Note owns progress, cancellation, compatibility, disk, verification, and removal UX for managed artifacts. Availability is lazy and recoverable. Ollama-backed inference is not described as embedded.

## ADR-010 — Existing Cal data imports explicitly and transactionally

**Status:** Accepted

**Decision:** Add Cal import only after Note's calendar schema is stable, through explicit selection/detection, read-only validation, preview, duplicate policy, recovery backup, transactional import, and post-import verification.

**Rationale:** Cal and Note have different identities and application-data directories, and the Cal checkout/data must remain untouched.

**Consequences:** No silent move, delete, or automatic migration occurs. Invalid sources are rejected, the original remains intact, and unified backup excludes credentials, temporary recordings, and model weights by default.

## ADR-011 — Strict save, tolerant load, and bounded raw notes IPC

**Status:** Accepted in Phase 1

**Decision:** Keep the backward-compatible persisted notes representation tolerant on load, while making the save path strict and bounded. The typed notes client sends raw JSON bytes; Rust rejects oversized raw payloads before deserialization, admits only `deny_unknown_fields` save DTOs, applies cumulative record/string/rich-content/decoded-image/output limits, and publishes validated data through private atomic staging.

**Rationale:** Existing Note data must remain readable as the wire contract evolves, but renderer-controlled writes need an explicit schema and resource boundary before nested deserialization/allocation, validation, or replacement of the sole note-data file.

**Consequences:** Persisted files with unknown fields remain readable for forward compatibility, while unknown save fields and malformed or over-limit payloads fail with structured errors. Unknown persisted fields are not promised to survive a later save. A failed save leaves the prior file intact. This is a notes-only Phase 1 boundary; calendar storage and cross-file transactions remain later phases.

## ADR-012 — Per-surface HTML CSP isolation

**Status:** Accepted in Phase 1

**Decision:** Emit five independent HTML entries for main and auxiliary surfaces. Auxiliary Tauri windows use separate `create: false` entries and receive a restrictive per-document meta CSP in addition to the global Tauri CSP. Capabilities are separate exact-label files for `main`, `widget`, `quick-command`, and `event-editor`, with only the minimum event listen/unlisten and main note persistence permissions; renderer event emission and broad default permissions are excluded.

**Rationale:** HTML entry isolation prevents auxiliary surfaces from loading the full canvas bundle and gives each document an independent egress and media policy. Capabilities and Rust caller-label checks are defense in depth, not interchangeable authorities.

**Consequences:** The auxiliary build verifier can prove CSP and chunk isolation for each generated document. Auxiliary windows remain inert until native creation, cannot persist notes, and cannot emit renderer events. Live native creation/denial and cross-platform WebView behavior still require release validation.
