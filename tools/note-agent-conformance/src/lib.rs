//! Development-only Note host-contract checks through the public llama-harness facade.

#[cfg(test)]
mod tests {
    use llama_harness::{
        async_trait,
        mock::{final_response, tool_response, MockModelProvider, MockStep},
        AgentDefinition, AgentLimits, AgentRunner, ApprovalHandler, ApprovalRecord,
        CancellationToken, HarnessError, ModelResponse, PolicyDecision, PolicyEngine, RunRequest,
        RunStatus, Tool, ToolCall, ToolDefinition, ToolRegistry, ToolResult, ToolRisk, Usage,
    };
    use serde_json::{json, Value};
    use std::{
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
    }

    impl NoteTool {
        fn new(id: &str, state: Arc<Mutex<AppState>>) -> Self {
            let write = matches!(
                id,
                "notes.insert_text"
                    | "notes.append_text"
                    | "notes.replace_text"
                    | "calendar.create_event"
            );
            let arguments_schema = match id {
                "notes.insert_text" => {
                    json!({"type":"object","additionalProperties":false,"required":["content","pageRevision"],"properties":{"content":{"type":"string","minLength":1},"pageRevision":{"type":"integer"}}})
                }
                "notes.append_text" | "notes.replace_text" => {
                    json!({"type":"object","additionalProperties":false,"required":["content","pageRevision","blockRevision"],"properties":{"content":{"type":"string","minLength":1},"pageRevision":{"type":"integer"},"blockRevision":{"type":"integer"}}})
                }
                "calendar.create_event" => {
                    json!({"type":"object","additionalProperties":false,"required":["title"],"properties":{"title":{"type":"string","minLength":1}}})
                }
                _ => json!({"type":"object","additionalProperties":false}),
            };
            Self {
                definition: ToolDefinition {
                    id: id.into(),
                    name: id.into(),
                    description: "Note conformance tool".into(),
                    arguments_schema,
                    risk: if write { ToolRisk::High } else { ToolRisk::Low },
                    idempotent: !write,
                    read_only: !write,
                },
                state,
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
            arguments: Value,
            _: CancellationToken,
        ) -> Result<ToolResult, HarnessError> {
            let mut state = self.state.lock().unwrap();
            let conflict = |state: &AppState| {
                arguments
                    .get("pageRevision")
                    .and_then(Value::as_u64)
                    .is_some_and(|revision| revision != state.page_revision)
                    || arguments
                        .get("blockRevision")
                        .and_then(Value::as_u64)
                        .is_some_and(|revision| revision != state.block_revision)
            };
            if conflict(&state) {
                return Ok(ToolResult::failure("revision_conflict"));
            }
            match self.definition.id.as_str() {
                "notes.read_page" | "notes.read_selection" | "notes.search" => {
                    Ok(ToolResult::success(
                        json!({"text":state.text,"pageRevision":state.page_revision,"blockRevision":state.block_revision}),
                    ))
                }
                "calendar.query" | "calendar.search" | "calendar.get_event" => {
                    Ok(ToolResult::success(json!({"events":state.calendar})))
                }
                "notes.insert_text" => {
                    state.text.push_str(arguments["content"].as_str().unwrap());
                    state.page_revision += 1;
                    Ok(ToolResult::success(json!({"status":"written"})))
                }
                "notes.append_text" => {
                    state.text.push_str(arguments["content"].as_str().unwrap());
                    state.block_revision += 1;
                    Ok(ToolResult::success(json!({"status":"written"})))
                }
                "notes.replace_text" => {
                    state.text = arguments["content"].as_str().unwrap().into();
                    state.block_revision += 1;
                    Ok(ToolResult::success(json!({"status":"written"})))
                }
                "calendar.create_event" => {
                    state
                        .calendar
                        .push(arguments["title"].as_str().unwrap().into());
                    Ok(ToolResult::success(json!({"status":"created"})))
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

    fn registry(state: Arc<Mutex<AppState>>) -> ToolRegistry {
        let mut registry = ToolRegistry::default();
        for id in CANONICAL_TOOLS {
            registry
                .register(Arc::new(NoteTool::new(id, state.clone())))
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
    ) -> llama_harness::RunResult {
        AgentRunner::builder(Arc::new(MockModelProvider::scripted(steps)))
            .tools(registry(state))
            .policy(Arc::new(NotePolicy))
            .approvals(Arc::new(ControlledApproval { mode: approval }))
            .build()
            .run(request)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn actual_runner_reads_note_and_calendar() {
        let state = Arc::new(Mutex::new(AppState::default()));
        let before = state.lock().unwrap().clone();
        let result = run(
            [
                tool_response(call("note", "notes.read_page", "{}")),
                tool_response(call("calendar", "calendar.query", "{}")),
                final_response("done"),
            ],
            state.clone(),
            ApprovalMode::Deny,
            request(),
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
                    r#"{"content":"approved","pageRevision":7,"blockRevision":11}"#,
                )),
                tool_response(call(
                    "create",
                    "calendar.create_event",
                    r#"{"title":"Planning"}"#,
                )),
                final_response("done"),
            ],
            state.clone(),
            ApprovalMode::Grant,
            request(),
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
                        r#"{"content":"no","pageRevision":7,"blockRevision":11}"#,
                    ),
                    call("malformed", "notes.replace_text", "not-json"),
                    call("schema", "notes.replace_text", "{}"),
                    call("disallowed", "calendar.create_event", r#"{"title":"no"}"#),
                    call("unknown", "missing", "{}"),
                    call("legacy", "note.updateBlock", "{}"),
                ]),
                final_response("app validation handled ambiguity without proposing a tool call"),
            ],
            state.clone(),
            ApprovalMode::Deny,
            restricted,
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
                r#"{"content":"no","pageRevision":7,"blockRevision":11}"#,
            ))],
            state.clone(),
            ApprovalMode::Pending,
            request,
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
        )
        .await;
        assert!(result.model_call_limit_reached);
    }

    #[tokio::test]
    async fn revision_conflicts_are_zero_mutation_and_rebinding_needs_new_approval() {
        for stale in [
            r#"{"content":"stale","pageRevision":6,"blockRevision":11}"#,
            r#"{"content":"stale","pageRevision":7,"blockRevision":10}"#,
        ] {
            let state = Arc::new(Mutex::new(AppState::default()));
            let before = state.lock().unwrap().clone();
            let result = run(
                [
                    tool_response(call("stale", "notes.replace_text", stale)),
                    final_response("conflict"),
                ],
                state.clone(),
                ApprovalMode::Grant,
                request(),
            )
            .await;
            assert_eq!(
                result
                    .errors
                    .iter()
                    .filter(|error| error.code == "tool_error")
                    .count(),
                1
            );
            assert_eq!(*state.lock().unwrap(), before);
        }

        let state = Arc::new(Mutex::new(AppState::default()));
        let old_binding = r#"{"content":"edited","pageRevision":7,"blockRevision":10}"#;
        let before = state.lock().unwrap().clone();
        let denied = run(
            [
                tool_response(call("old", "notes.replace_text", old_binding)),
                final_response("rebind"),
            ],
            state.clone(),
            ApprovalMode::Grant,
            request(),
        )
        .await;
        assert_eq!(denied.errors[0].code, "tool_error");
        assert_eq!(*state.lock().unwrap(), before);
        let rebound = run(
            [
                tool_response(call(
                    "new",
                    "notes.replace_text",
                    r#"{"content":"edited","pageRevision":7,"blockRevision":11}"#,
                )),
                final_response("done"),
            ],
            state.clone(),
            ApprovalMode::Grant,
            request(),
        )
        .await;
        assert_eq!(rebound.approvals.len(), 1);
        assert_eq!(state.lock().unwrap().text, "edited");
    }
}
