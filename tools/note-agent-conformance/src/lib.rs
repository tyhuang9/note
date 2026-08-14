//! Development-only Note host-contract checks through the public llama-harness facade.

#[cfg(test)]
mod tests {
    use llama_harness::{
        async_trait,
        mock::{final_response, tool_response, MockModelProvider, MockStep},
        AgentDefinition, AgentLimits, AgentRunner, ApprovalHandler, ApprovalRecord,
        CancellationToken, HarnessError, ModelResponse, PolicyDecision, PolicyEngine, RunRequest,
        RunStatus, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolRegistry, ToolResult,
        ToolRisk, Usage,
    };
    use serde_json::{json, Value};
    use std::{
        collections::HashMap,
        future::pending,
        sync::{Arc, Mutex},
    };

    const CANONICAL_TOOLS: [&str; 10] = [
        "notes.read_page",
        "notes.read_selection",
        "notes.search",
        "notes.insert_text",
        "notes.append_text",
        "notes.replace_text",
        "calendar.query",
        "calendar.search",
        "calendar.get_event",
        "calendar.create_event",
    ];
    const GOLDEN: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../frontend/src/features/assistant/note-assistant-v1.golden.json"
    ));

    fn input_schema(id: &str) -> Value {
        golden_schema(id, "inputSchema")
    }

    fn output_schema(id: &str) -> Value {
        golden_schema(id, "outputSchema")
    }

    fn golden_schema(id: &str, field: &str) -> Value {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        golden["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["id"] == id)
            .unwrap()[field]
            .clone()
    }

    fn validated_success(id: &str, output: Value) -> Result<ToolResult, HarnessError> {
        let validator = jsonschema::validator_for(&output_schema(id))
            .map_err(|error| HarnessError::InvalidTool(error.to_string()))?;
        validator
            .validate(&output)
            .map_err(|error| HarnessError::InvalidTool(format!("{id} output: {error}")))?;
        Ok(ToolResult::success(output))
    }

    fn block(content: &str) -> Value {
        json!({"id":"block-1","pageId":"page-1","content":content,"x":0,"y":0,"width":320,"height":120})
    }

    fn calendar_event(title: &str) -> Value {
        json!({"eventId":"event-1","title":title,"notes":null,"location":null,"time":{"temporalKind":"allDay","startDate":"2026-07-21","endDateExclusive":"2026-07-22"},"recurrenceRule":null,"reminderOffsetsMinutes":[],"revision":1,"source":"local_calendar"})
    }

    fn canonical_output(id: &str, content: &str) -> Value {
        match id {
            "notes.read_page" => {
                json!({"page":{"id":"page-1","folderId":"folder-1","title":"Page"},"blocks":[block(content)],"completeness":{"complete":true,"omittedCount":0,"truncatedContentCount":0,"maximumCount":24,"maximumBytes":16000}})
            }
            "notes.read_selection" => {
                json!({"blocks":[block(content)],"completeness":{"complete":true,"omittedCount":0,"truncatedContentCount":0,"maximumCount":12,"maximumBytes":16000}})
            }
            "notes.search" => {
                json!({"pages":[{"id":"page-1","folderId":"folder-1","title":"Page","matchedBlockIds":["block-1"]}],"completeness":{"complete":true,"omittedPageCount":0,"omittedMatchCount":0,"truncatedTitleCount":0,"maximumPages":20,"maximumMatchesPerPage":20,"maximumMatchesTotal":20,"maximumBytes":16000}})
            }
            "notes.insert_text" | "notes.append_text" | "notes.replace_text" => {
                json!({"block":block(content)})
            }
            "calendar.query" => {
                let mut event = calendar_event("Existing planning");
                event["occurrenceKey"] = json!("event-1@2026-07-21");
                json!({"items":[event],"completeness":"complete","omittedCount":0})
            }
            "calendar.search" => {
                let mut event = calendar_event("Existing planning");
                event["occurrenceKey"] = json!("event-1@2026-07-21");
                json!({"items":[event],"completeness":"complete","omittedCount":null})
            }
            "calendar.get_event" => calendar_event("Existing planning"),
            "calendar.create_event" => {
                let event = calendar_event(content);
                json!({"status":"created","event":event,"providerResult":{"status":"created","event":event},"replayed":false})
            }
            _ => unreachable!(),
        }
    }

    fn canonical_arguments(id: &str) -> Value {
        match id {
            "notes.read_page" => json!({"includeBlocks":true}),
            "notes.read_selection" => json!({}),
            "notes.search" => json!({"query":"initial"}),
            "notes.insert_text" => json!({"content":" inserted","x":0,"y":0}),
            "notes.append_text" | "notes.replace_text" => {
                json!({"blockId":"block-1","content":"updated"})
            }
            "calendar.query" => {
                json!({"startUtcMs":0,"endUtcMs":1,"startDate":"2026-07-21","endDateExclusive":"2026-07-22","limit":25})
            }
            "calendar.search" => {
                json!({"query":"planning","startUtcMs":0,"endUtcMs":1,"startDate":"2026-07-21","endDateExclusive":"2026-07-22","limit":20})
            }
            "calendar.get_event" => json!({"eventId":"event-1"}),
            "calendar.create_event" => {
                json!({"event":{"title":"Planning","notes":null,"location":null,"time":{"temporalKind":"allDay","startDate":"2026-07-21","endDateExclusive":"2026-07-22"}}})
            }
            _ => unreachable!(),
        }
    }

    fn requires_note_binding(id: &str) -> bool {
        matches!(
            id,
            "notes.insert_text" | "notes.append_text" | "notes.replace_text"
        )
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct AppState {
        page_revision: u64,
        block_revision: u64,
        text: String,
        calendar: Vec<String>,
    }

    impl Default for AppState {
        fn default() -> Self {
            Self {
                page_revision: 7,
                block_revision: 11,
                text: "initial".into(),
                calendar: vec!["existing".into()],
            }
        }
    }

    struct NoteTool {
        definition: ToolDefinition,
        state: Arc<Mutex<AppState>>,
        bindings: Arc<Mutex<HashMap<String, RevisionBinding>>>,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum RevisionBinding {
        Page {
            page_revision: u64,
        },
        Block {
            page_revision: u64,
            block_id: String,
            block_revision: u64,
        },
    }

    fn revision_binding(id: &str, arguments: &Value, state: &AppState) -> Option<RevisionBinding> {
        match id {
            "notes.insert_text" => Some(RevisionBinding::Page {
                page_revision: state.page_revision,
            }),
            "notes.append_text" | "notes.replace_text" => Some(RevisionBinding::Block {
                page_revision: state.page_revision,
                block_id: arguments["blockId"].as_str()?.into(),
                block_revision: state.block_revision,
            }),
            _ => None,
        }
    }

    impl NoteTool {
        fn new(
            id: &str,
            state: Arc<Mutex<AppState>>,
            bindings: Arc<Mutex<HashMap<String, RevisionBinding>>>,
        ) -> Self {
            let write = matches!(
                id,
                "notes.insert_text"
                    | "notes.append_text"
                    | "notes.replace_text"
                    | "calendar.create_event"
            );
            Self {
                definition: ToolDefinition {
                    id: id.into(),
                    name: id.into(),
                    description: "Note conformance tool".into(),
                    arguments_schema: input_schema(id),
                    risk: if write { ToolRisk::High } else { ToolRisk::Low },
                    idempotent: !write,
                    read_only: !write,
                },
                state,
                bindings,
            }
        }
    }

    #[async_trait]
    impl Tool for NoteTool {
        fn definition(&self) -> &ToolDefinition {
            &self.definition
        }

        async fn execute(
            &self,
            _: Value,
            _: CancellationToken,
        ) -> Result<ToolResult, HarnessError> {
            Err(HarnessError::InvalidRequest(
                "Note writes require tool-call context".into(),
            ))
        }

        async fn execute_with_context(
            &self,
            context: &ToolCallContext,
            arguments: Value,
            _: CancellationToken,
        ) -> Result<ToolResult, HarnessError> {
            let mut state = self.state.lock().unwrap();
            if requires_note_binding(&self.definition.id) {
                let binding = self.bindings.lock().unwrap().remove(&context.call_id);
                if binding != revision_binding(&self.definition.id, &arguments, &state) {
                    return Ok(ToolResult::failure("revision_conflict"));
                }
            }
            match self.definition.id.as_str() {
                "notes.read_page" | "notes.read_selection" | "notes.search" => validated_success(
                    &self.definition.id,
                    canonical_output(&self.definition.id, &state.text),
                ),
                "calendar.query" | "calendar.search" | "calendar.get_event" => validated_success(
                    &self.definition.id,
                    canonical_output(&self.definition.id, "Existing planning"),
                ),
                "notes.insert_text" => {
                    let next = format!("{}{}", state.text, arguments["content"].as_str().unwrap());
                    let result = validated_success(
                        &self.definition.id,
                        canonical_output(&self.definition.id, &next),
                    )?;
                    state.text = next;
                    state.page_revision += 1;
                    Ok(result)
                }
                "notes.append_text" => {
                    let next = format!("{}{}", state.text, arguments["content"].as_str().unwrap());
                    let result = validated_success(
                        &self.definition.id,
                        canonical_output(&self.definition.id, &next),
                    )?;
                    state.text = next;
                    state.block_revision += 1;
                    Ok(result)
                }
                "notes.replace_text" => {
                    let next = arguments["content"].as_str().unwrap();
                    let result = validated_success(
                        &self.definition.id,
                        canonical_output(&self.definition.id, next),
                    )?;
                    state.text = next.into();
                    state.block_revision += 1;
                    Ok(result)
                }
                "calendar.create_event" => {
                    let title = arguments["event"]["title"].as_str().unwrap();
                    let result = validated_success(
                        &self.definition.id,
                        canonical_output(&self.definition.id, title),
                    )?;
                    state.calendar.push(title.into());
                    Ok(result)
                }
                _ => unreachable!(),
            }
        }
    }

    struct NotePolicy;

    #[async_trait]
    impl PolicyEngine for NotePolicy {
        async fn decide(
            &self,
            tool: &ToolDefinition,
            _: &Value,
            _: &RunRequest,
        ) -> Result<PolicyDecision, HarnessError> {
            Ok(if tool.read_only {
                PolicyDecision::Allow {
                    reason: "canonical read".into(),
                }
            } else {
                PolicyDecision::RequireApproval {
                    reason: "Note write".into(),
                }
            })
        }
    }

    enum ApprovalMode {
        Grant,
        Deny,
        Pending,
    }

    struct ControlledApproval {
        mode: ApprovalMode,
        state: Arc<Mutex<AppState>>,
        bindings: Arc<Mutex<HashMap<String, RevisionBinding>>>,
        mutate_after_capture: bool,
    }

    #[async_trait]
    impl ApprovalHandler for ControlledApproval {
        async fn approve(
            &self,
            tool: &ToolDefinition,
            _: &Value,
            _: &RunRequest,
        ) -> Result<ApprovalRecord, HarnessError> {
            if matches!(self.mode, ApprovalMode::Pending) {
                return pending().await;
            }
            Ok(ApprovalRecord {
                call_id: String::new(),
                tool_id: tool.id.clone(),
                granted: matches!(self.mode, ApprovalMode::Grant),
                reason: "controlled approval".into(),
            })
        }

        async fn approve_with_context(
            &self,
            context: &ToolCallContext,
            tool: &ToolDefinition,
            arguments: &Value,
            request: &RunRequest,
        ) -> Result<ApprovalRecord, HarnessError> {
            if matches!(self.mode, ApprovalMode::Grant) && requires_note_binding(&tool.id) {
                let binding = {
                    let state = self.state.lock().unwrap();
                    revision_binding(&tool.id, arguments, &state)
                };
                let Some(binding) = binding else {
                    return Ok(ApprovalRecord {
                        call_id: context.call_id.clone(),
                        tool_id: tool.id.clone(),
                        granted: false,
                        reason: "write arguments cannot be bound to the current revision".into(),
                    });
                };
                self.bindings
                    .lock()
                    .unwrap()
                    .insert(context.call_id.clone(), binding);
            }
            if matches!(self.mode, ApprovalMode::Grant) && self.mutate_after_capture {
                self.state.lock().unwrap().block_revision += 1;
            }
            self.approve(tool, arguments, request).await
        }
    }

    fn call(id: &str, tool_id: &str, arguments: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            tool_id: tool_id.into(),
            arguments_json: arguments.into(),
        }
    }

    fn calls_response(calls: Vec<ToolCall>) -> MockStep {
        MockStep::Response(ModelResponse {
            model: "mock-model".into(),
            final_output: None,
            tool_calls: calls,
            usage: Usage::default(),
        })
    }

    fn validate_app_intent(candidates: &[&str]) -> Result<(), &'static str> {
        if candidates.len() == 1 {
            Ok(())
        } else {
            Err("ambiguous_intent")
        }
    }

    fn registry(
        state: Arc<Mutex<AppState>>,
        bindings: Arc<Mutex<HashMap<String, RevisionBinding>>>,
    ) -> ToolRegistry {
        let mut registry = ToolRegistry::default();
        for id in CANONICAL_TOOLS {
            registry
                .register(Arc::new(NoteTool::new(id, state.clone(), bindings.clone())))
                .unwrap();
        }
        registry
    }

    fn request() -> RunRequest {
        let mut agent =
            AgentDefinition::new("note-assistant-v1", "Note", "1", "models-ai-selection");
        agent.tool_allowlist = CANONICAL_TOOLS.iter().map(ToString::to_string).collect();
        agent.limits = AgentLimits {
            max_model_calls: 5,
            max_tool_calls: 10,
            max_identical_tool_calls: 2,
            ..AgentLimits::default()
        };
        RunRequest::new(agent, "deterministic host-contract scenario")
    }

    async fn run(
        steps: impl IntoIterator<Item = llama_harness::mock::MockStep>,
        state: Arc<Mutex<AppState>>,
        approval: ApprovalMode,
        request: RunRequest,
        mutate_after_capture: bool,
    ) -> llama_harness::RunResult {
        let bindings = Arc::new(Mutex::new(HashMap::new()));
        AgentRunner::builder(Arc::new(MockModelProvider::scripted(steps)))
            .tools(registry(state.clone(), bindings.clone()))
            .policy(Arc::new(NotePolicy))
            .approvals(Arc::new(ControlledApproval {
                mode: approval,
                state,
                bindings,
                mutate_after_capture,
            }))
            .build()
            .run(request)
            .await
            .unwrap()
    }

    #[test]
    fn all_registered_schemas_equal_the_canonical_golden() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let ids = golden["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, CANONICAL_TOOLS);
        let state = Arc::new(Mutex::new(AppState::default()));
        let bindings = Arc::new(Mutex::new(HashMap::new()));
        for id in CANONICAL_TOOLS {
            let tool = NoteTool::new(id, state.clone(), bindings.clone());
            assert_eq!(tool.definition().arguments_schema, input_schema(id));
        }
    }

    #[tokio::test]
    async fn granted_writes_fail_closed_when_revision_binding_is_missing_or_invalid() {
        let state = Arc::new(Mutex::new(AppState::default()));
        let bindings = Arc::new(Mutex::new(HashMap::new()));
        let approval = ControlledApproval {
            mode: ApprovalMode::Grant,
            state: state.clone(),
            bindings: bindings.clone(),
            mutate_after_capture: true,
        };
        let tool = NoteTool::new("notes.replace_text", state.clone(), bindings.clone());
        let context = ToolCallContext {
            run_id: "run".into(),
            trace_id: "trace".into(),
            call_id: "call".into(),
            tool_id: "notes.replace_text".into(),
        };

        for arguments in [
            json!({"content": "updated"}),
            json!({"blockId": 1, "content": "updated"}),
        ] {
            let record = approval
                .approve_with_context(&context, tool.definition(), &arguments, &request())
                .await
                .unwrap();
            assert!(!record.granted);
            assert_eq!(record.call_id, "call");
            assert!(bindings.lock().unwrap().is_empty());
            assert_eq!(*state.lock().unwrap(), AppState::default());
        }
    }

    #[tokio::test]
    async fn all_ten_tool_paths_return_schema_valid_public_results() {
        for id in CANONICAL_TOOLS {
            let state = Arc::new(Mutex::new(AppState::default()));
            let bindings = Arc::new(Mutex::new(HashMap::new()));
            let tool = NoteTool::new(id, state.clone(), bindings.clone());
            let arguments = canonical_arguments(id);
            let context = ToolCallContext {
                run_id: "run".into(),
                trace_id: "trace".into(),
                call_id: format!("call-{id}"),
                tool_id: id.into(),
            };
            if let Some(binding) = revision_binding(id, &arguments, &state.lock().unwrap()) {
                bindings
                    .lock()
                    .unwrap()
                    .insert(context.call_id.clone(), binding);
            }
            let result = tool
                .execute_with_context(&context, arguments, CancellationToken::new())
                .await
                .unwrap();
            assert!(result.ok, "{id}: {:?}", result.error);
            assert!(
                bindings.lock().unwrap().is_empty(),
                "binding leaked for {id}"
            );
            let serialized = serde_json::to_string(&result.output).unwrap();
            assert!(!serialized.contains("pageRevision"));
            assert!(!serialized.contains("blockRevision"));
        }
    }

    #[tokio::test]
    async fn actual_runner_reads_note_and_calendar() {
        let state = Arc::new(Mutex::new(AppState::default()));
        let before = state.lock().unwrap().clone();
        let result = run(
            [
                tool_response(call("note", "notes.read_page", "{}")),
                tool_response(call("calendar", "calendar.query", r#"{"startUtcMs":0,"endUtcMs":1,"startDate":"2026-07-21","endDateExclusive":"2026-07-22","limit":25}"#)),
                final_response("done"),
            ],
            state.clone(),
            ApprovalMode::Deny,
            request(),
            false,
        )
        .await;
        assert_eq!(result.status, RunStatus::Completed);
        assert_eq!(result.tool_calls.len(), 2);
        assert_eq!(*state.lock().unwrap(), before);
    }

    #[tokio::test]
    async fn approved_note_write_and_calendar_create_execute_once() {
        let state = Arc::new(Mutex::new(AppState::default()));
        let result = run(
            [
                tool_response(call(
                    "write",
                    "notes.replace_text",
                    r#"{"blockId":"block-1","content":"approved"}"#,
                )),
                tool_response(call(
                    "create",
                    "calendar.create_event",
                    r#"{"event":{"title":"Planning","notes":null,"location":null,"time":{"temporalKind":"allDay","startDate":"2026-07-21","endDateExclusive":"2026-07-22"}}}"#,
                )),
                final_response("done"),
            ],
            state.clone(),
            ApprovalMode::Grant,
            request(),
            false,
        )
        .await;
        assert_eq!(result.approvals.len(), 2);
        assert!(result.approvals.iter().all(|approval| approval.granted));
        assert_eq!(
            *state.lock().unwrap(),
            AppState {
                page_revision: 7,
                block_revision: 12,
                text: "approved".into(),
                calendar: vec!["existing".into(), "Planning".into()]
            }
        );
    }

    #[tokio::test]
    async fn denied_malformed_disallowed_unknown_legacy_and_ambiguous_calls_are_zero_mutation() {
        let state = Arc::new(Mutex::new(AppState::default()));
        let before = state.lock().unwrap().clone();
        assert_eq!(
            validate_app_intent(&["append", "replace"]),
            Err("ambiguous_intent")
        );
        let mut restricted = request();
        restricted
            .agent
            .tool_allowlist
            .retain(|id| id != "calendar.create_event");
        let result = run(
            [
                calls_response(vec![
                    call(
                        "denied",
                        "notes.replace_text",
                        r#"{"blockId":"block-1","content":"no"}"#,
                    ),
                    call("malformed", "notes.replace_text", "not-json"),
                    call("schema", "notes.replace_text", "{}"),
                    call("disallowed", "calendar.create_event", r#"{"event":{"title":"no","notes":null,"location":null,"time":{"temporalKind":"allDay","startDate":"2026-07-21","endDateExclusive":"2026-07-22"}}}"#),
                    call("unknown", "missing", "{}"),
                    call("legacy", "note.updateBlock", "{}"),
                ]),
                final_response("app validation handled ambiguity without proposing a tool call"),
            ],
            state.clone(),
            ApprovalMode::Deny,
            restricted,
            false,
        )
        .await;
        assert_eq!(result.status, RunStatus::Completed);
        assert_eq!(*state.lock().unwrap(), before);
        assert_eq!(
            result
                .errors
                .iter()
                .filter(|error| error.code == "tool_rejected")
                .count(),
            6
        );
    }

    #[tokio::test]
    async fn cancellation_interrupts_pending_write_approval() {
        let state = Arc::new(Mutex::new(AppState::default()));
        let before = state.lock().unwrap().clone();
        let request = request();
        let cancellation = request.cancellation.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            cancellation.cancel();
        });
        let result = run(
            [tool_response(call(
                "pending",
                "notes.replace_text",
                r#"{"blockId":"block-1","content":"no"}"#,
            ))],
            state.clone(),
            ApprovalMode::Pending,
            request,
            false,
        )
        .await;
        assert_eq!(result.status, RunStatus::Cancelled);
        assert_eq!(*state.lock().unwrap(), before);
    }

    #[tokio::test]
    async fn repeated_tool_and_model_round_limits_stop_extra_execution() {
        let state = Arc::new(Mutex::new(AppState::default()));
        let before = state.lock().unwrap().clone();
        let mut repeated = request();
        repeated.agent.limits.max_identical_tool_calls = 1;
        let result = run(
            [
                tool_response(call("one", "notes.read_page", "{}")),
                tool_response(call("two", "notes.read_page", "{}")),
            ],
            state.clone(),
            ApprovalMode::Deny,
            repeated,
            false,
        )
        .await;
        assert!(result.repeated_tool_call_limit_reached);
        assert_eq!(*state.lock().unwrap(), before);

        let mut rounds = request();
        rounds.agent.limits.max_model_calls = 1;
        let result = run(
            [
                tool_response(call("one", "notes.read_page", "{}")),
                final_response("too late"),
            ],
            state,
            ApprovalMode::Deny,
            rounds,
            false,
        )
        .await;
        assert!(result.model_call_limit_reached);
    }

    #[tokio::test]
    async fn revision_conflicts_are_zero_mutation_and_rebinding_needs_new_approval() {
        for tool_id in ["notes.append_text", "notes.replace_text"] {
            let state = Arc::new(Mutex::new(AppState::default()));
            let before = state.lock().unwrap().clone();
            let denied = run(
                [
                    tool_response(call(
                        "old",
                        tool_id,
                        r#"{"blockId":"block-1","content":"edited"}"#,
                    )),
                    final_response("rebind"),
                ],
                state.clone(),
                ApprovalMode::Grant,
                request(),
                true,
            )
            .await;
            assert_eq!(denied.errors[0].code, "tool_error");
            assert_eq!(denied.tool_calls.len(), 1);
            assert_eq!(state.lock().unwrap().text, before.text);
            assert_eq!(state.lock().unwrap().calendar, before.calendar);
        }

        let insert_state = Arc::new(Mutex::new(AppState::default()));
        let insert = run(
            [
                tool_response(call(
                    "insert",
                    "notes.insert_text",
                    r#"{"content":" inserted"}"#,
                )),
                final_response("done"),
            ],
            insert_state.clone(),
            ApprovalMode::Grant,
            request(),
            true,
        )
        .await;
        assert!(insert.errors.is_empty());
        assert_eq!(insert.tool_calls.len(), 1);
        assert_eq!(insert_state.lock().unwrap().text, "initial inserted");
        assert_eq!(insert_state.lock().unwrap().block_revision, 12);

        let state = Arc::new(Mutex::new(AppState::default()));
        let rebound = run(
            [
                tool_response(call(
                    "new",
                    "notes.replace_text",
                    r#"{"blockId":"block-1","content":"edited"}"#,
                )),
                final_response("done"),
            ],
            state.clone(),
            ApprovalMode::Grant,
            request(),
            false,
        )
        .await;
        assert_eq!(rebound.approvals.len(), 1);
        assert_eq!(rebound.approvals[0].call_id, "new");
        assert_eq!(state.lock().unwrap().text, "edited");

        let calendar_state = Arc::new(Mutex::new(AppState::default()));
        let calendar = run(
            [
                tool_response(call("calendar-new", "calendar.create_event", r#"{"event":{"title":"Planning","notes":null,"location":null,"time":{"temporalKind":"allDay","startDate":"2026-07-21","endDateExclusive":"2026-07-22"}}}"#)),
                final_response("done"),
            ],
            calendar_state.clone(),
            ApprovalMode::Grant,
            request(),
            true,
        )
        .await;
        assert!(calendar.errors.is_empty());
        assert_eq!(calendar.approvals[0].call_id, "calendar-new");
        assert_eq!(calendar_state.lock().unwrap().block_revision, 12);
        assert_eq!(calendar_state.lock().unwrap().calendar.len(), 2);
    }
}
