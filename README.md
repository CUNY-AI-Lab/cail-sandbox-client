# @cuny-ai-lab/cail-sandbox-client

A backend-only Fetch client for the CAIL Sandbox service. It wraps the reviewed
`/sandbox/v1` lifecycle, session, file, command-stream, and usage surface
without exposing Cloudflare SDK types.

The canonical service contract is
`cail-sandbox-service` commit
`2fac839481aa38710ac45596c3e56227a85c02b7`. This repository vendors its
OpenAPI document byte-for-byte at `contract/sandbox-openapi.json`, SHA-256
`07f5ba6973b84dec313c22dcfd6877ce58ba909ab96af2ccc3e5e3ea82bd0c26`.

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

The package depends on the exact published CAIL Log `0.6.0` version and lockfile
artifact. The reviewed Log tarball is 50,269 bytes with SHA-256
`8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215`.
The source checkout's `evidence/registry-publications.json` records immutable
receipts observed during release review; it is not shipped in this package and
does not assert the current availability of any package version.

Run `bun run check:release-authority` before packaging. It rejects version,
lockfile, receipt, installed-package, or tarball drift. Each publication also
requires an ordinary clean Git checkout and a live GitHub Packages preflight
against the release authority recorded by the source checkout. The release
workflow resolves the remote GitHub tag (including bounded annotated tags),
requires the exact `v<package.version>` ref, and checks that its commit equals
both `GITHUB_SHA` and the live default-branch head; it does not trust only a
local or shallow checkout. The workflow uses a temporary worktree `.npmrc` for
the private dependency install, removes it on every exit, and authenticates
`bun publish` through its documented `NPM_CONFIG_TOKEN` environment variable;
no credential file remains in the publication checkout. Publishing requires a
separately reviewed release tag matching the package version.

The `repository` field points to this GitHub repository so GitHub Packages can
associate the npm package with its source. The private CI job requests only
`contents: read` and `packages: read`, while the required guard requests
`contents: read` without package access. The publish workflow requests
`contents: read` and `packages: write`, with no delete or admin permission. The
the package's GitHub-side Manage Actions access or inherited-permissions setting
and deleted-version history are external state and must still be confirmed in
package settings before publication. The workflow deliberately does not
request package-delete permission. A deleted or reusable `0.1.1` version is an
immutable-authority stop condition.

CI's required `verify` job is an unconditional, package-free guard: it checks
the package shape and scans the checkout and history for secrets without
requesting package credentials. This guard runs for every push and pull
request, including forks and automation, so a skipped private job cannot
satisfy the required check. The package-free `CI` workflow contains no
package-read job. The separate `CI Private` workflow has a push-main job and a
same-repository pull-request job. The latter uses `pull_request_target` so its
workflow file comes from the base repository's default branch. It checks the
head repository and requires both the webhook author and event sender to be
GitHub user accounts before checking out the exact PR head SHA and installing
the private CAIL Log dependency. Fork, Dependabot, Renovate, and other pull
requests whose webhook actors are bots or unknown automation therefore receive
the safe guard but not the private-dependency integration checks; full fork
integration needs a separate dependency-visibility or isolation design.
The branch-protection setting that requires `CI / verify` is external state and
must be confirmed separately.

This client creates no Cloudflare resources and contains no deployment command.
Isolated service deployment and end-to-end resource cleanup belong to the
Sandbox and integration workstreams.
