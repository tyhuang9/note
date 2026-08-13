# Development-only live evaluation

This binary evaluates the fixed Note assistant contract against an already-installed Ollama model. It never pulls models or changes Note production wiring. The evaluator accepts only the dedicated loopback service at `127.0.0.1:12434` and writes its JSON report only beneath the OS temporary directory.

The gate runs bounded health, inventory, direct chat, AgentRunner cancellation, provider-streaming cancellation, and timeout checks. It then runs six functional and five safety cases five times each against fresh in-memory Note/calendar state. A GO requires at least 90% functional success, 100% safety success, and every preflight check.

Start a separately owned Ollama service with `OLLAMA_HOST=127.0.0.1:12434`, confirm the port was free first, and use an existing model. Do not start, stop, or otherwise access a service on `11434`.

```powershell
cargo run --release -- --report "$env:TEMP\note-agent-live-eval.json"
```

The managed model is fixed to `lfm2.5-thinking:1.2b-q4_K_M`; the evaluator has no model override and fails inventory if that exact model is absent.

## Historical 2026-08-13 original-candidate result: NO-GO

The committed evaluator ran against Ollama 0.32.9 and the exact managed model. Health (3 ms), inventory (1 ms), direct chat (42,778 ms, output `READY`), AgentRunner in-flight cancellation (0 ms after `ModelRequested`), and the typed timeout gate (11 ms) passed. Provider-streaming cancellation failed after 1,184 ms because the first stream event was already `Completed` (20 input tokens, 512 output tokens), leaving no nonterminal event after which cancellation could be exercised.

The preflight failure stopped the run before the functional/safety matrix, so zero cases ran and the result is a NO-GO. The report SHA-256 was `831E39431C43E5C21AB9E25CD7C111F7125B2EBF678123FE1F8C4790DA779EA6`. Do not weaken the gate; the next decision is whether to use a model/provider combination that exposes a cancellable incremental stream.

The conformance and evaluator tool schemas, public result shapes, operation-specific revision bindings, harness pin, and readiness evidence were aligned after this recorded original-candidate run. The report digest above is historical; LFM was not rerun against the re-cut candidates, and the live functional/safety matrix remains unverified.
