# CAIL Sandbox client contract

Status: reviewed against `cail-sandbox-service`
`75d09b40725f977e299d4696e9a50621603cdd64`.

## Owned boundary

This package owns request construction, local input validation, strict response
parsing, SSE framing, and Web `AbortSignal` composition for the authenticated
`/sandbox/v1` HTTP surface. It does not own identity verification,
authorization, execution placement, policy, metering, settlement, or durable
state.

The client sends one `X-CAIL-Identity-JWT` plus configured `X-CAIL-App`.
Authenticated identity comes only from the service's exact-audience verifier.
Lease, session, operation, and file calls add only the capabilities required by
the OpenAPI. The client never derives a principal or accepts one in request
JSON.

## HTTP surface

| Client call | HTTP operation | Success |
| --- | --- | --- |
| `create` | `POST /sandbox/v1/sandbox` | 201 strict lifecycle |
| `running` | `GET /sandbox/v1/sandbox/{id}/running` | 200 strict status |
| `destroy` | `DELETE /sandbox/v1/sandbox/{id}` | 204 |
| `usage` | `GET /sandbox/v1/usage` | 200 strict UTC-day snapshot |
| `settlement` | `GET /sandbox/v1/usage/{leaseId}` | 200 immutable settlement |
| `createSession` | `POST /sandbox/v1/sandbox/{id}/session` | 201 strict session |
| `destroySession` | `DELETE /sandbox/v1/sandbox/{id}/session/{sid}` | 204 |
| `readFile` | `GET /sandbox/v1/sandbox/{id}/file/{path}` | 200 raw bytes |
| `writeFile` | `PUT /sandbox/v1/sandbox/{id}/file/{path}` | 200 `{ok:true}` |
| `exec` | `POST /sandbox/v1/sandbox/{id}/exec` | 200 SSE |
| `openapi` | `GET /sandbox/v1/openapi.json` | 200 JSON |

Create accepts only `profile: "offline-code"`. Lifecycle responses also carry
`instance_class: "lite" | "basic" | "standard-1"`. The client exposes no
arbitrary image, network, mount, tunnel, pool, persistence, or background
process controls.

## Usage semantics

Aggregate usage is a current UTC-day snapshot:

```text
period, unit=mib_milliseconds, limit, used, reserved, remaining, active_leases
```

All quantities are nonnegative safe integers, `active_leases` is 0 or 1, and
`remaining = max(0, limit - used - reserved)`. This is separate from model
quota.

Per-lease settlement is an immutable terminal record:

```text
lease_id, period_start, period_end, unit=mib_milliseconds,
quantity, settled_at, state=settled
```

`quantity` is a nonnegative safe integer. The service returns 404 before
settlement and for a subject/app mismatch. The bounded service tombstone
returns the same record after an initial or idempotent destroy. Diagnostic log
events are not settlement authority.

## Validation and failures

The client rejects malformed IDs, capabilities, paths, profile values,
timestamps, dates, quantities, response keys, media types, success statuses,
and lease-ID mismatches. It accepts only HTTPS, with HTTP restricted to exact
loopback hosts, and rejects redirects.

Typed server errors require the exact nested CAIL envelope, both equal request
ID headers, `application/json`, and lowercase `x-should-retry`. Malformed
authority responses fail closed. The client performs no automatic retries.

SSE accepts base64 `stdout`/`stderr` followed by exactly one `exit` or `error`.
The terminal is withheld until EOF. Unknown, malformed, duplicate,
post-terminal, oversized, and unterminated streams are rejected. A transport
failure or abort can leave the remote outcome ambiguous.

## Provenance and release

The packaged OpenAPI is byte-identical to the accepted service artifact and
has SHA-256
`f0e117af9257b70a6e31cbd9dea44175f8a8164b088a780854089b8c6ba11b29`.
Package-local checks pin the digest and compare a sibling service checkout when
available.

No migration or persistent-state change is owned here. Rollback means pinning
the prior exact client source revision. No package is published and no
Cloudflare resource is created by this repository.
