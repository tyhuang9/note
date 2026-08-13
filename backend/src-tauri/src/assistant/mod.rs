use std::{
    collections::{BTreeSet, HashMap},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{State, WebviewWindow};
use tokio::sync::Notify;

use crate::{
    app_state::AppState,
    calendar::{
        api::{
            emit_calendar_changed, ensure_main_window, EventDraftRequest, EventResponse,
            EventTimeRequest, EventTimeResponse,
        },
        domain::{
            EventId, EventQueryRange, EventRecord, EventSearchQuery, EventTime, OccurrenceRecord,
        },
        error::ApiError,
    },
};

const SCHEMA_VERSION: u32 = 1;
const CREATE_TOOL_ID: &str = "calendar.create_event";
const MAX_TOOL_INPUT_BYTES: usize = 32 * 1024;
const MAX_TOOL_RESULT_BYTES: usize = 128 * 1024;
const MAX_QUERY_RESULTS: i64 = 25;
const MAX_SEARCH_RESULTS: i64 = 20;
const MAX_ID_CHARS: usize = 128;
const PENDING_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING_ACTIONS: usize = 64;
const MAX_INFERRED_FIELDS: usize = 9;
const MAX_RESULT_TITLE_CHARS: usize = 200;
const MAX_RESULT_LOCATION_CHARS: usize = 200;
const MAX_RESULT_NOTES_CHARS: usize = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToolRisk {
    ReadOnly,
    Write,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToolInputSchema {
    QueryV1,
    SearchV1,
    GetEventV1,
    CreateEventV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToolOutputSchema {
    OccurrenceListV1,
    EventV1,
    ReviewedCreateV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderDataSharing {
    SanitizedCalendarContent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CancellationPolicy {
    BoundedNativeCall,
    BeforeConfirmation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ToolDefinition {
    id: &'static str,
    schema_version: u32,
    input_schema: ToolInputSchema,
    output_schema: ToolOutputSchema,
    risk: ToolRisk,
    confirmation_required: bool,
    maximum_results: Option<i64>,
    maximum_result_bytes: usize,
    authorized_windows: &'static [&'static str],
    provider_data_sharing: ProviderDataSharing,
    cancellation: CancellationPolicy,
}

const TOOL_REGISTRY: [ToolDefinition; 4] = [
    ToolDefinition {
        id: "calendar.query",
        schema_version: SCHEMA_VERSION,
        input_schema: ToolInputSchema::QueryV1,
        output_schema: ToolOutputSchema::OccurrenceListV1,
        risk: ToolRisk::ReadOnly,
        confirmation_required: false,
        maximum_results: Some(MAX_QUERY_RESULTS),
        maximum_result_bytes: MAX_TOOL_RESULT_BYTES,
        authorized_windows: &["main"],
        provider_data_sharing: ProviderDataSharing::SanitizedCalendarContent,
        cancellation: CancellationPolicy::BoundedNativeCall,
    },
    ToolDefinition {
        id: "calendar.search",
        schema_version: SCHEMA_VERSION,
        input_schema: ToolInputSchema::SearchV1,
        output_schema: ToolOutputSchema::OccurrenceListV1,
        risk: ToolRisk::ReadOnly,
        confirmation_required: false,
        maximum_results: Some(MAX_SEARCH_RESULTS),
        maximum_result_bytes: MAX_TOOL_RESULT_BYTES,
        authorized_windows: &["main"],
        provider_data_sharing: ProviderDataSharing::SanitizedCalendarContent,
        cancellation: CancellationPolicy::BoundedNativeCall,
    },
    ToolDefinition {
        id: "calendar.get_event",
        schema_version: SCHEMA_VERSION,
        input_schema: ToolInputSchema::GetEventV1,
        output_schema: ToolOutputSchema::EventV1,
        risk: ToolRisk::ReadOnly,
        confirmation_required: false,
        maximum_results: Some(1),
        maximum_result_bytes: MAX_TOOL_RESULT_BYTES,
        authorized_windows: &["main"],
        provider_data_sharing: ProviderDataSharing::SanitizedCalendarContent,
        cancellation: CancellationPolicy::BoundedNativeCall,
    },
    ToolDefinition {
        id: CREATE_TOOL_ID,
        schema_version: SCHEMA_VERSION,
        input_schema: ToolInputSchema::CreateEventV1,
        output_schema: ToolOutputSchema::ReviewedCreateV1,
        risk: ToolRisk::Write,
        confirmation_required: true,
        maximum_results: Some(1),
        maximum_result_bytes: MAX_TOOL_RESULT_BYTES,
        authorized_windows: &["main"],
        provider_data_sharing: ProviderDataSharing::SanitizedCalendarContent,
        cancellation: CancellationPolicy::BeforeConfirmation,
    },
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolExecuteRequest {
    tool_id: String,
    schema_version: u32,
    input: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecuteResponse {
    tool_id: String,
    schema_version: u32,
    result: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryInput {
    start_utc_ms: i64,
    end_utc_ms: i64,
    start_date: String,
    end_date_exclusive: String,
    limit: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchInput {
    query: String,
    start_utc_ms: i64,
    end_utc_ms: i64,
    start_date: String,
    end_date_exclusive: String,
    limit: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetEventInput {
    event_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
enum InferredField {
    Title,
    Time,
    TimeZone,
    Duration,
    AllDay,
    Recurrence,
    Reminders,
    Location,
    Notes,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateEventInput {
    event: EventDraftRequest,
    #[serde(default)]
    inferred_fields: Vec<InferredField>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateProposalRequest {
    run_id: String,
    tool_call_id: String,
    tool_id: String,
    schema_version: u32,
    input: CreateEventInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateReviseRequest {
    token: String,
    run_id: String,
    tool_call_id: String,
    input: CreateEventInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTerminalRequest {
    token: String,
    run_id: String,
    tool_call_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReviewFieldSource {
    Model,
    Inferred,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewFieldSources {
    title: ReviewFieldSource,
    time: ReviewFieldSource,
    time_zone: ReviewFieldSource,
    duration: ReviewFieldSource,
    all_day: ReviewFieldSource,
    recurrence: ReviewFieldSource,
    reminders: ReviewFieldSource,
    location: ReviewFieldSource,
    notes: ReviewFieldSource,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "temporalKind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum EventReviewTime {
    Timed {
        local_start: String,
        local_end: String,
        time_zone: String,
        duration_minutes: f64,
    },
    AllDay {
        start_date: String,
        end_date_exclusive: String,
        day_count: i64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventReview {
    title: String,
    notes: Option<String>,
    location: Option<String>,
    time: EventReviewTime,
    recurrence_rule: Option<String>,
    reminder_offsets_minutes: Vec<i64>,
    source: &'static str,
    field_sources: ReviewFieldSources,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProposalProviderResult {
    RequiresConfirmation { review: EventReview },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProposalResponse {
    token: String,
    expires_at_utc_ms: i64,
    run_id: String,
    tool_call_id: String,
    tool_id: &'static str,
    schema_version: u32,
    review: EventReview,
    provider_result: ProposalProviderResult,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantCalendarEvent {
    event_id: String,
    title: String,
    notes: Option<String>,
    location: Option<String>,
    time: EventTimeResponse,
    recurrence_rule: Option<String>,
    reminder_offsets_minutes: Vec<i64>,
    revision: i64,
    source: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    truncated_fields: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConfirmProviderResult {
    Created { event: AssistantCalendarEvent },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConfirmResponse {
    status: &'static str,
    event: AssistantCalendarEvent,
    provider_result: ConfirmProviderResult,
    replayed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CancelProviderResult {
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCancelResponse {
    status: &'static str,
    provider_result: CancelProviderResult,
    replayed: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationAcknowledgeMode {
    ExactCreatedOutcomeReceived,
    AgendaInspected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconciliationAcknowledgeRequest {
    mode: ReconciliationAcknowledgeMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationState {
    Clear,
    ReconciliationRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationStatusResponse {
    state: ReconciliationState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationAcknowledgeResponse {
    state: ReconciliationState,
    acknowledged: bool,
    mode: ReconciliationAcknowledgeMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantOccurrence {
    event_id: String,
    occurrence_key: String,
    title: String,
    notes: Option<String>,
    location: Option<String>,
    time: EventTimeResponse,
    recurrence_rule: Option<String>,
    reminder_offsets_minutes: Vec<i64>,
    revision: i64,
    source: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    truncated_fields: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Completeness {
    Complete,
    Truncated,
    UnknownBeyondLimit,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OccurrenceListResult {
    items: Vec<AssistantOccurrence>,
    completeness: Completeness,
    omitted_count: Option<usize>,
}

#[derive(Clone, PartialEq, Eq)]
struct ProposalIdentity {
    run_id: String,
    tool_call_id: String,
}

struct PreparedProposal {
    input: CreateEventInput,
    review: EventReview,
    digest: [u8; 32],
}

enum PendingStatus {
    Pending,
    Executing,
    Confirmed(Box<Result<AssistantCalendarEvent, ApiError>>),
    Cancelled,
}

struct PendingAction {
    identity: ProposalIdentity,
    input: CreateEventInput,
    review: EventReview,
    digest: [u8; 32],
    expires_at: Instant,
    expires_at_utc_ms: i64,
    status: PendingStatus,
    changed: std::sync::Arc<Notify>,
}

#[derive(Default)]
pub(crate) struct AssistantState {
    pending: Mutex<HashMap<String, PendingAction>>,
}

enum ConfirmationLease {
    Execute(CreateEventInput),
    Replay(Result<AssistantCalendarEvent, ApiError>),
}

impl AssistantState {
    fn propose(&self, request: CreateProposalRequest) -> Result<CreateProposalResponse, ApiError> {
        validate_tool_context(&request.run_id, &request.tool_call_id)?;
        ensure_tool(&request.tool_id, request.schema_version, ToolRisk::Write)?;
        let prepared = prepare_create_input(request.input)?;
        let identity = ProposalIdentity {
            run_id: request.run_id,
            tool_call_id: request.tool_call_id,
        };
        self.insert_proposal(identity, prepared)
    }

    fn insert_proposal(
        &self,
        identity: ProposalIdentity,
        prepared: PreparedProposal,
    ) -> Result<CreateProposalResponse, ApiError> {
        let now = Instant::now();
        let expires_at_utc_ms = unix_time_ms()?.saturating_add(PENDING_TTL.as_millis() as i64);
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        prune_expired(&mut pending, now);
        if let Some((token, existing)) = pending
            .iter()
            .find(|(_, action)| action.identity == identity)
        {
            if existing.digest != prepared.digest {
                return Err(assistant_error(
                    "proposal_mismatch",
                    "This tool call already has a different validated proposal.",
                    Some("input"),
                ));
            }
            return match existing.status {
                PendingStatus::Pending => Ok(proposal_response(token.clone(), existing)),
                PendingStatus::Executing => Err(action_in_progress()),
                PendingStatus::Confirmed(_) | PendingStatus::Cancelled => Err(action_terminal()),
            };
        }
        if pending.len() >= MAX_PENDING_ACTIONS {
            return Err(assistant_error(
                "pending_action_limit",
                "Too many assistant actions are awaiting review. Finish or cancel one first.",
                None,
            ));
        }
        let token = unique_token(&pending)?;
        pending.insert(
            token.clone(),
            PendingAction {
                identity,
                input: prepared.input,
                review: prepared.review,
                digest: prepared.digest,
                expires_at: now + PENDING_TTL,
                expires_at_utc_ms,
                status: PendingStatus::Pending,
                changed: std::sync::Arc::new(Notify::new()),
            },
        );
        Ok(proposal_response(
            token.clone(),
            pending.get(&token).expect("inserted proposal"),
        ))
    }

    fn revise(&self, request: CreateReviseRequest) -> Result<CreateProposalResponse, ApiError> {
        validate_tool_context(&request.run_id, &request.tool_call_id)?;
        let prepared = prepare_create_input(request.input)?;
        let now = Instant::now();
        let expires_at_utc_ms = unix_time_ms()?.saturating_add(PENDING_TTL.as_millis() as i64);
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        prune_expired(&mut pending, now);
        let old = pending.get(&request.token).ok_or_else(action_unavailable)?;
        ensure_identity(old, &request.run_id, &request.tool_call_id)?;
        if !matches!(old.status, PendingStatus::Pending) {
            return Err(match old.status {
                PendingStatus::Executing => action_in_progress(),
                PendingStatus::Confirmed(_) | PendingStatus::Cancelled => action_terminal(),
                PendingStatus::Pending => unreachable!(),
            });
        }
        let identity = old.identity.clone();
        let new_token = unique_token(&pending)?;
        pending.remove(&request.token);
        pending.insert(
            new_token.clone(),
            PendingAction {
                identity,
                input: prepared.input,
                review: prepared.review,
                digest: prepared.digest,
                expires_at: now + PENDING_TTL,
                expires_at_utc_ms,
                status: PendingStatus::Pending,
                changed: std::sync::Arc::new(Notify::new()),
            },
        );
        Ok(proposal_response(
            new_token.clone(),
            pending.get(&new_token).expect("inserted revision"),
        ))
    }

    async fn acquire_confirmation(
        &self,
        request: &CreateTerminalRequest,
    ) -> Result<ConfirmationLease, ApiError> {
        validate_tool_context(&request.run_id, &request.tool_call_id)?;
        loop {
            let wait = {
                let now = Instant::now();
                let mut pending = self
                    .pending
                    .lock()
                    .unwrap_or_else(|value| value.into_inner());
                prune_expired(&mut pending, now);
                let action = pending
                    .get_mut(&request.token)
                    .ok_or_else(action_unavailable)?;
                ensure_identity(action, &request.run_id, &request.tool_call_id)?;
                match &action.status {
                    PendingStatus::Pending => {
                        action.status = PendingStatus::Executing;
                        return Ok(ConfirmationLease::Execute(action.input.clone()));
                    }
                    PendingStatus::Executing => Some(action.changed.clone().notified_owned()),
                    PendingStatus::Confirmed(result) => {
                        return Ok(ConfirmationLease::Replay(result.as_ref().clone()))
                    }
                    PendingStatus::Cancelled => return Err(action_terminal()),
                }
            };
            if let Some(wait) = wait {
                wait.await;
            }
        }
    }

    fn finish_confirmation(&self, token: &str, outcome: Result<AssistantCalendarEvent, ApiError>) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if let Some(action) = pending.get_mut(token) {
            if matches!(action.status, PendingStatus::Executing) {
                action.status = PendingStatus::Confirmed(Box::new(outcome));
                action.expires_at = Instant::now() + PENDING_TTL;
                action.changed.notify_waiters();
            }
        }
    }

    fn cancel(&self, request: CreateTerminalRequest) -> Result<CreateCancelResponse, ApiError> {
        validate_tool_context(&request.run_id, &request.tool_call_id)?;
        let now = Instant::now();
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        prune_expired(&mut pending, now);
        let action = pending
            .get_mut(&request.token)
            .ok_or_else(action_unavailable)?;
        ensure_identity(action, &request.run_id, &request.tool_call_id)?;
        match action.status {
            PendingStatus::Pending => {
                action.status = PendingStatus::Cancelled;
                action.expires_at = now + PENDING_TTL;
                Ok(cancel_response(false))
            }
            PendingStatus::Cancelled => Ok(cancel_response(true)),
            PendingStatus::Executing => Err(action_in_progress()),
            PendingStatus::Confirmed(_) => Err(action_terminal()),
        }
    }
}

#[tauri::command]
pub async fn assistant_calendar_tool_execute(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ToolExecuteRequest,
) -> Result<ToolExecuteResponse, ApiError> {
    let _timer = crate::performance::Timer::start(crate::performance::Operation::AssistantTool);
    ensure_main_window(&window)?;
    execute_read_tool(&state, request).await
}

#[tauri::command]
pub async fn assistant_calendar_create_propose(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CreateProposalRequest,
) -> Result<CreateProposalResponse, ApiError> {
    let _timer = crate::performance::Timer::start(crate::performance::Operation::AssistantTool);
    ensure_main_window(&window)?;
    propose_create_authorized(&state, request).await
}

#[tauri::command]
pub fn assistant_calendar_create_revise(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CreateReviseRequest,
) -> Result<CreateProposalResponse, ApiError> {
    ensure_main_window(&window)?;
    state.assistant.revise(request)
}

#[tauri::command]
pub async fn assistant_calendar_create_confirm(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CreateTerminalRequest,
) -> Result<CreateConfirmResponse, ApiError> {
    let _timer = crate::performance::Timer::start(crate::performance::Operation::AssistantTool);
    ensure_main_window(&window)?;
    match state.assistant.acquire_confirmation(&request).await? {
        ConfirmationLease::Replay(result) => confirm_response(result?, true),
        ConfirmationLease::Execute(input) => {
            let result = match prepare_create_input(input.clone()) {
                Ok(_) => create_assistant_event_authorized(&window, &state, input.event)
                    .await
                    .map(sanitize_created_event),
                Err(error) => Err(error),
            };
            state
                .assistant
                .finish_confirmation(&request.token, result.clone());
            confirm_response(result?, false)
        }
    }
}

#[tauri::command]
pub fn assistant_calendar_create_cancel(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: CreateTerminalRequest,
) -> Result<CreateCancelResponse, ApiError> {
    ensure_main_window(&window)?;
    state.assistant.cancel(request)
}

#[tauri::command]
pub async fn assistant_calendar_create_reconciliation_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ReconciliationStatusResponse, ApiError> {
    ensure_main_window(&window)?;
    reconciliation_status_authorized(&state).await
}

#[tauri::command]
pub async fn assistant_calendar_create_reconciliation_acknowledge(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: ReconciliationAcknowledgeRequest,
) -> Result<ReconciliationAcknowledgeResponse, ApiError> {
    ensure_main_window(&window)?;
    acknowledge_reconciliation_authorized(&state, request.mode).await
}

async fn propose_create_authorized(
    state: &AppState,
    request: CreateProposalRequest,
) -> Result<CreateProposalResponse, ApiError> {
    let runtime = state.calendar_runtime().await?;
    let _mutation = state.begin_calendar_mutation()?;
    if runtime
        .calendar
        .assistant_create_reconciliation_required()
        .await
        .map_err(ApiError::from)?
    {
        return Err(reconciliation_required());
    }
    state.assistant.propose(request)
}

async fn create_assistant_event_authorized(
    window: &WebviewWindow,
    state: &AppState,
    request: EventDraftRequest,
) -> Result<EventResponse, ApiError> {
    let draft = request.into_domain(None, Vec::new())?;
    let runtime = state.calendar_runtime().await?;
    let _mutation = state.begin_calendar_mutation()?;
    let created = runtime
        .calendar
        .create_assistant_event(draft)
        .await
        .map_err(ApiError::from)?;
    #[cfg(desktop)]
    crate::calendar::reminders::trigger_reminder_rebuild(window);
    emit_calendar_changed(window);
    Ok(created.into())
}

async fn reconciliation_status_authorized(
    state: &AppState,
) -> Result<ReconciliationStatusResponse, ApiError> {
    let required = state
        .calendar_runtime()
        .await?
        .calendar
        .assistant_create_reconciliation_required()
        .await
        .map_err(ApiError::from)?;
    Ok(ReconciliationStatusResponse {
        state: reconciliation_state(required),
    })
}

async fn acknowledge_reconciliation_authorized(
    state: &AppState,
    mode: ReconciliationAcknowledgeMode,
) -> Result<ReconciliationAcknowledgeResponse, ApiError> {
    let runtime = state.calendar_runtime().await?;
    let _mutation = state.begin_calendar_mutation()?;
    let acknowledged = runtime
        .calendar
        .acknowledge_assistant_create_reconciliation()
        .await
        .map_err(ApiError::from)?;
    Ok(ReconciliationAcknowledgeResponse {
        state: ReconciliationState::Clear,
        acknowledged,
        mode,
    })
}

const fn reconciliation_state(required: bool) -> ReconciliationState {
    if required {
        ReconciliationState::ReconciliationRequired
    } else {
        ReconciliationState::Clear
    }
}

async fn execute_read_tool(
    state: &AppState,
    request: ToolExecuteRequest,
) -> Result<ToolExecuteResponse, ApiError> {
    ensure_tool(&request.tool_id, request.schema_version, ToolRisk::ReadOnly)?;
    ensure_json_size(&request.input, MAX_TOOL_INPUT_BYTES, "input")?;
    let runtime = state.calendar_runtime().await?;
    let result = match request.tool_id.as_str() {
        "calendar.query" => {
            let input: QueryInput = strict_input(request.input)?;
            validate_limit(input.limit, MAX_QUERY_RESULTS)?;
            let range = EventQueryRange::validated(
                input.start_utc_ms,
                input.end_utc_ms,
                &input.start_date,
                &input.end_date_exclusive,
            )?;
            let records = runtime
                .calendar
                .list_events(range)
                .await
                .map_err(ApiError::from)?;
            let omitted = records.len().saturating_sub(input.limit as usize);
            let result = OccurrenceListResult {
                items: records
                    .into_iter()
                    .take(input.limit as usize)
                    .map(sanitize_occurrence)
                    .collect(),
                completeness: if omitted == 0 {
                    Completeness::Complete
                } else {
                    Completeness::Truncated
                },
                omitted_count: Some(omitted),
            };
            serde_json::to_value(result).map_err(|_| result_unavailable())?
        }
        "calendar.search" => {
            let input: SearchInput = strict_input(request.input)?;
            validate_limit(input.limit, MAX_SEARCH_RESULTS)?;
            let range = EventQueryRange::validated(
                input.start_utc_ms,
                input.end_utc_ms,
                &input.start_date,
                &input.end_date_exclusive,
            )?;
            let query = EventSearchQuery::validated(input.query, input.limit)?;
            let search_result = runtime
                .calendar
                .search_events(query, range)
                .await
                .map_err(ApiError::from)?;
            let reached_limit = search_result.occurrences.len() == input.limit as usize;
            let result = OccurrenceListResult {
                items: search_result
                    .occurrences
                    .into_iter()
                    .map(sanitize_occurrence)
                    .collect(),
                completeness: if search_result.has_more_candidates || reached_limit {
                    Completeness::UnknownBeyondLimit
                } else {
                    Completeness::Complete
                },
                omitted_count: None,
            };
            serde_json::to_value(result).map_err(|_| result_unavailable())?
        }
        "calendar.get_event" => {
            let input: GetEventInput = strict_input(request.input)?;
            let event = runtime
                .calendar
                .get_event(EventId::parse(&input.event_id)?)
                .await
                .map_err(ApiError::from)?;
            serde_json::to_value(sanitize_event(event)).map_err(|_| result_unavailable())?
        }
        _ => return Err(unsupported_tool()),
    };
    ensure_json_size(&result, MAX_TOOL_RESULT_BYTES, "result")?;
    Ok(ToolExecuteResponse {
        tool_id: request.tool_id,
        schema_version: request.schema_version,
        result,
    })
}

fn prepare_create_input(input: CreateEventInput) -> Result<PreparedProposal, ApiError> {
    if input.inferred_fields.len() > MAX_INFERRED_FIELDS {
        return Err(invalid_inferred_fields());
    }
    let inferred = input
        .inferred_fields
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if inferred.len() != input.inferred_fields.len() {
        return Err(invalid_inferred_fields());
    }
    let original_time = input.event.time.clone();
    let draft = input.event.clone().into_domain(None, Vec::new())?;
    let reminders = draft.reminder_offsets_minutes().to_vec();
    let (title, notes, location, time, recurrence) = draft.into_parts();
    let review_time = match (original_time, time) {
        (
            EventTimeRequest::Timed {
                local_start,
                local_end,
                time_zone,
            },
            EventTime::Timed {
                start_utc_ms,
                end_utc_ms,
                ..
            },
        ) => EventReviewTime::Timed {
            local_start,
            local_end,
            time_zone,
            duration_minutes: end_utc_ms.saturating_sub(start_utc_ms) as f64 / 60_000.0,
        },
        (
            EventTimeRequest::AllDay {
                start_date,
                end_date_exclusive,
            },
            EventTime::AllDay {
                start_date: parsed_start,
                end_date_exclusive: parsed_end,
            },
        ) => EventReviewTime::AllDay {
            start_date,
            end_date_exclusive,
            day_count: parsed_end.signed_duration_since(parsed_start).num_days(),
        },
        _ => return Err(result_unavailable()),
    };
    let source = |field| {
        if inferred.contains(&field) {
            ReviewFieldSource::Inferred
        } else {
            ReviewFieldSource::Model
        }
    };
    let review = EventReview {
        title,
        notes,
        location,
        time: review_time,
        recurrence_rule: recurrence.map(|rule| rule.source().to_owned()),
        reminder_offsets_minutes: reminders,
        source: "assistant_proposal",
        field_sources: ReviewFieldSources {
            title: source(InferredField::Title),
            time: source(InferredField::Time),
            time_zone: source(InferredField::TimeZone),
            duration: source(InferredField::Duration),
            all_day: source(InferredField::AllDay),
            recurrence: source(InferredField::Recurrence),
            reminders: source(InferredField::Reminders),
            location: source(InferredField::Location),
            notes: source(InferredField::Notes),
        },
    };
    ensure_serialized_size(&review, MAX_TOOL_INPUT_BYTES)?;
    let canonical =
        serde_json::to_vec(&(review.clone(), inferred)).map_err(|_| result_unavailable())?;
    let digest: [u8; 32] = Sha256::digest(canonical).into();
    Ok(PreparedProposal {
        input,
        review,
        digest,
    })
}

fn strict_input<T: DeserializeOwned>(input: Value) -> Result<T, ApiError> {
    serde_json::from_value(input).map_err(|_| {
        assistant_error(
            "invalid_tool_input",
            "The assistant tool input does not match the required schema.",
            Some("input"),
        )
    })
}

fn ensure_tool(id: &str, version: u32, risk: ToolRisk) -> Result<(), ApiError> {
    if TOOL_REGISTRY
        .iter()
        .any(|tool| tool.id == id && tool.schema_version == version && tool.risk == risk)
    {
        Ok(())
    } else if TOOL_REGISTRY.iter().any(|tool| tool.id == id) {
        Err(assistant_error(
            "unsupported_schema_version",
            "This assistant tool schema version is not supported.",
            Some("schemaVersion"),
        ))
    } else {
        Err(unsupported_tool())
    }
}

fn validate_limit(limit: i64, maximum: i64) -> Result<(), ApiError> {
    if (1..=maximum).contains(&limit) {
        Ok(())
    } else {
        Err(assistant_error(
            "invalid_result_limit",
            "The assistant calendar result limit is outside the allowed range.",
            Some("input.limit"),
        ))
    }
}

fn validate_tool_context(run_id: &str, tool_call_id: &str) -> Result<(), ApiError> {
    validate_context_id(run_id, "runId")?;
    validate_context_id(tool_call_id, "toolCallId")
}

fn validate_context_id(value: &str, field: &'static str) -> Result<(), ApiError> {
    if !value.is_empty()
        && value.chars().count() <= MAX_ID_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:/".contains(&byte))
    {
        Ok(())
    } else {
        Err(assistant_error(
            "invalid_tool_context",
            "The assistant tool context identifier is invalid.",
            Some(field),
        ))
    }
}

fn ensure_identity(
    action: &PendingAction,
    run_id: &str,
    tool_call_id: &str,
) -> Result<(), ApiError> {
    if action.identity.run_id == run_id && action.identity.tool_call_id == tool_call_id {
        Ok(())
    } else {
        Err(action_unavailable())
    }
}

fn proposal_response(token: String, action: &PendingAction) -> CreateProposalResponse {
    CreateProposalResponse {
        token,
        expires_at_utc_ms: action.expires_at_utc_ms,
        run_id: action.identity.run_id.clone(),
        tool_call_id: action.identity.tool_call_id.clone(),
        tool_id: CREATE_TOOL_ID,
        schema_version: SCHEMA_VERSION,
        review: action.review.clone(),
        provider_result: ProposalProviderResult::RequiresConfirmation {
            review: action.review.clone(),
        },
    }
}

fn confirm_response(
    event: AssistantCalendarEvent,
    replayed: bool,
) -> Result<CreateConfirmResponse, ApiError> {
    let response = CreateConfirmResponse {
        status: "created",
        provider_result: ConfirmProviderResult::Created {
            event: event.clone(),
        },
        event,
        replayed,
    };
    ensure_serialized_size(&response, MAX_TOOL_RESULT_BYTES)?;
    Ok(response)
}

fn cancel_response(replayed: bool) -> CreateCancelResponse {
    CreateCancelResponse {
        status: "cancelled",
        provider_result: CancelProviderResult::Cancelled,
        replayed,
    }
}

fn sanitize_occurrence(record: OccurrenceRecord) -> AssistantOccurrence {
    let (title, title_truncated) = sanitize_text(&record.title, MAX_RESULT_TITLE_CHARS);
    let (notes, notes_truncated) = sanitize_optional(record.notes, MAX_RESULT_NOTES_CHARS);
    let (location, location_truncated) =
        sanitize_optional(record.location, MAX_RESULT_LOCATION_CHARS);
    let mut truncated_fields = Vec::new();
    if title_truncated {
        truncated_fields.push("title");
    }
    if notes_truncated {
        truncated_fields.push("notes");
    }
    if location_truncated {
        truncated_fields.push("location");
    }
    AssistantOccurrence {
        event_id: record.event_id.to_string(),
        occurrence_key: record.occurrence_key,
        title,
        notes,
        location,
        time: event_time_response(record.time),
        recurrence_rule: record.recurrence_rule.map(|rule| rule.source().to_owned()),
        reminder_offsets_minutes: record.reminder_offsets_minutes,
        revision: record.revision,
        source: "local_calendar",
        truncated_fields,
    }
}

fn sanitize_event(record: EventRecord) -> AssistantCalendarEvent {
    let response = EventResponse::from(record);
    sanitize_created_event(response)
}

fn sanitize_created_event(record: EventResponse) -> AssistantCalendarEvent {
    let (title, title_truncated) = sanitize_text(&record.title, MAX_RESULT_TITLE_CHARS);
    let (notes, notes_truncated) = sanitize_optional(record.notes, MAX_RESULT_NOTES_CHARS);
    let (location, location_truncated) =
        sanitize_optional(record.location, MAX_RESULT_LOCATION_CHARS);
    let mut truncated_fields = Vec::new();
    if title_truncated {
        truncated_fields.push("title");
    }
    if notes_truncated {
        truncated_fields.push("notes");
    }
    if location_truncated {
        truncated_fields.push("location");
    }
    AssistantCalendarEvent {
        event_id: record.id,
        title,
        notes,
        location,
        time: record.time,
        recurrence_rule: record.recurrence_rule,
        reminder_offsets_minutes: record.reminder_offsets_minutes,
        revision: record.revision,
        source: "local_calendar",
        truncated_fields,
    }
}

fn event_time_response(time: EventTime) -> EventTimeResponse {
    match time {
        EventTime::Timed {
            start_utc_ms,
            end_utc_ms,
            time_zone,
        } => EventTimeResponse::Timed {
            start_utc_ms,
            end_utc_ms,
            time_zone,
        },
        EventTime::AllDay {
            start_date,
            end_date_exclusive,
        } => EventTimeResponse::AllDay {
            start_date: start_date.format("%Y-%m-%d").to_string(),
            end_date_exclusive: end_date_exclusive.format("%Y-%m-%d").to_string(),
        },
    }
}

fn sanitize_optional(value: Option<String>, maximum: usize) -> (Option<String>, bool) {
    match value {
        Some(value) => {
            let (value, truncated) = sanitize_text(&value, maximum);
            (Some(value), truncated)
        }
        None => (None, false),
    }
}

fn sanitize_text(value: &str, maximum: usize) -> (String, bool) {
    let filtered = value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .collect::<String>();
    let truncated = filtered.chars().count() > maximum;
    (filtered.chars().take(maximum).collect(), truncated)
}

fn prune_expired(pending: &mut HashMap<String, PendingAction>, now: Instant) {
    pending.retain(|_, action| {
        matches!(action.status, PendingStatus::Executing) || action.expires_at > now
    });
}

fn unique_token(pending: &HashMap<String, PendingAction>) -> Result<String, ApiError> {
    for _ in 0..4 {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| token_unavailable())?;
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if !pending.contains_key(&token) {
            return Ok(token);
        }
    }
    Err(token_unavailable())
}

fn unix_time_ms() -> Result<i64, ApiError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| token_unavailable())?
        .as_millis();
    i64::try_from(millis).map_err(|_| token_unavailable())
}

fn ensure_json_size(value: &Value, maximum: usize, field: &'static str) -> Result<(), ApiError> {
    let size = serde_json::to_vec(value)
        .map_err(|_| result_unavailable())?
        .len();
    if size <= maximum {
        Ok(())
    } else {
        Err(assistant_error(
            "assistant_payload_too_large",
            "The assistant calendar payload exceeds its safety limit.",
            Some(field),
        ))
    }
}

fn ensure_serialized_size<T: Serialize>(value: &T, maximum: usize) -> Result<(), ApiError> {
    let size = serde_json::to_vec(value)
        .map_err(|_| result_unavailable())?
        .len();
    if size <= maximum {
        Ok(())
    } else {
        Err(result_unavailable())
    }
}

const fn assistant_error(
    code: &'static str,
    message: &'static str,
    field: Option<&'static str>,
) -> ApiError {
    ApiError {
        code,
        message,
        field,
    }
}

const fn unsupported_tool() -> ApiError {
    assistant_error(
        "unsupported_tool",
        "This assistant calendar tool is not available.",
        Some("toolId"),
    )
}

const fn invalid_inferred_fields() -> ApiError {
    assistant_error(
        "invalid_inferred_fields",
        "Inferred review fields must be unique supported field names.",
        Some("input.inferredFields"),
    )
}

const fn action_unavailable() -> ApiError {
    assistant_error(
        "pending_action_unavailable",
        "This assistant action is unavailable or expired. Review a new proposal.",
        None,
    )
}

const fn action_terminal() -> ApiError {
    assistant_error(
        "pending_action_terminal",
        "This assistant action has already finished.",
        None,
    )
}

const fn action_in_progress() -> ApiError {
    assistant_error(
        "pending_action_in_progress",
        "This assistant action is already being confirmed.",
        None,
    )
}

const fn reconciliation_required() -> ApiError {
    assistant_error(
        "assistant_calendar_create_reconciliation_required",
        "Check Agenda before creating another event with the assistant.",
        None,
    )
}

const fn token_unavailable() -> ApiError {
    assistant_error(
        "pending_action_unavailable",
        "A secure assistant action could not be created. Try again.",
        None,
    )
}

const fn result_unavailable() -> ApiError {
    assistant_error(
        "assistant_result_unavailable",
        "The assistant calendar result could not be returned safely.",
        None,
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::{Datelike, NaiveDate};
    use serde_json::json;

    use super::*;
    use crate::calendar::{domain::EventDraft, error::DomainError};

    fn create_input(title: &str) -> CreateEventInput {
        serde_json::from_value(json!({
            "event": {
                "title": title,
                "notes": "Bring agenda",
                "location": "Room 1",
                "time": {
                    "temporalKind": "timed",
                    "localStart": "2026-07-25T14:00:00",
                    "localEnd": "2026-07-25T14:45:00",
                    "timeZone": "America/Chicago"
                },
                "recurrenceRule": null,
                "reminderOffsetsMinutes": [10]
            },
            "inferredFields": ["time", "duration"]
        }))
        .unwrap()
    }

    fn proposal(title: &str) -> CreateProposalRequest {
        CreateProposalRequest {
            run_id: "run-1".into(),
            tool_call_id: "call-1".into(),
            tool_id: CREATE_TOOL_ID.into(),
            schema_version: 1,
            input: create_input(title),
        }
    }

    fn terminal(token: String) -> CreateTerminalRequest {
        CreateTerminalRequest {
            token,
            run_id: "run-1".into(),
            tool_call_id: "call-1".into(),
        }
    }

    #[test]
    fn registry_is_versioned_bounded_main_only_policy_without_update_or_delete() {
        assert_eq!(TOOL_REGISTRY.len(), 4);
        assert!(TOOL_REGISTRY.iter().all(|tool| tool.schema_version == 1));
        assert!(TOOL_REGISTRY.iter().all(|tool| {
            tool.maximum_result_bytes == MAX_TOOL_RESULT_BYTES
                && tool.authorized_windows == ["main"]
                && tool.provider_data_sharing == ProviderDataSharing::SanitizedCalendarContent
        }));
        assert_eq!(TOOL_REGISTRY[0].input_schema, ToolInputSchema::QueryV1);
        assert_eq!(
            TOOL_REGISTRY[0].output_schema,
            ToolOutputSchema::OccurrenceListV1
        );
        assert!(TOOL_REGISTRY
            .iter()
            .filter(|tool| tool.risk == ToolRisk::ReadOnly)
            .all(|tool| !tool.confirmation_required && tool.maximum_results.is_some()));
        assert!(
            TOOL_REGISTRY
                .iter()
                .find(|tool| tool.id == CREATE_TOOL_ID)
                .unwrap()
                .confirmation_required
        );
        assert_eq!(
            TOOL_REGISTRY[3].cancellation,
            CancellationPolicy::BeforeConfirmation
        );
        assert!(!TOOL_REGISTRY
            .iter()
            .any(|tool| { tool.id.contains("update") || tool.id.contains("delete") }));
    }

    #[test]
    fn strict_schemas_reject_unknown_fields_and_bad_inferred_fields() {
        assert!(serde_json::from_value::<ToolExecuteRequest>(json!({
            "toolId": "calendar.query", "schemaVersion": 1, "input": {}, "sql": "x"
        }))
        .is_err());
        assert!(serde_json::from_value::<QueryInput>(json!({
            "startUtcMs": 1, "endUtcMs": 2, "startDate": "2026-01-01",
            "endDateExclusive": "2026-01-02", "limit": 1, "cursor": "x"
        }))
        .is_err());
        assert!(serde_json::from_value::<CreateEventInput>(json!({
            "event": {"title": "x", "notes": null, "location": null,
              "time": {"temporalKind":"allDay","startDate":"2026-01-01","endDateExclusive":"2026-01-02"}},
            "inferredFields": ["sql"]
        }))
        .is_err());
    }

    #[test]
    fn tool_context_and_limits_are_strict() {
        assert!(validate_context_id("run_ok-1", "runId").is_ok());
        assert!(validate_context_id("bad token", "runId").is_err());
        assert!(validate_context_id(&"x".repeat(MAX_ID_CHARS + 1), "runId").is_err());
        assert!(validate_limit(1, MAX_QUERY_RESULTS).is_ok());
        assert!(validate_limit(MAX_QUERY_RESULTS, MAX_QUERY_RESULTS).is_ok());
        assert!(validate_limit(0, MAX_QUERY_RESULTS).is_err());
        assert!(validate_limit(MAX_QUERY_RESULTS + 1, MAX_QUERY_RESULTS).is_err());
        assert!(ensure_tool("calendar.update_event", 1, ToolRisk::Write).is_err());
        assert!(ensure_tool("calendar.query", 2, ToolRisk::ReadOnly).is_err());
    }

    #[test]
    fn secure_tokens_are_256_bits_encoded_and_unique() {
        let pending = HashMap::new();
        let first = unique_token(&pending).unwrap();
        let second = unique_token(&pending).unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn proposal_is_idempotent_and_payload_mismatch_is_rejected() {
        let state = AssistantState::default();
        let first = state.propose(proposal("Review")).unwrap();
        let second = state.propose(proposal("Review")).unwrap();
        assert_eq!(first.token, second.token);
        assert_eq!(first.review, second.review);
        let error = match state.propose(proposal("Different")) {
            Ok(_) => panic!("mismatched proposal was accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, "proposal_mismatch");
        assert!(!error.message.contains(&first.token));
    }

    #[test]
    fn revise_consumes_old_token_and_returns_a_different_bound_token() {
        let state = AssistantState::default();
        let first = state.propose(proposal("Review")).unwrap();
        let revised = state
            .revise(CreateReviseRequest {
                token: first.token.clone(),
                run_id: "run-1".into(),
                tool_call_id: "call-1".into(),
                input: create_input("Revised"),
            })
            .unwrap();
        assert_ne!(first.token, revised.token);
        assert_eq!(revised.review.title, "Revised");
        assert_eq!(
            state.cancel(terminal(first.token)).unwrap_err().code,
            "pending_action_unavailable"
        );
    }

    #[test]
    fn cancel_is_idempotent_and_bound_to_run_and_call() {
        let state = AssistantState::default();
        let proposed = state.propose(proposal("Review")).unwrap();
        let mut wrong = terminal(proposed.token.clone());
        wrong.run_id = "run-2".into();
        assert_eq!(
            state.cancel(wrong).unwrap_err().code,
            "pending_action_unavailable"
        );
        assert!(
            !state
                .cancel(terminal(proposed.token.clone()))
                .unwrap()
                .replayed
        );
        assert!(state.cancel(terminal(proposed.token)).unwrap().replayed);
    }

    #[tokio::test]
    async fn concurrent_confirmation_gets_one_execution_and_replay() {
        let state = Arc::new(AssistantState::default());
        let proposed = state.propose(proposal("Review")).unwrap();
        let request = terminal(proposed.token.clone());
        assert!(matches!(
            state.acquire_confirmation(&request).await.unwrap(),
            ConfirmationLease::Execute(_)
        ));

        let waiting_state = state.clone();
        let waiting_request = terminal(proposed.token.clone());
        let waiter = tokio::spawn(async move {
            waiting_state
                .acquire_confirmation(&waiting_request)
                .await
                .unwrap()
        });
        tokio::task::yield_now().await;
        let outcome = AssistantCalendarEvent {
            event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            title: "Review".into(),
            notes: None,
            location: None,
            time: EventTimeResponse::AllDay {
                start_date: "2026-07-25".into(),
                end_date_exclusive: "2026-07-26".into(),
            },
            recurrence_rule: None,
            reminder_offsets_minutes: vec![],
            revision: 1,
            source: "local_calendar",
            truncated_fields: vec![],
        };
        state.finish_confirmation(&proposed.token, Ok(outcome.clone()));
        match waiter.await.unwrap() {
            ConfirmationLease::Replay(Ok(replayed)) => assert_eq!(replayed, outcome),
            _ => panic!("concurrent confirmation did not replay"),
        }
    }

    #[test]
    fn expired_actions_are_removed_and_capacity_is_hard_bounded() {
        let state = AssistantState::default();
        let expired = state.propose(proposal("Expired")).unwrap();
        state
            .pending
            .lock()
            .unwrap()
            .get_mut(&expired.token)
            .unwrap()
            .expires_at = Instant::now();
        assert_eq!(
            state.cancel(terminal(expired.token)).unwrap_err().code,
            "pending_action_unavailable"
        );

        for index in 0..MAX_PENDING_ACTIONS {
            let mut request = proposal("Capacity");
            request.run_id = format!("run-{index}");
            request.tool_call_id = format!("call-{index}");
            state.propose(request).unwrap();
        }
        let mut overflow = proposal("Capacity");
        overflow.run_id = "overflow-run".into();
        overflow.tool_call_id = "overflow-call".into();
        let error = match state.propose(overflow) {
            Ok(_) => panic!("pending action capacity was exceeded"),
            Err(error) => error,
        };
        assert_eq!(error.code, "pending_action_limit");
    }

    #[test]
    fn confirmation_revalidation_rejects_changed_invalid_payload() {
        let input = create_input("Review");
        assert!(prepare_create_input(input.clone()).is_ok());
        let mut invalid = input;
        invalid.event.title.clear();
        let error = match prepare_create_input(invalid) {
            Ok(_) => panic!("invalid changed payload passed revalidation"),
            Err(error) => error,
        };
        assert_eq!(error.code, ApiError::from(DomainError::InvalidTitle).code);
    }

    #[test]
    fn sanitizer_strips_controls_caps_content_and_marks_fields() {
        let (value, truncated) = sanitize_text(
            &format!("safe\u{0000}{}", "x".repeat(MAX_RESULT_NOTES_CHARS)),
            10,
        );
        assert_eq!(value, "safexxxxxx");
        assert!(truncated);
        assert!(!value.contains('\u{0000}'));
    }

    #[test]
    fn proposal_provider_result_and_terminal_results_never_contain_token() {
        let state = AssistantState::default();
        let proposed = state.propose(proposal("Secret review")).unwrap();
        let provider = serde_json::to_string(&proposed.provider_result).unwrap();
        assert!(!provider.contains(&proposed.token));
        assert!(!serde_json::to_string(&cancel_response(false))
            .unwrap()
            .contains(&proposed.token));
        let error = action_unavailable();
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains(&proposed.token));
    }

    #[test]
    fn canonical_digest_normalizes_title_and_inferred_field_order() {
        let first = create_input("  Review  ");
        let mut second = create_input("Review");
        second.inferred_fields.reverse();
        let mut first = prepare_create_input(first.clone()).unwrap();
        let second = prepare_create_input(second).unwrap();
        assert_eq!(first.digest, second.digest);
        first.input.event.title.clear();
        assert!(prepare_create_input(first.input).is_err());
    }

    #[test]
    fn date_review_reports_bounded_day_count() {
        let input: CreateEventInput = serde_json::from_value(json!({
            "event": {"title": "Offsite", "notes": null, "location": null,
              "time": {"temporalKind":"allDay","startDate":"2026-07-25","endDateExclusive":"2026-07-27"}}
        }))
        .unwrap();
        let review = prepare_create_input(input).unwrap().review;
        assert!(matches!(
            review.time,
            EventReviewTime::AllDay { day_count: 2, .. }
        ));
        assert_eq!(
            NaiveDate::parse_from_str("2026-07-25", "%Y-%m-%d")
                .unwrap()
                .day(),
            25
        );
    }

    async fn ready_app_state() -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().to_path_buf());
        state.start_calendar_initialization(None);
        state.calendar_runtime().await.unwrap();
        (directory, state)
    }

    async fn create_reconciliation_marker(state: &AppState, title: &str) {
        let input = create_input(title);
        let draft = input.event.into_domain(None, Vec::new()).unwrap();
        state
            .calendar_runtime()
            .await
            .unwrap()
            .calendar
            .create_assistant_event(draft)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn proposal_is_blocked_while_durable_reconciliation_is_required() {
        let (_directory, state) = ready_app_state().await;
        create_reconciliation_marker(&state, "Already created").await;

        let error = match propose_create_authorized(&state, proposal("Duplicate")).await {
            Ok(_) => panic!("proposal bypassed the durable reconciliation marker"),
            Err(error) => error,
        };
        assert_eq!(
            error.code,
            "assistant_calendar_create_reconciliation_required"
        );
        assert!(state.assistant.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn both_bounded_acknowledgement_modes_clear_only_the_current_marker() {
        let (_directory, state) = ready_app_state().await;

        for mode in [
            ReconciliationAcknowledgeMode::ExactCreatedOutcomeReceived,
            ReconciliationAcknowledgeMode::AgendaInspected,
        ] {
            create_reconciliation_marker(&state, "Acknowledged").await;
            let response = acknowledge_reconciliation_authorized(&state, mode)
                .await
                .unwrap();
            assert_eq!(response.state, ReconciliationState::Clear);
            assert!(response.acknowledged);
            assert_eq!(response.mode, mode);
            assert_eq!(
                reconciliation_status_authorized(&state)
                    .await
                    .unwrap()
                    .state,
                ReconciliationState::Clear
            );
        }
    }

    #[tokio::test]
    async fn search_completeness_reflects_master_candidate_exhaustion() {
        let (_directory, state) = ready_app_state().await;
        let runtime = state.calendar_runtime().await.unwrap();
        let ended_start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let ended_end = NaiveDate::from_ymd_opt(2026, 1, 2).unwrap();

        for index in 0..200 {
            runtime
                .calendar
                .create_event(
                    EventDraft::validated_with_recurrence(
                        format!("Candidate boundary ended {index:03}"),
                        None,
                        None,
                        EventTime::AllDay {
                            start_date: ended_start,
                            end_date_exclusive: ended_end,
                        },
                        Some("FREQ=DAILY;COUNT=1".into()),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
        }

        let search_request = || ToolExecuteRequest {
            tool_id: "calendar.search".into(),
            schema_version: 1,
            input: json!({
                "query": "candidate boundary",
                "startUtcMs": 1_784_620_800_000_i64,
                "endUtcMs": 1_784_707_200_000_i64,
                "startDate": "2026-07-21",
                "endDateExclusive": "2026-07-22",
                "limit": 20
            }),
        };

        let exact = execute_read_tool(&state, search_request()).await.unwrap();
        assert_eq!(
            exact.result,
            json!({
                "items": [],
                "completeness": "complete",
                "omittedCount": null
            })
        );

        runtime
            .calendar
            .create_event(
                EventDraft::validated_with_recurrence(
                    "Candidate boundary live".into(),
                    None,
                    None,
                    EventTime::AllDay {
                        start_date: NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
                        end_date_exclusive: NaiveDate::from_ymd_opt(2026, 7, 22).unwrap(),
                    },
                    Some("FREQ=DAILY;COUNT=1".into()),
                )
                .unwrap(),
            )
            .await
            .unwrap();

        let exhausted = execute_read_tool(&state, search_request()).await.unwrap();
        assert_eq!(
            exhausted.result,
            json!({
                "items": [],
                "completeness": "unknown_beyond_limit",
                "omittedCount": null
            })
        );
    }

    #[test]
    fn reconciliation_dtos_are_exact_bounded_and_authorized_only_for_main() {
        for (source, expected) in [
            (
                json!({"mode": "exact_created_outcome_received"}),
                ReconciliationAcknowledgeMode::ExactCreatedOutcomeReceived,
            ),
            (
                json!({"mode": "agenda_inspected"}),
                ReconciliationAcknowledgeMode::AgendaInspected,
            ),
        ] {
            let request: ReconciliationAcknowledgeRequest = serde_json::from_value(source).unwrap();
            assert_eq!(request.mode, expected);
        }
        assert!(
            serde_json::from_value::<ReconciliationAcknowledgeRequest>(json!({
                "mode": "agenda_inspected",
                "token": "must-not-cross-ipc"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ReconciliationAcknowledgeRequest>(json!({
                "mode": "arbitrary_reason"
            }))
            .is_err()
        );
        assert_eq!(ensure_main_window_label_for_test("main"), Ok(()));
        assert_eq!(
            ensure_main_window_label_for_test("widget"),
            Err(ApiError::forbidden_window())
        );

        let status = serde_json::to_value(ReconciliationStatusResponse {
            state: ReconciliationState::ReconciliationRequired,
        })
        .unwrap();
        assert_eq!(status, json!({"state": "reconciliation_required"}));
        assert!(!status.to_string().contains("token"));
    }

    fn ensure_main_window_label_for_test(label: &str) -> Result<(), ApiError> {
        crate::calendar::api::ensure_window_label(label)
    }
}
