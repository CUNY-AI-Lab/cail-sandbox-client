# @cuny-ai-lab/cail-sandbox-client

A backend-only Fetch client for the CAIL Sandbox service. It wraps the reviewed
`/sandbox/v1` lifecycle, session, file, command-stream, and usage surface
without exposing Cloudflare SDK types.

The canonical service contract is
`cail-sandbox-service` commit
`82c3068c59da010677d33b862fed1dbad156964a`. This repository vendors its
OpenAPI document byte-for-byte at `contract/sandbox-openapi.json`, SHA-256
`50458eba352ce01a776519e43f1ff7fadacf4d7ad8ca309aefdb649fc76e4591`.

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

The package is not published. Its correlation implementation and public
re-exports come directly from the source- and hash-qualified, unpublished
`cail-log` build at revision
`cb6ffc0cfd4cb544639cbf288ff6eb24c7027e98` (tree
`618c4bdfae0effadbe23cfd6c4dfb1fcf6440697`), with tarball SHA-256
`8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215`.
The upstream manifest still says `0.6.0`; that is provenance, not a claim that
this behavior was published as `0.6.0`. An immutable successor release is still
required before registry consumers can adopt the UUIDv7 contract. This package
has no registry or consumer-override dependency on `cail-log`.
Consume only an exact reviewed Sandbox-client source commit. Do not interpret
metadata version `0.1.0` as registry availability.

This client creates no Cloudflare resources and contains no deployment command.
Isolated service deployment and end-to-end resource cleanup belong to the
Sandbox and integration workstreams.
