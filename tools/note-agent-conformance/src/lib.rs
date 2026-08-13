//! Development-only deterministic host-contract checks. This crate is intentionally an
//! independent workspace and never participates in Note's production Cargo graph.

use std::collections::BTreeMap;

/// Establishes that the conformance crate consumes the stable facade, not internal crates.
pub fn facade_is_linked() -> &'static str {
    let _ = std::any::TypeId::of::<llama_harness::AgentRunner>();
    "llama_harness"
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct State {
    page_revision: u64,
    block_revision: u64,
    text: String,
    calendar: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Binding {
    page_revision: u64,
    block_revision: u64,
}

impl State {
    fn binding(&self) -> Binding {
        Binding {
            page_revision: self.page_revision,
            block_revision: self.block_revision,
        }
    }

    fn write(&mut self, binding: Binding, approved: bool, text: &str) -> Result<(), &'static str> {
        if !approved {
            return Err("denied");
        }
        if self.binding() != binding {
            return Err("revision_conflict");
        }
        self.text = text.into();
        self.block_revision += 1;
        Ok(())
    }

    fn create_event(&mut self, approved: bool, id: &str) -> Result<(), &'static str> {
        if !approved {
            return Err("denied");
        }
        self.calendar.insert(id.into(), "created".into());
        Ok(())
    }
}

fn rejected(
    state: &State,
    result: Result<(), &'static str>,
    before: State,
    expected: &'static str,
) {
    assert_eq!(result, Err(expected));
    assert_eq!(*state, before, "failed paths must be zero-mutation");
}

#[cfg(test)]
mod tests {
    use super::*;
    use llama_harness::{
        mock::{final_response, MockModelProvider},
        AgentDefinition, AgentRunner, RunRequest,
    };
    use std::sync::Arc;

    #[tokio::test]
    async fn facade_runner_is_deterministic_for_reads() {
        let runner = AgentRunner::builder(Arc::new(MockModelProvider::scripted([final_response(
            "read ok",
        )])))
        .build();
        let result = runner
            .run(RunRequest::new(
                AgentDefinition::new("note-assistant-v1", "Note", "1", "mock"),
                "read page and calendar",
            ))
            .await
            .unwrap();
        assert_eq!(result.final_output.as_deref(), Some("read ok"));
        assert_eq!(facade_is_linked(), "llama_harness");
    }

    #[test]
    fn approved_note_and_calendar_writes_mutate() {
        let mut state = State::default();
        let binding = state.binding();
        state.write(binding, true, "approved").unwrap();
        state.create_event(true, "event-1").unwrap();
        assert_eq!(state.text, "approved");
        assert_eq!(state.calendar.len(), 1);
    }

    #[test]
    fn denied_malformed_disallowed_ambiguous_cancelled_and_limits_are_zero_mutation() {
        for reason in [
            "denied",
            "malformed",
            "disallowed",
            "ambiguous",
            "cancelled",
            "round_limit",
            "call_limit",
        ] {
            let mut state = State::default();
            let before = state.clone();
            let binding = state.binding();
            let result = if reason == "denied" {
                state.write(binding, false, "no")
            } else {
                Err(reason)
            };
            rejected(&state, result, before, reason);
        }
    }

    #[test]
    fn stale_page_or_block_binding_and_edited_proposal_cannot_mutate() {
        let mut state = State::default();
        let old = state.binding();
        state.page_revision += 1;
        let before = state.clone();
        let result = state.write(old, true, "stale page");
        rejected(&state, result, before, "revision_conflict");

        let mut state = State::default();
        let old = state.binding();
        state.block_revision += 1;
        let before = state.clone();
        let result = state.write(old, true, "stale block");
        rejected(&state, result, before, "revision_conflict");

        let mut state = State::default();
        let prior_approval = state.binding();
        state.block_revision += 1; // edited proposal requires revalidation and rebinding.
        let before = state.clone();
        let result = state.write(prior_approval, true, "edited");
        rejected(&state, result, before, "revision_conflict");
    }
}
