# CAIL Sandbox client contract

Status: reviewed against `cail-sandbox-service`.

## Owned boundary

This package owns request construction, local input validation, strict response
parsing, SSE framing, and Web `AbortSignal` composition for the authenticated
`/sandbox/v1` HTTP surface. It does not own identity verification,
authorization, execution placement, policy, metering, settlement, or durable
state.

The client sends one `X-CAIL-Identity-JWT` plus configured `X-CAIL-App`.
Authenticated identity comes only from the service's exact-audience verifier.
Lease, session, operation, and file calls add only the capabilities required by
the service. The client never derives a principal or accepts one in request
JSON.

Request correlation follows the accepted `cail-log` source contract. The public
helpers adopt and propagate canonical lowercase UUIDv4 and UUIDv7 request IDs;
other UUID versions, variants, casing, and malformed values are rejected or
replaced as defined by `cail-log`. Lifecycle calls preserve the accepted request
ID without reminting it.

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

Lifecycle responses carry `instance_class: "lite" | "basic" | "standard-1"`. The client exposes no
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

The client rejects malformed IDs, capabilities, and paths,
timestamps, dates, quantities, response keys, media types, success statuses,
and lease-ID mismatches. It accepts only HTTPS, with HTTP restricted to exact
loopback hosts, and rejects redirects.

File phase authorization is service-owned: `writeFile` is ready-only, while
`readFile` is allowed in ready or terminal. Both fail with `409 operation_state`
while executing or ordinarily ambiguous; terminal writes also fail. A persisted
file-write ambiguity returns retryable `503 file_write_ambiguous` for either
file method until the operation is reconciled. The client forwards these strict
service outcomes without adding a local operation-state model.

Typed server errors require the exact nested CAIL envelope, both equal request
ID headers, `application/json`, and lowercase `x-should-retry`. Malformed
authority responses fail closed. The client performs no automatic retries.

SSE accepts exact JSON `{ "data": "<base64>" }` objects for
`stdout`/`stderr`, followed by exactly one JSON `exit` or `error`. Bare base64
is the upstream Cloudflare Bridge wire shape and is not accepted at the CAIL
public boundary.
The terminal is withheld until EOF. Unknown, malformed, duplicate,
post-terminal, oversized, and unterminated streams are rejected. A transport
failure or abort can leave the remote outcome ambiguous.

## Provenance and release

No migration or persistent-state change is owned here. Sandbox Client and CAIL
Log releases are immutable package artifacts. The source checkout's release
evidence records receipts observed during review; it does not assert the
current registry availability of any version. Rollback means pinning a known
published Client version after release-authority checks. No Cloudflare resource
is created by this repository. The publish gate resolves the remote release tag
and requires its commit to equal both the workflow SHA and the live
default-branch head. Branch protection, deleted-version history, and the
package's GitHub Actions access or inherited-permissions setting remain external
release gates.
