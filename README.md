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
per-call `traceparent` and `X-CAIL-Request-Id` forwarding; typed errors retain
the response's `x-request-id` and `x-should-retry` values. WHATWG event-stream framing is delegated to the maintained
`eventsource-parser` package, including CRLF/chunk handling and a bounded parser
buffer. It contains no Cloudflare SDK and no durable credential.
Unknown event names are rejected. The iterator reads through stream closure to
enforce exactly one terminal event; callers should pass an `AbortSignal` for
their own deadline, and stopping iteration cancels the underlying response.

```ts
import { createCailSandboxClient } from "@cuny-ai-lab/cail-sandbox-client";

// Kale-shaped server/controller example: pass the verified user's short-lived
// session JWT at call time. Never save it in workspace files or command env.
const sandbox = createCailSandboxClient({
  baseUrl: "https://api.example.edu",
  app: "kale-workbench",
});
const credential = { kind: "jwt" as const, token: identityJwt };
const box = await sandbox.create(credential);
await sandbox.writeFile(box.id, "main.py", new Blob(["print('hello')"]), credential);
for await (const event of await sandbox.exec(box.id, "python main.py", credential)) {
  if (event.type === "stdout") console.log(new TextDecoder().decode(event.data));
  if (event.type === "error") throw new Error(event.message);
}
await sandbox.destroy(box.id, credential);
```

At a server request boundary, adopt correlation once and pass it to each
sandbox operation:

```ts
import { correlationFromHeaders } from "@cuny-ai-lab/cail-sandbox-client";

const correlation = correlationFromHeaders(request);
const box = await sandbox.create(credential, { correlation });
const session = await sandbox.createSession(box.id, credential, { correlation });
await sandbox.exec(box.id, "python main.py", credential, {
  sessionId: session.id,
  correlation,
});
```

The package ships the reviewed gateway OpenAPI 3.1.1 artifact under
`contract/`. Tests pin its SHA-256, exact operation inventory, explicit-session
routes, raw-file methods, and shared error headers. Build output is committed so
Git dependencies resolve without running a package build.

This repository is still a local PoC. The client and wire contract are tested;
the bridge is not deployed, and production authentication, durable ownership,
live Cloudflare Sandbox behavior, egress policy, billing, and cleanup remain
live-pilot work.
