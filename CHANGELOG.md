# Changelog

## v28 — 2026-04-21

- **Ask mode (opt-in generative LLM)**: new command-palette sub-mode (`Ctrl/⌘+K`, prefix `?`) turns plain-English requests into a previewable batch of the existing `executeIntelOp` operations. Default model is `HuggingFaceTB/SmolLM2-360M-Instruct` q4 (~230 MB), with tiny 135M and bigger Qwen2.5-0.5B presets plus onnx-community fallbacks. Strictly opt-in: nothing downloads until the user toggles Settings → Integrations → Generative AI and clicks Download. Runs on-device via Transformers.js (WebGPU → WASM).
- **New files**: `js/gen.js` (LLM loader), `js/ask.js` (RAG + tool-calling orchestrator), `js/tool-schema.js` (pure-JS validator for 21 op types with enum coercion, id checks, 50-op cap, destructive-level aggregation).
- **Safety**: every LLM-proposed op flows through the existing `_pendingOps` preview + undo stack; never auto-applies; destructive batches (DELETE or ≥5 mass ARCHIVE/CHANGE_LIST) need extra confirmation.
- **Resilience**: auto-fallback between `HuggingFaceTB/*` and `onnx-community/*` mirrors on 401/403/404; `InterruptableStoppingCriteria` for real mid-generation abort; cancellable download; friendly error translation; config migration off the stale Xenova/* slugs.
- **UX**: header chip now composes embedding + LLM state; promo chip near the task input appears when the LLM is ready; undo button tooltip shows batch source; Ask input history with ArrowUp recall; Clear Ask history / Clear LLM cache buttons in Settings.
- **Tests**: +33 regression tests (validator, config migration, ask-pipeline, prompt-injection).
- **Docs**: README stance updated (cloud LLMs forbidden, not generative in general); ARCHITECTURE documents the RAG flow; DEPLOY note about CSP allow-list.

## v26 — 2026-04-21

- Security: CSP meta tag, XSS hardening (attribute contexts, smart-add tags), inbound P2P accept/reject gate, sync timestamp clamping, calendar fetch URL/timeout/size limits, CSV formula injection mitigation, aligned inline service worker cache policy with main `sw.js`.
- Correctness: midnight rollover archives then resets daily counters safely; local `completedAt` timestamps for “done today”; `resumeTimer` restarts keepalive; monthly recurrence day clamp; RRULE `COUNT=0` returns no occurrences; calendar month navigation uses local `YYYY-MM`.
- Performance / UX: debounced auto-save; chunked duplicate-similarity scans; single-flight `intelLoad` / Schwartz embeddings; filters summary line; command palette footer hints; search clear + semantic pill; swipe tip + today-banner snooze; drag handle when sort is manual; export toasts; floating mini timer wording in README.
- DX: `js/version.js` release anchor, `LICENSE`, docs (`SECURITY`, `CONTRIBUTING`, `ARCHITECTURE`), CI smoke tests for version ↔ service worker sync.
