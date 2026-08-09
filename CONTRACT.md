# CAIL Sandbox client contract

The service repository owns the OpenAPI definition. This package owns the
typed `/sandbox/v1` wire client: request construction, local input validation,
authentication and correlation headers, strict response and error parsing, SSE
framing, and `AbortSignal` behavior. It does not own identity verification,
authorization, execution placement, policy, metering, settlement, or durable
state.

This v0.1.1 candidate targets the isolated Computer-backed sandbox
constellation. Existing production integrations remain separate; this
contract does not define a migration or compatibility layer.

## Requests

Every request carries one `X-CAIL-Identity-JWT` and the configured
`X-CAIL-App`. Lease, session, operation, and file calls add only the
capabilities required by the service. The client never derives a principal or
accepts one in request JSON. Redirects are rejected and requests are never
retried automatically.

Correlation uses the accepted `cail-log` types and headers. Canonical request
IDs are preserved when supplied; malformed correlation input is rejected with
the fixed `Invalid CAIL correlation object.` client error.

## HTTP surface

| Client call      | HTTP operation                                  | Success                     |
| ---------------- | ----------------------------------------------- | --------------------------- |
| `create`         | `POST /sandbox/v1/sandbox`                      | 201 strict lifecycle        |
| `running`        | `GET /sandbox/v1/sandbox/{id}/running`          | 200 strict status           |
| `destroy`        | `DELETE /sandbox/v1/sandbox/{id}`               | 204                         |
| `usage`          | `GET /sandbox/v1/usage`                         | 200 strict UTC-day snapshot |
| `settlement`     | `GET /sandbox/v1/usage/{leaseId}`               | 200 immutable settlement    |
| `createSession`  | `POST /sandbox/v1/sandbox/{id}/session`         | 201 strict session          |
| `destroySession` | `DELETE /sandbox/v1/sandbox/{id}/session/{sid}` | 204                         |
| `readFile`       | `GET /sandbox/v1/sandbox/{id}/file/{path}`      | 200 raw bytes               |
| `writeFile`      | `PUT /sandbox/v1/sandbox/{id}/file/{path}`      | 200 `{ok:true}`             |
| `exec`           | `POST /sandbox/v1/sandbox/{id}/exec`            | 200 SSE                     |

Lifecycle responses carry `instance_class: "lite" | "basic" | "standard-1"`.
The client exposes no arbitrary image, network, mount, tunnel, pool,
persistence, or background process controls. The Computer-backed service owns
the durable Workspace and container runtime.

## Usage and settlement

`usage()` returns the current UTC-day snapshot in integer
`mib_milliseconds`:

```text
period, unit, limit, used, reserved, remaining, active_leases
```

Quantities are nonnegative safe integers, `active_leases` is 0 or 1, and
`remaining = max(0, limit - used - reserved)`. `settlement(leaseId)` returns
the immutable terminal record for an owned lease:

```text
lease_id, period_start, period_end, unit, quantity, settled_at, state=settled
```

The service returns 404 before settlement and for a subject or app mismatch.
The client does not turn diagnostic events into accounting authority.

## Validation and failures

The client rejects malformed IDs, capabilities, paths, timestamps, dates,
quantities, response keys, media types, success statuses, and lease-ID
mismatches. It accepts HTTPS origins, with HTTP restricted to exact loopback
hosts.

Typed server errors require the exact nested CAIL envelope, matching request-ID
headers, `application/json`, and lowercase `x-should-retry`. Malformed
authority responses fail closed. The client performs no automatic retries.

SSE accepts exact JSON `{ "data": "<base64>" }` objects for `stdout` and
`stderr`, followed by exactly one JSON `exit` or `error` event. Unknown,
malformed, duplicate, post-terminal, oversized, and unterminated streams are
rejected. A transport failure or abort can leave the remote outcome ambiguous.

All calls accept an `AbortSignal`; `defaultTimeoutMs` adds a client-wide upper
bound. Cancellation stops local transport work but does not prove remote
rollback. Do not replay exec or file writes after an ambiguous failure.
