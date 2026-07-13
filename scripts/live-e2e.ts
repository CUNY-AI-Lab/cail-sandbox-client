import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  CailSandboxError,
  createCailSandboxClient,
  type CailSandboxCredential,
  type CommandTerminalEvent,
  type FetchLike,
  type SandboxLease,
  type SandboxOperation,
} from "../dist/index.js";

const baseUrl = process.env.CAIL_SANDBOX_E2E_BASE_URL;
const token = process.env.CAIL_SANDBOX_E2E_AUTH_SECRET;
if (!baseUrl || !token) {
  throw new Error(
    "CAIL_SANDBOX_E2E_BASE_URL and CAIL_SANDBOX_E2E_AUTH_SECRET are required",
  );
}
const parsedBaseUrl = new URL(baseUrl);
assert.equal(parsedBaseUrl.protocol, "https:");
assert.equal(parsedBaseUrl.port, "");
assert.equal(
  parsedBaseUrl.hostname,
  "cail-sandbox-bridge-e2e.veritas44.workers.dev",
  "live E2E is locked to the personal-account staging Worker",
);
assert.equal(parsedBaseUrl.pathname, "/");
assert.equal(parsedBaseUrl.search, "");
assert.equal(parsedBaseUrl.hash, "");
assert.equal(parsedBaseUrl.username, "");
assert.equal(parsedBaseUrl.password, "");

const alice = `cail-${"a".repeat(32)}`;
const bob = `cail-${"b".repeat(32)}`;
const app = "sandbox-e2e";
const credential: CailSandboxCredential = { kind: "key", token };
const fetchFor = (subject: string): FetchLike => async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("x-cail-poc-subject", subject);
  return fetch(input, { ...init, headers });
};
const clientFor = (subject: string, clientApp = app) =>
  createCailSandboxClient({
    baseUrl,
    app: clientApp,
    fetchImpl: fetchFor(subject),
  });

const client = clientFor(alice);
const control = () => crypto.randomUUID();
const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
let lease: SandboxLease | undefined;
const operations: SandboxOperation[] = [];

async function expectCailError(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  try {
    await promise;
    assert.fail(`expected ${status} ${code}`);
  } catch (error) {
    assert(error instanceof CailSandboxError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
  }
}

async function runCommand(
  activeOperation: SandboxOperation,
  command: string,
) {
  let output = "";
  let terminal: CommandTerminalEvent | undefined;
  for await (const event of await client.exec(
    lease!,
    activeOperation,
    command,
    credential,
  )) {
    if (event.type === "stdout" || event.type === "stderr") {
      if (output.length < 8_192) {
        output += new TextDecoder().decode(event.data);
      }
    } else if (event.type === "exit" || event.type === "error") {
      assert.equal(terminal, undefined, "command emitted multiple terminal events");
      terminal = event;
    }
  }
  assert(terminal, "command emitted no terminal event");
  return { output, terminal };
}

async function runRawCommand(
  activeOperation: SandboxOperation,
  command: string,
) {
  const response = await fetch(
    `${baseUrl}/sandbox/v1/sandbox/${lease!.id}/exec`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-cail-app": app,
        "x-cail-poc-subject": alice,
        "x-cail-sandbox-lease": lease!.leaseCapability,
        "x-cail-session-id": activeOperation.id,
        "x-cail-operation-id": activeOperation.operationId,
        "x-cail-operation-capability": activeOperation.operationCapability,
      },
      body: JSON.stringify({ command, session_id: activeOperation.id }),
      redirect: "error",
    },
  );
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.equal(
    wire.match(/^event: (?:exit|error)$/gm)?.length,
    1,
    "raw SSE must contain exactly one terminal event",
  );
}

async function destroyOperation(activeOperation: SandboxOperation) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.destroySession(lease!, activeOperation, credential);
      return;
    } catch (error) {
      if (error instanceof CailSandboxError && error.status === 404) return;
      if (attempt === 2) throw error;
    }
  }
}

async function waitForIdleSleep(idleStartedAt: number, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.running(lease!, credential);
    if (!status.running) {
      assert(
        Date.now() - idleStartedAt >= 50_000,
        "sandbox stopped materially before its configured 60-second idle window",
      );
      return status;
    }
    await delay(5_000);
  }
  assert.fail("sandbox did not sleep within the live E2E deadline");
}

async function waitForHealthy(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { redirect: "error" });
      lastStatus = response.status;
      if (response.status === 200) {
        assert.deepEqual(await response.json(), {
          status: "healthy",
          service: "cail-sandbox-bridge",
        });
        return;
      }
    } catch {
      lastStatus = 0;
    }
    await delay(2_000);
  }
  assert.fail(`sandbox E2E Worker did not become healthy; last status ${lastStatus}`);
}

async function waitForAuthenticatedOpenapi(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      return await client.openapi(credential);
    } catch (error) {
      if (
        !(error instanceof CailSandboxError) ||
        (error.status !== 401 && error.status !== 404)
      ) {
        throw error;
      }
      lastStatus = error.status;
    }
    await delay(2_000);
  }
  assert.fail(
    `sandbox E2E authenticated contract did not become ready; last status ${lastStatus}`,
  );
}

async function cleanup() {
  if (!lease) return;
  const errors: unknown[] = [];
  for (const activeOperation of [...operations].reverse()) {
    try {
      await destroyOperation(activeOperation);
    } catch (error) {
      errors.push(error);
    }
  }
  operations.length = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.destroy(lease, credential);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    errors.push(lastError);
  } else {
    try {
      await expectCailError(client.running(lease, credential), 404, "not_found");
      lease = undefined;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "CAIL sandbox live cleanup failed");
  }
}

let primaryError: unknown;
try {
  await waitForHealthy();

  const unauthorized = await fetch(`${baseUrl}/sandbox/v1/openapi.json`, {
    headers: {
      authorization: "Bearer invalid-e2e-credential-value",
      "x-cail-app": app,
      "x-cail-poc-subject": alice,
    },
    redirect: "error",
  });
  assert.equal(unauthorized.status, 401);

  const openapi = await waitForAuthenticatedOpenapi();
  const reviewedOpenapi = JSON.parse(
    readFileSync(new URL("../contract/sandbox-openapi.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(openapi, reviewedOpenapi);

  const createInput = { scopeKey: control(), idempotencyKey: control() };
  const created = await client.create(createInput, credential);
  lease = created;
  const replayed = await client.create(createInput, credential);
  assert.equal(replayed.id, lease.id);
  assert.equal(replayed.leaseCapability, lease.leaseCapability);

  const running = await client.running(lease, credential);
  assert.equal(running.running, true);
  assert(
    running.incarnation === null || running.incarnation.length > 0,
    "running sandbox returned an invalid container incarnation",
  );

  await expectCailError(
    clientFor(bob).running(lease, credential),
    404,
    "not_found",
  );
  await expectCailError(
    clientFor(alice, "other-e2e-app").running(lease, credential),
    404,
    "not_found",
  );

  const operation = await client.createSession(
    lease,
    { operationId: control(), idempotencyKey: control() },
    credential,
  );
  operations.push(operation);
  const binary = new Uint8Array([0, 255, 1, 2, 3]);
  await client.writeFile(
    lease,
    operation,
    "nested/data.bin",
    binary,
    credential,
  );
  const placed = await client.running(lease, credential);
  assert.equal(placed.running, true);
  assert(placed.incarnation, "placed sandbox omitted container incarnation");

  const traversal = await fetch(
    `${baseUrl}/sandbox/v1/sandbox/${lease.id}/file/%252e%252e%252fetc%252fpasswd`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "x-cail-app": app,
        "x-cail-poc-subject": alice,
        "x-cail-sandbox-lease": lease.leaseCapability,
        "x-cail-session-id": operation.id,
        "x-cail-operation-id": operation.operationId,
        "x-cail-operation-capability": operation.operationCapability,
      },
      redirect: "error",
    },
  );
  assert.equal(traversal.status, 400);
  assert.equal((await traversal.json() as { error: { code: string } }).error.code, "invalid_path");

  const happy = await runCommand(
    operation,
    "set -eu; printf 'uid='; id -u; apt-get -qq install -y curl >/dev/null; echo apt=ok; printf 'net='; curl -fsS --max-time 3 https://registry.npmjs.org/-/ping",
  );
  assert.deepEqual(
    happy.terminal,
    { type: "exit", exitCode: 0 },
    `root/package/egress probe failed; output=${JSON.stringify(happy.output)}`,
  );
  assert.match(happy.output, /uid=0/);
  assert.match(happy.output, /apt=ok/);
  assert.match(happy.output, /net=/);
  await client.running(lease, credential);
  const read = await client.readFile(
    lease,
    operation,
    "nested/data.bin",
    credential,
  );
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), binary);
  await destroyOperation(operation);
  operations.splice(operations.indexOf(operation), 1);

  const rawOperation = await client.createSession(
    lease,
    { operationId: control(), idempotencyKey: control() },
    credential,
  );
  operations.push(rawOperation);
  await runRawCommand(rawOperation, "true");
  await destroyOperation(rawOperation);
  operations.splice(operations.indexOf(rawOperation), 1);

  const beforeIdle = await client.running(lease, credential);
  assert.equal(beforeIdle.running, true, "sandbox was not running before idle wait");
  const slept = await waitForIdleSleep(Date.now());
  assert.equal(
    slept.incarnation,
    placed.incarnation,
    "stopped sandbox lost its last observed incarnation",
  );
  const wakeOperation = await client.createSession(
    lease,
    { operationId: control(), idempotencyKey: control() },
    credential,
  );
  operations.push(wakeOperation);
  const coldWorkspace = await runCommand(
    wakeOperation,
    "test ! -e /workspace/nested/data.bin",
  );
  assert.deepEqual(coldWorkspace.terminal, { type: "exit", exitCode: 0 });
  const restarted = await client.running(lease, credential);
  assert.equal(restarted.running, true);
  assert(restarted.incarnation, "restarted sandbox omitted container incarnation");
  assert.notEqual(
    restarted.incarnation,
    placed.incarnation,
    "idle wake reused the previous container incarnation",
  );
  await destroyOperation(wakeOperation);
  operations.splice(operations.indexOf(wakeOperation), 1);

  const timeoutOperation = await client.createSession(
    lease,
    { operationId: control(), idempotencyKey: control() },
    credential,
  );
  operations.push(timeoutOperation);
  const timedOut = await runCommand(timeoutOperation, "sleep 30");
  assert.equal(timedOut.terminal.type, "error");
  if (timedOut.terminal.type === "error") {
    assert.equal(timedOut.terminal.code, "command_timeout");
  }

  const outputOperation = await client.createSession(
    lease,
    { operationId: control(), idempotencyKey: control() },
    credential,
  );
  operations.push(outputOperation);
  const overflow = await runCommand(
    outputOperation,
    "yes x | head -c 8192; yes y | head -c 8192 >&2",
  );
  assert.equal(overflow.terminal.type, "error");
  if (overflow.terminal.type === "error") {
    assert.equal(overflow.terminal.code, "output_limit_exceeded");
  }

  await client.destroy(lease, credential);
  await client.destroy(lease, credential);
  await expectCailError(client.running(lease, credential), 404, "not_found");
  await expectCailError(
    client.create(createInput, credential),
    409,
    "create_attempt_retired",
  );
  lease = undefined;
} catch (error) {
  primaryError = error;
}

let cleanupError: unknown;
try {
  await cleanup();
} catch (error) {
  cleanupError = error;
}
if (primaryError || cleanupError) {
  throw new AggregateError(
    [primaryError, cleanupError].filter((error) => error !== undefined),
    "CAIL sandbox live E2E failed",
  );
}
console.log("CAIL sandbox live E2E: all assertions passed");
