# @cuny-ai-lab/cail-sandbox-client

A backend-only Fetch client for the CAIL Sandbox service. It wraps the reviewed
`/sandbox/v1` lifecycle, session, file, command-stream, and usage surface
without exposing Cloudflare SDK types.

The canonical service contract is
`cail-sandbox-service` commit
`75d09b40725f977e299d4696e9a50621603cdd64`. This repository vendors its
OpenAPI document byte-for-byte at `contract/sandbox-openapi.json`, SHA-256
`f0e117af9257b70a6e31cbd9dea44175f8a8164b088a780854089b8c6ba11b29`.

## Boundary

Create the client only in a protected application backend. Every request uses:

- a verified CAIL identity JWT in `X-CAIL-Identity-JWT`, with scalar audience
  `cail:sandbox-service`;
- the configured application slug in `X-CAIL-App`; and
- lease/session operation capabilities where the OpenAPI requires them.

Sandbox IDs are locators, not credentials. Capabilities and JWTs must not enter
browser state, workspace files, commands, logs, or analytics. The client
accepts HTTPS origins and plain HTTP only on exact loopback hosts, disables
redirect following, strips competing credential headers, and never retries.

The service, not this client, verifies identity and owns subject/app isolation,
lease state, offline execution policy, metering, and settlement. The service
keeps the volatile Cloudflare Sandbox SDK behind its own adapter.

## Example

```ts
import { createCailSandboxClient } from "@cuny-ai-lab/cail-sandbox-client";

const client = createCailSandboxClient({
  baseUrl: "https://sandbox.example.edu",
  app: "kale-workbench",
  defaultTimeoutMs: 190_000,
});
const identity = { kind: "jwt" as const, token: identityJwt };

const lease = await client.create(
  {
    scopeKey: conversationScopeKey,
    idempotencyKey: crypto.randomUUID(),
    profile: "offline-code",
  },
  identity,
);
const operation = await client.createSession(
  lease,
  {
    operationId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  },
  identity,
);

await client.writeFile(lease, operation, "main.py", "print('hello')", identity);
for await (const event of await client.exec(
  lease,
  operation,
  "python main.py",
  identity,
)) {
  if (event.type === "error") throw new Error(event.code);
}

await client.destroySession(lease, operation, identity);
await client.destroy(lease, identity);
const settled = await client.settlement(lease.id, identity);
```

`usage()` returns the current UTC-day snapshot in exact integer
`mib_milliseconds`. `settlement(leaseId)` returns the immutable terminal usage
for an owned lease. It returns the service's typed `404` before settlement and
for a subject/app mismatch. The client rejects malformed dates, unsafe integer
quantities, inconsistent aggregate remaining usage, a mismatched lease ID, and
undeclared fields.

`destroy()` is idempotent, but a transport failure still leaves its outcome
unknown. Query settlement only after a confirmed destroy; use a fresh deadline
for cleanup. The package does not turn diagnostic events into accounting
authority.

## Command and error behavior

Command output uses WHATWG SSE framing through `eventsource-parser`. Only
base64 `stdout`/`stderr` and one terminal `exit` or `error` event are accepted.
The terminal is withheld until EOF proves it is unique. Malformed, duplicate,
post-terminal, oversized, or unterminated streams fail closed.

Strict JSON success bodies reject undeclared fields. A non-2xx response becomes
a typed `CailSandboxError` only when its media type, nested CAIL error envelope,
matching request-ID headers, and `x-should-retry` header all conform. A malformed
authority response becomes `unknown_error` or `invalid_response` without
automatic replay.

All calls accept an `AbortSignal`; `defaultTimeoutMs` adds a client-wide upper
bound. Cancellation stops local transport work but does not prove remote
rollback. Do not replay exec or file writes after an ambiguous failure.

## Verification and consumption

```sh
bun run check
bun pm pack --dry-run
```

`bun run check:service-contract` compares the vendored artifact byte-for-byte
with a sibling service checkout when present, or verifies the pinned digest
standalone. Set `CAIL_SANDBOX_SERVICE_OPENAPI` to check another explicit file.

The package is not published. Consume only an exact reviewed source commit and
override its `@cuny-ai-lab/cail-log` dependency to the accepted local/source
revision `482b2a102fddac589d6db8a03cbea171df819872` until an explicit package
release decision is made. Do not interpret metadata version `0.1.0` as registry
availability.

This client creates no Cloudflare resources and contains no deployment command.
Isolated service deployment and end-to-end resource cleanup belong to the
Sandbox and integration workstreams.
