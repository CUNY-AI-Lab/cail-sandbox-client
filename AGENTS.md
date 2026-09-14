# cail-sandbox-client

## Recommended CAIL fleet practice

For the colleague-facing engineering and agent-review defaults, see the [CAIL Fleet Engineering and Review Practice](https://github.com/CUNY-AI-Lab/cail-knowledge-base/pull/27). This is recommended unless this repository's own contract or CI makes a rule mandatory. Use Luna workers for bounded independent tasks and Astra for an independent review of substantial or load-bearing changes; keep one primary owner responsible for the combined result and real-path verification.

- Owns the backend-only Fetch client for the typed `/sandbox/v1` lifecycle, session, file, command-stream, usage, and settlement calls.
- The service owns the OpenAPI wire definition; this package owns request construction, local validation, CAIL identity/capability headers, correlation, strict response parsing, and SSE framing.
- This is the backend-only Fetch boundary for the current Computer-backed Sandbox service; callers own application identity and reconciliation.
- Require a verified identity JWT supplied by the caller; treat lease, session, and operation capabilities as opaque service-issued values.
- Use HTTPS origins, exact loopback-only HTTP for local work, disabled redirects, and one request attempt with no automatic retry.
- Cancellation or a transport failure can leave the remote operation ambiguous; callers decide cleanup and reconciliation.
- Sandbox service code owns identity verification, subject/app isolation, authorization, lease policy, execution placement, metering, settlement, and durable state.
- Do not add Cloudflare runtime behavior, browser-facing credential handling, identity or lease authority, quota authority, migration, or service business logic.
- Keep command output fail-closed to the documented WHATWG SSE events and preserve strict success/error envelopes.

Check with `bun run check`.

CI runs `bun run check` on pull requests and `main`; stable release tags run
the checked publish workflow with package write access. This client has no
Worker/Computer deploy path and no Cloudflare token.
