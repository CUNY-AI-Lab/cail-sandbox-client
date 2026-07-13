# @cuny-ai-lab/cail-sandbox-client

A small Web-standard client for CAIL-governed remote execution. It is separate
from `@cuny-ai-lab/cail-client`: sandbox lifecycle, raw files, command SSE, and
execution scopes are not model-inference semantics.

The server contract currently targets the gateway's matching Cloudflare
Sandbox SDK and image `0.12.3`, RPC transport, and explicit sessions. This
client deliberately does not depend on the Cloudflare SDK; it speaks only the
bounded `/sandbox/v1/*` HTTP contract.

The client owns `X-CAIL-App` and exactly one CAIL credential, returns raw file
`Response` objects without buffering, decodes base64 command output, requires
exactly one terminal SSE event, and exposes nested CAIL errors as
`CailSandboxError`. It uses `@cuny-ai-lab/cail-log` 1.0.0 for optional
per-call `traceparent` and `X-CAIL-Request-Id` forwarding. Every lifecycle,
file, OpenAPI, and exec call accepts a Web-standard `AbortSignal`; typed errors retain
the response's `x-request-id` and `x-should-retry` values. WHATWG event-stream framing is delegated to the maintained
`eventsource-parser` package, including CRLF/chunk handling and a bounded parser
buffer. It contains no Cloudflare SDK and no durable credential.
Unknown event names are rejected. The first valid terminal event completes the
iterator and cancels the transport. Callers should pass an `AbortSignal` for
their own deadline. Use `onQuota` for admission-time quota headers and call
`running()` after a command for a fresh remaining-budget reading.

```ts
import { createCailSandboxClient } from "@cuny-ai-lab/cail-sandbox-client";

// Kale-shaped server/controller example: pass the verified user's short-lived
// session JWT at call time. Never save it in workspace files or command env.
const sandbox = createCailSandboxClient({
  baseUrl: "https://api.example.edu",
  app: "kale-workbench",
});
const credential = { kind: "jwt" as const, token: identityJwt };
const box = await sandbox.create(
  { scopeKey: conversationScopeKey, idempotencyKey: crypto.randomUUID() },
  credential,
);
const operation = await sandbox.createSession(
  box,
  { operationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
  credential,
);
await sandbox.writeFile(
  box,
  operation,
  "main.py",
  new Blob(["print('hello')"]),
  credential,
);
for await (const event of await sandbox.exec(
  box,
  operation,
  "python main.py",
  credential,
)) {
  if (event.type === "stdout") console.log(new TextDecoder().decode(event.data));
  if (event.type === "error") throw new Error(event.message);
}
await sandbox.destroySession(box, operation, credential);
// Keep `box` for the next command in this conversation. Destroy it on reset.
```

At a server request boundary, adopt correlation once and pass it to each
sandbox operation:

```ts
import { correlationFromHeaders } from "@cuny-ai-lab/cail-sandbox-client";

const correlation = correlationFromHeaders(request);
const box = await sandbox.create(
  { scopeKey: conversationScopeKey, idempotencyKey: createAttemptKey },
  credential,
  { correlation },
);
const operation = await sandbox.createSession(
  box,
  { operationId, idempotencyKey: operationAttemptKey },
  credential,
  { correlation },
);
await sandbox.exec(box, operation, "python main.py", credential, {
  correlation,
});
```

The package ships the reviewed gateway OpenAPI 3.1.1 artifact under
`contract/`. Tests pin its SHA-256, exact operation inventory, explicit-session
routes, raw-file methods, and shared error headers. Build output is committed so
Git dependencies resolve without running a package build.

Install a reviewed revision by its immutable full Git commit SHA:

```sh
bun add github:CUNY-AI-Lab/cail-sandbox-client#<full-40-character-commit-sha>
```

Do not pin `main` or a shortened SHA in a consumer lockfile. This repository
does not currently publish semantic release tags.

The client, wire contract, and production authentication boundary are tested;
the institutional bridge is not deployed. The production entrypoint verifies
CAIL session JWTs and resolves application-bound delegated keys through a
key-service binding. Ordinary personal keys are ineligible during the bounded
pilot. Durable ownership, expiry alarms, egress posture, metering, and
container termination still need live Cloudflare verification. The separate
personal-account E2E entrypoint retains its PoC bearer solely for destructive
tests and is not a production ingress.

An isolated personal-account deployment can run the destructive live contract
check with throwaway credentials:

```sh
CAIL_SANDBOX_E2E_BASE_URL=https://... \
CAIL_SANDBOX_E2E_AUTH_SECRET=... \
bun run test:live
```

The script is locked to the personal-account E2E Worker hostname. It uses
synthetic subjects and proves IDOR denial, complete OpenAPI equality, raw nested
files, root/package-manager/public-internet access, raw terminal-event count,
typed timeout/output terminal errors, idempotent cleanup, and retired
create-attempt replay. Cleanup retries and verifies the lease is no longer
addressable; the credential is never printed.

With a sibling `cail-gateway` checkout, the deployment-free continuity proof
starts the real bridge under `wrangler dev --local`, creates only local Durable
Object/R2 state and an official Sandbox container, waits for idle snapshot and
stop, then proves a new physical incarnation restores exact binary and
dependency-shaped workspace state:

```sh
bun run test:local:continuity
```

The harness generates its PoC bearer and capability secret in memory, strips
Cloudflare credentials from Wrangler's child environment, binds to loopback,
and removes its local Wrangler state, container, and image. Set
`CAIL_GATEWAY_SANDBOX_DIR` only when the gateway is not in the default sibling
checkout location. Cleanup is deadline-bounded, restores the pre-run Docker
inventory, and fails the test if it cannot prove removal. Local restore uses
Cloudflare's documented directory-replacement path; production still needs one
disposable copy-on-write proof.

The production-only continuity proof is deliberately locked to the disposable
personal-account Worker and must run only with its dedicated R2 bucket and
short-lived bucket-scoped credentials:

```sh
CAIL_SANDBOX_CONTINUITY_E2E_BASE_URL=https://cail-sandbox-bridge-continuity-e2e.veritas44.workers.dev/ \
CAIL_SANDBOX_E2E_AUTH_SECRET=... \
bun run test:live:continuity
```

It requires a new physical incarnation, exact restored bytes, a writable FUSE
overlay, and idempotent cleanup. The surrounding deployment procedure must
remove the Worker, container application, image, R2 bucket, Worker secrets, and
temporary R2 credentials even when the client assertion fails.
