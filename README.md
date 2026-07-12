# @cuny-ai-lab/cail-sandbox-client

A small Web-standard client for CAIL-governed remote execution. It is separate
from `@cuny-ai-lab/cail-client`: sandbox lifecycle, raw files, command SSE, and
execution scopes are not model-inference semantics.

The client owns `X-CAIL-App` and exactly one CAIL credential, returns raw file
`Response` objects without buffering, decodes base64 command output, requires
exactly one terminal SSE event, and exposes nested CAIL errors as
`CailSandboxError`. WHATWG event-stream framing is delegated to the maintained
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

The local contract test checks this reviewed wrapper against the gateway's
validated OpenAPI 3.1.1 artifact and exact operation inventory. A published
package should pin that artifact/hash in both release pipelines.
