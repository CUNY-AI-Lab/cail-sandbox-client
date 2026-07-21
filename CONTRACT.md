# CAIL sandbox client contract

Status: reviewed against `cail-gateway`
`d554c70d497013c54fe5706a5c09d371da921192` on 2026-07-20.

This document defines the behavior this package owns. The vendored
`contract/sandbox-openapi.json` defines the gateway's HTTP surface. Gateway
authorization and lifecycle state remain authoritative.

## Boundary and invariants

The package is a backend-only adapter for the authenticated `/sandbox/v1/*`
HTTP surface. It owns request construction, local validation, response
validation, SSE parsing, and Web `AbortSignal` composition. It does not own
identity verification, authorization, compute placement, metering, workspace
continuity, or remote cancellation.

The client:

- sends requests only to its configured HTTPS origin and optional path prefix,
  with plain HTTP allowed only for exact loopback hosts;
- rejects URL credentials, query strings, fragments, redirects, and unexpected
  success statuses;
- sends `X-CAIL-App` and exactly one CAIL credential;
- never retries automatically;
- never logs requests, credentials, capabilities, commands, paths, file
  contents, output, or error details;
- accepts success JSON only as `application/json` and command streams only as
  `text/event-stream`;
- preserves raw file response bytes and source media type;
- treats every capability and control value as backend-only secret state.

`baseUrl` and a custom `fetchImpl` are trusted server configuration. A custom
fetch implementation can violate origin, redirect, header, cancellation, and
privacy guarantees; the client cannot defend against a malicious transport
implementation.

## Authentication and ownership

Each call carries either:

- `X-CAIL-Identity-JWT` for a CAIL session JWT; or
- `Authorization: Bearer ...` for an application-bound delegated key.

The gateway binds the authenticated subject and app to a sandbox lease. A
sandbox ID is only a locator. Lease access also requires the current
`X-CAIL-Sandbox-Lease` capability.

An explicit session is a fenced operation owned by that sandbox, subject, app,
and lease generation. File, exec, and session cleanup calls also require the
session ID, operation ID, and operation capability. Ownership mismatches are
hidden as `404 not_found`; callers must not use a 404 to infer whether another
subject's resource exists.

The client validates gateway-issued sandbox and session IDs as UUIDs before
placing them in a URL or header. Control values must be 32–256 characters from
`A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, and `-`.

File paths are slash-preserving and relative to `/workspace`. The client
rejects empty paths, absolute paths, NUL, percent-encoded input, and literal
`..` segments before sending a credential. The gateway repeats decoding and
performs the authoritative containment check. Root code inside a sandbox can
still create symlinks and modify any sandbox-local file, so this is not an
intra-sandbox security boundary.

## Lifecycle and operation state

`create()` acquires an active lease. `createSession()` acquires the sandbox's
single active operation. One operation allows:

1. zero or more file writes while it is ready;
2. exactly one exec;
3. zero or more file reads after a terminal exec; and
4. idempotent session cleanup.

The gateway may fence an operation as ambiguous after a failed file or exec
call. Callers must create a new operation rather than trying to reuse an
ambiguous one. Destroying the lease revokes its capabilities and is the safe
reconciliation action when application state cannot prove the remote outcome.

`destroy()` and `destroySession()` are designed to be idempotent, but a caller
still needs a fresh deadline and a confirmed response. A deadline expiring
during cleanup does not prove cleanup failed or succeeded.

## HTTP and errors

The exact success statuses are:

| Call             | Status | Body                         |
| ---------------- | ------ | ---------------------------- |
| `create`         | 201    | strict lifecycle JSON        |
| `running`        | 200    | strict lifecycle/status JSON |
| `destroy`        | 204    | none                         |
| `createSession`  | 201    | strict operation JSON        |
| `destroySession` | 204    | none                         |
| `readFile`       | 200    | raw bytes                    |
| `writeFile`      | 200    | exactly `{ "ok": true }`     |
| `exec`           | 200    | `text/event-stream`          |
| `openapi`        | 200    | JSON object                  |

JSON success objects reject undeclared fields. Unexpected statuses, media
types, shapes, timestamps, identifiers, and capabilities become
`CailSandboxError` with `code: "invalid_response"`.

A non-2xx response becomes a typed `CailSandboxError` only when it uses
`application/json`, exactly matches the OpenAPI nested error envelope, carries
both equal request-ID headers, and has an exact lowercase `x-should-retry`
value. Missing, malformed, extended, or wrongly typed responses fail closed as
`unknown_error`. Server error messages and `error.cail` details are returned to
the application but never logged by this package.

Response errors retain `X-CAIL-Request-Id` and the parsed `x-should-retry`
decision when present. The `x-request-id` alias must equal the canonical header
for a typed gateway error. Conflicting aliases are an `invalid_response`. The
OpenAPI currently declares request IDs only as strings, so UUID validation
remains the gateway's responsibility.

`x-should-retry` is evidence, not an instruction to replay a mutation. The
client performs no automatic retry.

## Command SSE

The parser implements WHATWG SSE framing through `eventsource-parser`. It
accepts only:

- `stdout` or `stderr` with one base64 `data` field;
- `exit` with one integer `exit_code`; or
- `error` with string `code`, `message`, and `request_id`.

The parser buffer is 2 MiB. A decoded output event is limited to 1 MiB. Unknown
events, invalid JSON/base64, undeclared fields, oversized events, output after
a terminal event, and multiple terminals are rejected as `invalid_stream`.

The first valid terminal is withheld until transport EOF proves that it is the
only terminal and that no output follows it. EOF without a terminal is
`invalid_stream`. A non-abort stream failure is
`stream_transport_error` with the original error as `cause`. Either case can
leave the remote command outcome unknown.

Caller cancellation and timeout errors remain their native runtime errors.
Breaking iteration cancels the response stream. Cancellation asks the
transport and gateway to stop; it is not proof that the command stopped before
making changes.

## Timeouts, retries, and ambiguous outcomes

Every method accepts a caller `AbortSignal`. `defaultTimeoutMs`, when set,
composes a client-wide ceiling with the per-call signal; the first abort wins.
The signal remains relevant while a file response or command stream is being
consumed.

An abort controls the local fetch and stream. It does not create transactional
rollback. In particular:

- `create` and `createSession` require caller-owned idempotency keys, so an
  exact replay can reconcile the same attempt;
- an old create key is retired after confirmed destruction while its bounded
  gateway tombstone remains;
- `running`, `readFile`, and `openapi` are observational;
- `destroy` and `destroySession` are idempotent cleanup operations;
- `exec` and `writeFile` must not be replayed after an ambiguous failure; and
- no method is retried by this package.

The current gateway does not pass request cancellation or its transaction
deadline into the provider file-write call. A timed-out write can continue
remotely. Treat the whole operation as ambiguous and reconcile by destroying
the operation or lease.

## Bounds and privacy

Client-owned bounds are:

| Value                | Bound                            |
| -------------------- | -------------------------------- |
| credential token     | 1–8,192 visible ASCII characters |
| app slug             | 1–64 lowercase slug characters   |
| control value        | 32–256 allowed opaque characters |
| command              | 1–16,384 JavaScript characters   |
| default timeout      | 1–2,147,483,647 ms               |
| SSE parser buffer    | 2 MiB                            |
| decoded output event | 1 MiB                            |

The gateway limits JSON requests to 64 KiB. File and cumulative output limits
are deployment configuration, not discoverable from the current OpenAPI. The
reviewed production-shaped source uses 8 MiB files and 1 MiB cumulative command
output; validated gateway maxima are 16 MiB and 8 MiB respectively. A live
deployment may differ. The authoritative behavior is a typed `413` or terminal
output-limit error, so callers must bound their own inputs and retained output.

Adopt correlation once at the application request boundary and pass the same
`CailCorrelation` to related calls. Use only opaque UUID-like scope,
idempotency, and operation values. Do not place email addresses, prompts,
filenames, or other user content in them.

## Package, CI, and release boundary

The package root exports ESM JavaScript and declarations from committed
`dist/`. The OpenAPI artifact is exported from
`./contract/sandbox-openapi.json`. The package records Bun `1.3.14`; CI installs
the frozen lockfile with that version, rebuilds, and rejects `dist/` drift.

Package-local CI verifies the vendored OpenAPI digest without downloading a
mutable file or receiving access to the private gateway repository. A local
integration checkout can compare byte-for-byte with a sibling gateway, or set
`CAIL_GATEWAY_OPENAPI` to an explicit artifact. Cross-repository acceptance
remains an integration release gate rather than a package CI dependency.

This package has no Git tags and is not published to npmjs.com or GitHub
Packages. `0.0.1` is metadata, not a released compatibility claim. The only
current distribution boundary is an immutable full Git commit SHA. Any future
publish is restricted to private GitHub Packages and runs the full repository
gate before packaging.

At the start of this review, both the gateway and Kale Workbench accepted
client revision `3d90d1cdcf8953cf64822682f589099484734b5d`. A later client
commit, including the remediation containing this document, is not an accepted
shared-primitive revision until those repositories separately review and pin
it. Byte-identical OpenAPI proves HTTP inventory parity, not full SSE,
cancellation, or lifecycle semantic parity.

## Design and rollback gate

In scope: this client, its tests, vendored OpenAPI, documentation, build, and
CI. Out of scope: gateway, Workbench, deployment configuration, credentials,
and live resources.

No migration or persistent data change is involved. Runtime hardening can be
rolled back by pinning the prior immutable client SHA. CI hardening can be
rolled back independently, but restoring a full private gateway checkout would
reintroduce unnecessary private-source exposure.

Known gateway issues discovered during this review remain upstream:

- `/health` is documented as unauthenticated liveness but current production
  preflight can return 503 when auth configuration is incomplete;
- file-size configuration is absent from OpenAPI;
- file writes lack provider-side request cancellation/deadline propagation;
- `create_in_progress` currently carries `x-should-retry: false` despite safe
  exact-attempt reconciliation; and
- OpenAPI describes SSE only in prose, so fixtures and cross-repository tests
  remain necessary.
