use std::{
    sync::{mpsc::sync_channel, mpsc::SyncSender},
    thread,
    time::Instant,
};

use tracing::{
    field::Visit,
    span::{Attributes, Id, Record},
    Subscriber,
};
use tracing_subscriber::{
    layer::{Context, Layer},
    prelude::*,
    registry::LookupSpan,
};

/// Fixed local operation names. Never add request data, identifiers, or errors here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Operation {
    CalendarInitialization,
    CalendarAgenda,
    CalendarSearch,
    CalendarMutation,
    AssistantTool,
    ModelStatus,
    ModelInstall,
    VoiceCapture,
    VoiceTranscription,
    WidgetCreation,
    WidgetRefresh,
    MainActivation,
}

impl Operation {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::CalendarInitialization => "calendar.initialization",
            Self::CalendarAgenda => "calendar.agenda",
            Self::CalendarSearch => "calendar.search",
            Self::CalendarMutation => "calendar.mutation",
            Self::AssistantTool => "assistant.tool",
            Self::ModelStatus => "model.status",
            Self::ModelInstall => "model.install",
            Self::VoiceCapture => "voice.capture",
            Self::VoiceTranscription => "voice.transcription",
            Self::WidgetCreation => "widget.creation",
            Self::WidgetRefresh => "widget.refresh",
            Self::MainActivation => "main.activation",
        }
    }

    fn from_label(label: &str) -> Option<Self> {
        [
            Self::CalendarInitialization,
            Self::CalendarAgenda,
            Self::CalendarSearch,
            Self::CalendarMutation,
            Self::AssistantTool,
            Self::ModelStatus,
            Self::ModelInstall,
            Self::VoiceCapture,
            Self::VoiceTranscription,
            Self::WidgetCreation,
            Self::WidgetRefresh,
            Self::MainActivation,
        ]
        .into_iter()
        .find(|operation| operation.label() == label)
    }
}

#[derive(Clone, Copy)]
struct Diagnostic {
    operation: Operation,
    elapsed_ms: u64,
}

impl Diagnostic {
    fn line(self) -> String {
        format!(
            "note.performance operation={} elapsed_ms={} outcome=closed",
            self.operation.label(),
            self.elapsed_ms
        )
    }
}

/// Installs a bounded, local-only stderr sink. Initialization and diagnostics never block the app.
pub(crate) fn initialize() {
    let (sender, receiver) = sync_channel::<Diagnostic>(128);
    let _ = thread::Builder::new()
        .name("note-performance".into())
        .spawn(move || {
            while let Ok(diagnostic) = receiver.recv() {
                eprintln!("{}", diagnostic.line());
            }
        });
    let _ = tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(LocalDiagnosticsLayer { sender }),
    );
}

#[derive(Default)]
struct SpanFields {
    operation: Option<Operation>,
    elapsed_ms: Option<u64>,
}

struct FieldVisitor {
    fields: SpanFields,
}
impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "operation" {
            self.fields.operation = Operation::from_label(value);
        }
    }
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if field.name() == "elapsed_ms" {
            self.fields.elapsed_ms = Some(value);
        }
    }
    fn record_debug(&mut self, _: &tracing::field::Field, _: &dyn std::fmt::Debug) {}
}

struct LocalDiagnosticsLayer {
    sender: SyncSender<Diagnostic>,
}
impl<S> Layer<S> for LocalDiagnosticsLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn on_new_span(&self, attributes: &Attributes<'_>, id: &Id, context: Context<'_, S>) {
        if attributes.metadata().name() != "note.operation" {
            return;
        }
        let mut visitor = FieldVisitor {
            fields: SpanFields::default(),
        };
        attributes.record(&mut visitor);
        if let Some(span) = context.span(id) {
            span.extensions_mut().insert(visitor.fields);
        }
    }
    fn on_record(&self, id: &Id, values: &Record<'_>, context: Context<'_, S>) {
        let Some(span) = context.span(id) else {
            return;
        };
        let mut extensions = span.extensions_mut();
        let Some(fields) = extensions.get_mut::<SpanFields>() else {
            return;
        };
        let mut visitor = FieldVisitor {
            fields: SpanFields::default(),
        };
        values.record(&mut visitor);
        if visitor.fields.elapsed_ms.is_some() {
            fields.elapsed_ms = visitor.fields.elapsed_ms;
        }
    }
    fn on_close(&self, id: Id, context: Context<'_, S>) {
        let Some(span) = context.span(&id) else {
            return;
        };
        let extensions = span.extensions();
        let Some(fields) = extensions.get::<SpanFields>() else {
            return;
        };
        let (Some(operation), Some(elapsed_ms)) = (fields.operation, fields.elapsed_ms) else {
            return;
        };
        let _ = self.sender.try_send(Diagnostic {
            operation,
            elapsed_ms,
        });
    }
}

pub(crate) struct Timer {
    started: Instant,
    span: tracing::Span,
}

impl Timer {
    pub(crate) fn start(operation: Operation) -> Self {
        Self {
            started: Instant::now(),
            span: tracing::info_span!(
                "note.operation",
                operation = operation.label(),
                elapsed_ms = tracing::field::Empty
            ),
        }
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        self.span.record(
            "elapsed_ms",
            u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operation_labels_are_static_and_content_free() {
        for operation in [
            Operation::CalendarInitialization,
            Operation::CalendarAgenda,
            Operation::CalendarSearch,
            Operation::CalendarMutation,
            Operation::AssistantTool,
            Operation::ModelStatus,
            Operation::ModelInstall,
            Operation::VoiceCapture,
            Operation::VoiceTranscription,
            Operation::WidgetCreation,
            Operation::WidgetRefresh,
            Operation::MainActivation,
        ] {
            assert!(operation
                .label()
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'.'));
        }
    }
    #[test]
    fn timer_uses_monotonic_duration() {
        let timer = Timer::start(Operation::CalendarInitialization);
        assert!(timer.started.elapsed().as_millis() <= u128::from(u64::MAX));
    }
    #[test]
    fn diagnostic_output_is_fixed_and_content_free() {
        let line = Diagnostic {
            operation: Operation::CalendarAgenda,
            elapsed_ms: 7,
        }
        .line();
        assert_eq!(
            line,
            "note.performance operation=calendar.agenda elapsed_ms=7 outcome=closed"
        );
    }
    #[test]
    fn timer_emits_only_static_diagnostic_fields_and_ignores_unknown_labels() {
        use std::time::Duration;
        use tracing_subscriber::prelude::*;

        let (sender, receiver) = sync_channel(2);
        let subscriber = tracing_subscriber::registry().with(LocalDiagnosticsLayer { sender });
        tracing::subscriber::with_default(subscriber, || {
            drop(Timer::start(Operation::CalendarAgenda));
            drop(tracing::info_span!(
                "note.operation",
                operation = "unknown.operation",
                elapsed_ms = 3_u64,
                private_field = "not emitted"
            ));
        });
        let diagnostic = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(diagnostic.operation, Operation::CalendarAgenda);
        assert_eq!(
            diagnostic.line().split_whitespace().collect::<Vec<_>>(),
            [
                "note.performance",
                "operation=calendar.agenda",
                &format!("elapsed_ms={}", diagnostic.elapsed_ms),
                "outcome=closed",
            ]
        );
        assert!(receiver.recv_timeout(Duration::from_millis(20)).is_err());
    }
}
