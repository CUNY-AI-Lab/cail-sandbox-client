# @cuny-ai-lab/cail-sandbox-client

A small Web-standard client for CAIL-governed remote execution, covering
sandbox lifecycle, raw files, command SSE, and execution scopes. The
model-inference package, `@cuny-ai-lab/cail-client`, has a different contract.

The server contract targets RPC transport and explicit sessions through the
gateway's matching Cloudflare Sandbox SDK. The SDK and image are both pinned to
`0.12.3`. This package calls the bounded `/sandbox/v1/*` surface directly over
HTTP without importing the Cloudflare SDK.

## Boundary and security model

Use this client from a protected application backend. Sandbox lease and
operation capabilities are backend credentials. Keep them out of browser
state, workspace files, commands, SSE output, analytics, and logs. The same
rule applies to the CAIL session JWT or delegated key passed to each call.

The client sets `X-CAIL-App` and exactly one credential. It removes competing
`Authorization` and `X-CAIL-Identity-JWT` values before sending a request. The
bridge remains the authorization boundary. It verifies the session audience or
the delegated key's application binding, then binds the subject, app, lease,
session, operation ID, and capabilities. Production accepts CAIL session JWTs
and application-bound delegated keys. Ordinary personal keys are ineligible
during the bounded pilot.

Treat `baseUrl` and a custom `fetchImpl` as trusted server configuration. The
client accepts HTTPS origins and plain HTTP only for the exact loopback hosts
`localhost`, `127.0.0.1`, and `::1`. It rejects URL userinfo and any query or
fragment. It sends the CAIL credential to that configured origin and optional
path prefix, so never derive `baseUrl` from a request or other user input.
Requests use `redirect: "manual"` and reject redirect responses. A custom
`fetchImpl` must preserve that behavior. It must also keep the protected
headers confidential and unchanged.

The public client surface excludes PTY, mounts, persistence, hydration,
backup/restore, tunnels, ports, pools, arbitrary images or resources,
keep-alive, and background processes. Workspace continuity has no client route
because the bridge handles it internally.

Commands run as root inside their disposable sandbox and currently have public
internet access. No CAIL or provider credential is injected into the
container.

File paths are slash-preserving and workspace-relative. The client rejects
empty or absolute paths and every literal `..` segment, then percent-encodes
the remaining segments. The bridge performs the authoritative repeated-decode,
NUL, absolute, and traversal checks. Paths and sandbox IDs are never
authorization credentials. Root code in a sandbox can still create symlinks or
modify any sandbox-local file.

## Request and failure behavior

Every lifecycle, file, OpenAPI, and exec call accepts a Web-standard
`AbortSignal`. Set `defaultTimeoutMs` on the client to give every call a
process-wide upper bound. A per-call signal is composed with that default, so
the first deadline or caller cancellation wins. If no default is configured,
callers must supply a deadline for every request, including cleanup. Retain the
signal while consuming a raw file body or command stream because those bodies
remain connected to the request.

The client performs no automatic retries. `create()` and `createSession()`
require caller-owned idempotency keys. An abort or transport failure can still
leave the remote outcome unknown. Do not retry `exec()`, a file write, or
another state-changing call after an ambiguous failure unless the bridge
contract for that operation proves the retry safe. Destroy calls are designed
to be idempotent. They need a fresh deadline and a verified result.

Non-2xx CAIL responses become `CailSandboxError` instances with the nested
`error.code`, `error.type`, `error.param`, `error.message`, and `error.cail`
fields only when the envelope exactly matches the OpenAPI schema. A malformed
or extended envelope fails closed as `unknown_error`. Response-derived errors
also carry the canonical `X-CAIL-Request-Id` and parsed `x-should-retry` value
when present. The legacy `x-request-id` alias is accepted only when it is absent
or equal to the canonical value; conflicting values are an `invalid_response`.
Unexpected success statuses, malformed success bodies, redirects, and command
stream failures retain the same response metadata. Local validation errors
occur before fetch. Fetch failures and deliberate aborts remain runtime errors.
A mid-stream transport failure becomes `stream_transport_error` with the
original error in `cause`; the remote command outcome may be ambiguous.

Command output uses `eventsource-parser` for WHATWG SSE framing, including CRLF
and split chunks, with a 2 MiB parser buffer. `stdout` and `stderr` payloads are
base64-decoded and limited to 1 MiB per event. Unknown or malformed events are
rejected. An EOF before a terminal event is rejected. The first valid `exit` or
`error` event is withheld until transport EOF proves that the wire contained
exactly one terminal event and no later output. Duplicate terminal events and
output after a terminal event are rejected. The generator then yields the
terminal event, so callers must inspect and handle terminal `error` events.
Breaking out of iteration cancels the underlying response stream.

`readFile()` returns the original `Response` without buffering, leaving the
caller responsible for consuming or canceling its body. `writeFile()` sends
`application/octet-stream` and succeeds only after the bridge returns an
`{ "ok": true }` acknowledgement.

Sandbox usage is measured by the bridge for administrative accounting. The
client exposes no cumulative Sandbox quota, spend cap, or remaining balance.
Capacity, lifecycle, attribution, and measurement-integrity controls can still
deny work through typed errors.

## Usage

```ts
import { createCailSandboxClient } from "@cuny-ai-lab/cail-sandbox-client";

// Backend/controller example. Never save this JWT or the returned capabilities
// in workspace files, command environments, browser state, or logs.
const sandbox = createCailSandboxClient({
  baseUrl: "https://api.example.edu",
  app: "kale-workbench",
  defaultTimeoutMs: 190_000,
});
const credential = { kind: "jwt" as const, token: identityJwt };
const box = await sandbox.create(
  { scopeKey: conversationScopeKey, idempotencyKey: crypto.randomUUID() },
  credential,
  { signal: AbortSignal.timeout(30_000) },
);
const operation = await sandbox.createSession(
  box,
  { operationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
  credential,
  { signal: AbortSignal.timeout(30_000) },
);

let commandError: unknown;
try {
  await sandbox.writeFile(
    box,
    operation,
    "main.py",
    new Blob(["print('hello')"]),
    credential,
    { signal: AbortSignal.timeout(30_000) },
  );

  // Application callback: stream bytes to the authorized caller without
  // writing command content to operational logs.
  for await (const event of await sandbox.exec(
    box,
    operation,
    "python main.py",
    credential,
    { signal: AbortSignal.timeout(190_000) },
  )) {
    if (event.type === "stdout") {
      await sendOutputToAuthorizedCaller("stdout", event.data);
    } else if (event.type === "stderr") {
      await sendOutputToAuthorizedCaller("stderr", event.data);
    } else if (event.type === "error") {
      throw new Error(`${event.code}: ${event.message}`);
    } else if (event.exitCode !== 0) {
      throw new Error(`Command exited with status ${event.exitCode}`);
    }
  }
} catch (error) {
  commandError = error;
}

let cleanupError: unknown;
try {
  await sandbox.destroySession(box, operation, credential, {
    signal: AbortSignal.timeout(30_000),
  });
} catch (error) {
  cleanupError = error;
}
if (commandError || cleanupError) {
  throw new AggregateError(
    [commandError, cleanupError].filter((error) => error !== undefined),
    "Sandbox command or cleanup failed",
  );
}

// Keep `box` for the next command in this conversation. Destroy it on reset.
```

The `scopeKey` and every idempotency key or operation ID must be an opaque value
of 32 to 256 characters using letters, digits, `.`, `_`, `~`, or `-`. Do not
place an email address, prompt, filename, or other user content in these values.
UUIDs satisfy the format and are suitable when the caller does not need a
stable scope.

At a server request boundary, adopt correlation once and pass it to each
sandbox operation:

```ts
import { correlationFromHeaders } from "@cuny-ai-lab/cail-sandbox-client";

const correlation = correlationFromHeaders(request);
const box = await sandbox.create(
  { scopeKey: conversationScopeKey, idempotencyKey: createAttemptKey },
  credential,
  { correlation, signal: AbortSignal.timeout(30_000) },
);
const operation = await sandbox.createSession(
  box,
  { operationId, idempotencyKey: operationAttemptKey },
  credential,
  { correlation, signal: AbortSignal.timeout(30_000) },
);
for await (const event of await sandbox.exec(
  box,
  operation,
  "python main.py",
  credential,
  { correlation, signal: AbortSignal.timeout(190_000) },
)) {
  if (event.type === "error") {
    throw new Error(`${event.code}: ${event.message}`);
  }
}
```

The package pins reviewed `@cuny-ai-lab/cail-log` commit
`75e0dda3068794ae1543e1e2bb98c9c920bb848f` for correlation formatting and
validation. Individual client methods allow correlation to be omitted.
Application request boundaries should adopt it once and reuse it across
related calls. Correlation adoption recognizes only a lowercase UUID v4 in
`X-CAIL-Request-Id`; the `x-request-id` alias is not an inbound correlation
source. The client consumes and re-exports only this correlation sub-contract.
It does not construct log events or expose cail-log schema-version,
versioned-subject, logger-provenance, sink, or projection APIs.

## Contract, package, and checks

The repository includes the reviewed gateway OpenAPI 3.1.1 artifact at
`contract/sandbox-openapi.json`. Its current SHA-256 is
`47a662a0073405e727a8dd17e70ed23e78f6eb6819551624934f4d9e8c99f784`.
Tests pin the digest, operation inventory, explicit-session routes, raw-file
methods, authentication description, and shared error headers. The package
exports the exact artifact at
`@cuny-ai-lab/cail-sandbox-client/contract/sandbox-openapi.json`; consumers
import the typed client from the package root.

`bun run check:gateway-contract` compares the artifact byte-for-byte with the
canonical gateway source when a sibling checkout is present. Set
`CAIL_GATEWAY_OPENAPI` to compare another local file. An explicitly configured
missing file fails closed. Without an explicit path or sibling gateway
checkout, the local command verifies the pinned digest; CI always checks out
the canonical gateway and requires byte-for-byte parity. Because the gateway
repository is private, CI fails closed unless the repository Actions secret
`CAIL_GATEWAY_READ_TOKEN` grants `contents:read` access to
`CUNY-AI-Lab/cail-gateway`. Do not give this token write or administration
permissions.

Build output is committed under `dist/` so the package root resolves to built
JavaScript and declarations. The package's `prepare` hook runs
`bun run build` during the relevant Git-install or packing lifecycle. A
consumer therefore must not assume that installation skips the build merely
because `dist/` is committed.

Run the full local gate before pinning a revision:

```sh
bun run check
bun pm pack --dry-run
```

`bun run check` verifies the available gateway contract, types, unit and
contract tests, and the build. The checked-in CI workflow installs from the
frozen Bun lockfile, compares the canonical gateway contract, runs the full
check, rejects committed `dist/` drift, dry-runs package creation, and scans the
repository history for secrets. The live and local continuity scripts remain
separate because they create external or Docker resources.

Install a reviewed revision by its immutable full Git commit SHA:

```sh
bun add github:CUNY-AI-Lab/cail-sandbox-client#<full-40-character-commit-sha>
```

Do not pin `main` or a shortened SHA in a consumer lockfile. This repository
does not currently publish semantic release tags.

## Deployment and E2E boundaries

The matching observation-only bridge and this client are implemented in the
reviewed checkouts. This repository does not establish which Worker revision,
bindings, limits, or secrets are active in an institutional environment. Before
production use, obtain deployment authorization and verify live state through
the gateway deployment records and runbook; package tests and disposable E2E
runs do not provide either one.

The production entrypoint uses the CAIL identity verifier and a direct
key-service binding for application-bound delegated keys. The separate
personal-account E2E entrypoint retains its PoC bearer and caller-supplied
synthetic subject solely for destructive tests and cannot serve as a production
ingress.

An isolated personal-account deployment can run the destructive live contract
check with throwaway credentials:

```sh
CAIL_SANDBOX_E2E_BASE_URL=https://... \
CAIL_SANDBOX_E2E_AUTH_SECRET=... \
bun run test:live
```

The script is locked to the personal-account E2E Worker hostname. It uses
synthetic subjects and checks IDOR denial, exact OpenAPI equality, binary files,
traversal defense, root and package execution, public internet access, raw SSE,
command deadlines, output limits, idempotent destruction, and retired create
attempts. Client calls have a five-minute ceiling, readiness and idle polls use
shorter abort signals, raw requests are time-bounded, and cleanup retries abort
their underlying requests. A failed or interrupted cleanup still requires
manual verification of run-owned resources.

With a sibling `cail-gateway` checkout, the deployment-free continuity proof
starts the bridge under `wrangler dev --local`, creates local Durable Object/R2
state and official Sandbox containers, waits for idle snapshot and stop, then
checks that a new physical incarnation restores exact binary and
dependency-shaped workspace state:

```sh
bun run test:local:continuity
```

The harness generates its PoC bearer and capability secret in memory, strips
matching Cloudflare, R2, AWS, and CAIL credential variables from Wrangler's
child environment, binds to loopback, and attempts to restore the pre-run
Docker inventory. It may pull images and create containers. Its cleanup timeout
aborts the underlying client request. If cleanup times out or the process is
interrupted, inspect the named local Worker, Wrangler state, containers, and
images before rerunning.

Set `CAIL_GATEWAY_SANDBOX_DIR` only when the gateway is not in the default
sibling checkout location. The script accepts a configurable loopback port
through `CAIL_SANDBOX_LOCAL_E2E_PORT`.

The production-only continuity proof is locked to the disposable
personal-account Worker and must run only with its dedicated R2 bucket and
short-lived bucket-scoped credentials:

```sh
CAIL_SANDBOX_CONTINUITY_E2E_BASE_URL=https://cail-sandbox-bridge-continuity-e2e.veritas44.workers.dev/ \
CAIL_SANDBOX_E2E_AUTH_SECRET=... \
bun run test:live:continuity
```

It requires a new physical incarnation, exact restored bytes, a writable FUSE
overlay, and idempotent cleanup. Readiness and idle polls use short abort
signals, every client call has a five-minute ceiling, and cleanup deadlines
abort their underlying requests. Operators must remove the Worker, container
application, image, R2 bucket, Worker secrets, and temporary R2 credentials
even when the client assertion or cleanup wait fails.
