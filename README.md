# @cuny-ai-lab/cail-sandbox-client

A backend-only Fetch client for the CAIL Sandbox service. It wraps the typed
`/sandbox/v1` lifecycle, session, file, command-stream, and usage surface
without exposing Cloudflare SDK types. The service repository is the sole
owner of the OpenAPI definition.

## Boundary

Create the client only in a protected application backend. Every request uses:

- a verified CAIL identity JWT in `X-CAIL-Identity-JWT`;
- the configured application slug in `X-CAIL-App`; and
- lease, session, and operation capabilities where required by the service.

Sandbox IDs are locators, not credentials. Capabilities and JWTs must not enter
browser state, workspace files, commands, logs, or analytics. The client
accepts HTTPS origins and plain HTTP only on exact loopback hosts, disables
redirect following, strips competing credential headers, and never retries.

The service, not this client, verifies identity and owns subject/app isolation,
lease state, offline execution policy, metering, and settlement.

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
for an owned lease. The client rejects malformed dates, unsafe integer
quantities, inconsistent aggregate remaining usage, mismatched lease IDs, and
undeclared fields.

`destroy()` is idempotent, but a transport failure still leaves its outcome
unknown. Query settlement only after a confirmed destroy and use a fresh
deadline for cleanup.

## Command and error behavior

Command output uses WHATWG SSE framing through `eventsource-parser`. Only
base64 `stdout` and `stderr` objects and one terminal `exit` or `error` event
are accepted. The terminal is withheld until EOF proves it is unique.
Malformed, duplicate, post-terminal, oversized, and unterminated streams fail
closed.

Strict JSON success bodies reject undeclared fields. A non-2xx response becomes
a typed `CailSandboxError` only when its media type, nested CAIL error envelope,
matching request-ID headers, and `x-should-retry` header conform. A malformed
authority response becomes `unknown_error` or `invalid_response` without
automatic replay.

All calls accept an `AbortSignal`; `defaultTimeoutMs` adds a client-wide upper
bound. Cancellation stops local transport work but does not prove remote
rollback. Do not replay exec or file writes after an ambiguous failure.

## Verification and end-to-end testing

```sh
bun install --frozen-lockfile
bun run check
bun run package:dry-run
```

The package dry run contains generated `dist` JavaScript and declarations plus
`README.md`, `CONTRACT.md`, and `LICENSE`; it does not ship source files or a
duplicate service schema. The client and service are exercised together by the
local end-to-end workflow in `kale-integration`.
