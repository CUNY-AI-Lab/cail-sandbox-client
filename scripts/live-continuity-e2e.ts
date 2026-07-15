import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import {
  CailSandboxError,
  createCailSandboxClient,
  type CailSandboxCredential,
  type CommandTerminalEvent,
  type FetchLike,
  type SandboxLease,
  type SandboxOperation,
} from "../dist/index.js";
import { withAbortDeadline } from "./abort-deadline.js";

const baseUrlInput = process.env.CAIL_SANDBOX_CONTINUITY_E2E_BASE_URL;
const token = process.env.CAIL_SANDBOX_E2E_AUTH_SECRET;
if (!baseUrlInput || !token) {
  throw new Error(
    "CAIL_SANDBOX_CONTINUITY_E2E_BASE_URL and CAIL_SANDBOX_E2E_AUTH_SECRET are required",
  );
}
const parsedBaseUrl = new URL(baseUrlInput);
assert.equal(parsedBaseUrl.protocol, "https:");
assert.equal(parsedBaseUrl.port, "");
assert.equal(
  parsedBaseUrl.hostname,
  "cail-sandbox-bridge-continuity-e2e.veritas44.workers.dev",
  "continuity E2E is locked to its disposable personal-account Worker",
);
assert.equal(parsedBaseUrl.pathname, "/");
assert.equal(parsedBaseUrl.search, "");
assert.equal(parsedBaseUrl.hash, "");
assert.equal(parsedBaseUrl.username, "");
assert.equal(parsedBaseUrl.password, "");
const baseUrl = parsedBaseUrl.origin;

const subject = `cail-${crypto.randomUUID().replaceAll("-", "")}`;
const app = "sandbox-continuity-e2e";
const credential: CailSandboxCredential = { kind: "key", token };
const control = () => crypto.randomUUID();
const delay = (milliseconds: number) => Bun.sleep(milliseconds);
const fetchForSubject: FetchLike = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("x-cail-poc-subject", subject);
  return fetch(input, { ...init, headers });
};
const client = createCailSandboxClient({
  baseUrl,
  app,
  fetchImpl: fetchForSubject,
  defaultTimeoutMs: 300_000,
});

async function waitForHealthy(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 200) return;
    } catch {
      // The disposable Worker or its route is still propagating.
    }
    await delay(2_000);
  }
  assert.fail("continuity E2E Worker did not become healthy");
}

async function waitForContract(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await client.openapi(credential, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (
        !(error instanceof CailSandboxError) ||
        (error.status !== 401 && error.status !== 404)
      ) {
        throw error;
      }
    }
    await delay(2_000);
  }
  assert.fail("continuity E2E authenticated contract did not become ready");
}

async function runCommand(
  lease: SandboxLease,
  operation: SandboxOperation,
  command: string,
) {
  let output = "";
  let terminal: CommandTerminalEvent | undefined;
  for await (const event of await client.exec(
    lease,
    operation,
    command,
    credential,
  )) {
    if ("data" in event) output += new TextDecoder().decode(event.data);
    else terminal = event;
  }
  assert.deepEqual(terminal, { type: "exit", exitCode: 0 }, output);
  return output;
}

async function waitForIdleStop(lease: SandboxLease, startedAt: number) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status = await client.running(lease, credential, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!status.running) {
      assert(
        Date.now() - startedAt >= 50_000,
        "sandbox stopped materially before the configured idle window",
      );
      return status;
    }
    await delay(5_000);
  }
  assert.fail("sandbox did not snapshot and stop within the continuity deadline");
}

let lease: SandboxLease | undefined;
let operation: SandboxOperation | undefined;
let primaryError: unknown;
const cleanupErrors: unknown[] = [];
try {
  await waitForHealthy();
  const openapi = await waitForContract();
  const reviewedOpenapi = JSON.parse(
    await readFile(
      new URL("../contract/sandbox-openapi.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(openapi, reviewedOpenapi);

  lease = await client.create(
    { scopeKey: control(), idempotencyKey: control() },
    credential,
  );
  operation = await client.createSession(
    lease,
    { operationId: control(), idempotencyKey: control() },
    credential,
  );
  const binary = new Uint8Array([0, 255, 1, 2, 3, 254]);
  await client.writeFile(
    lease,
    operation,
    "nested/continuity.bin",
    binary,
    credential,
  );
  await runCommand(
    lease,
    operation,
    "set -eu; mkdir -p /workspace/node_modules/live-proof; printf 'lower-state\\n' > /workspace/node_modules/live-proof/state.txt",
  );
  const before = await client.running(lease, credential);
  assert.equal(before.running, true);
  assert(before.incarnation, "initial container omitted its incarnation");
  assert.equal(before.restoredFromIncarnation, null);

  await client.destroySession(lease, operation, credential);
  operation = undefined;
  const stopped = await waitForIdleStop(lease, Date.now());
  assert.equal(stopped.incarnation, before.incarnation);
  assert.equal(stopped.restoredFromIncarnation, null);

  operation = await client.createSession(
    lease,
    { operationId: control(), idempotencyKey: control() },
    credential,
  );
  const restored = await client.running(lease, credential);
  assert.equal(restored.running, true);
  assert(restored.incarnation, "restored container omitted its incarnation");
  assert.notEqual(restored.incarnation, before.incarnation);
  assert.equal(restored.restoredFromIncarnation, before.incarnation);

  const mount = await runCommand(
    lease,
    operation,
    "set -eu; test \"$(cat /workspace/node_modules/live-proof/state.txt)\" = lower-state; test -f /workspace/nested/continuity.bin; printf 'upper-state\\n' > /workspace/node_modules/live-proof/state.txt; test \"$(cat /workspace/node_modules/live-proof/state.txt)\" = upper-state; printf 'upper-only\\n' > /workspace/upper-only.txt; findmnt -T /workspace -n -o FSTYPE,OPTIONS",
  );
  assert.match(
    mount,
    /fuse[^\n]*overlay|overlay[^\n]*fuse/i,
    "restored workspace was not a production FUSE overlay",
  );
  assert.match(mount, /\brw\b/, "restored overlay was not writable");
  const raw = await client.readFile(
    lease,
    operation,
    "nested/continuity.bin",
    credential,
  );
  assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), binary);
  const upper = await client.readFile(
    lease,
    operation,
    "upper-only.txt",
    credential,
  );
  assert.equal(await upper.text(), "upper-only\n");

  await client.destroySession(lease, operation, credential);
  operation = undefined;
  await client.destroy(lease, credential);
  await client.destroy(lease, credential);
  await assert.rejects(
    client.running(lease, credential),
    (error: unknown) =>
      error instanceof CailSandboxError &&
      error.status === 404 &&
      error.code === "not_found",
  );
  lease = undefined;
} catch (error) {
  primaryError = error;
} finally {
  if (lease && operation) {
    try {
      await withAbortDeadline(
        20_000,
        "session cleanup",
        (signal) =>
          client.destroySession(lease!, operation!, credential, { signal }),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (lease) {
    try {
      await withAbortDeadline(30_000, "lease cleanup", (signal) =>
        client.destroy(lease!, credential, { signal }),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}

if (primaryError || cleanupErrors.length > 0) {
  throw new AggregateError(
    [primaryError, ...cleanupErrors].filter((error) => error !== undefined),
    "CAIL sandbox production continuity E2E failed",
  );
}

console.log("CAIL sandbox production continuity E2E: all assertions passed");
