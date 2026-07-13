import { strict as assert } from "node:assert";
import {
  CailSandboxError,
  createCailSandboxClient,
  type CailSandboxCredential,
  type FetchLike,
  type SandboxLease,
} from "../dist/index.js";

const baseUrl = process.env.CAIL_SANDBOX_ENFORCE_E2E_BASE_URL;
const token = process.env.CAIL_SANDBOX_E2E_AUTH_SECRET;
if (!baseUrl || !token) {
  throw new Error(
    "CAIL_SANDBOX_ENFORCE_E2E_BASE_URL and CAIL_SANDBOX_E2E_AUTH_SECRET are required",
  );
}
const parsedBaseUrl = new URL(baseUrl);
assert.equal(parsedBaseUrl.protocol, "https:");
assert.equal(parsedBaseUrl.port, "");
assert.equal(
  parsedBaseUrl.hostname,
  "cail-sandbox-bridge-enforce-e2e.veritas44.workers.dev",
  "quota enforcement E2E is locked to the disposable personal-account Worker",
);
assert.equal(parsedBaseUrl.pathname, "/");
assert.equal(parsedBaseUrl.search, "");
assert.equal(parsedBaseUrl.hash, "");
assert.equal(parsedBaseUrl.username, "");
assert.equal(parsedBaseUrl.password, "");

const app = "sandbox-enforce-e2e";
const credential: CailSandboxCredential = { kind: "key", token };
const control = () => crypto.randomUUID();
const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const subject = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `cail-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};
const fetchFor = (principal: string): FetchLike => async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("x-cail-poc-subject", principal);
  return fetch(input, { ...init, headers });
};
const clientFor = (principal: string) =>
  createCailSandboxClient({
    baseUrl,
    app,
    fetchImpl: fetchFor(principal),
  });

async function waitForHealthy(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { redirect: "error" });
      lastStatus = response.status;
      if (response.status === 200) return;
    } catch {
      lastStatus = 0;
    }
    await delay(2_000);
  }
  assert.fail(
    `sandbox enforcement E2E Worker did not become healthy; last status ${lastStatus}`,
  );
}

async function waitForAuthenticatedOpenapi(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      await aliceClient.openapi(credential);
      return;
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
    `sandbox enforcement authenticated contract did not become ready; last status ${lastStatus}`,
  );
}

const aliceClient = clientFor(subject());
let aliceLease: SandboxLease | undefined;
let bobLease: SandboxLease | undefined;
let bobClient: ReturnType<typeof clientFor> | undefined;

async function destroyQuietly(
  client: ReturnType<typeof clientFor> | undefined,
  lease: SandboxLease | undefined,
) {
  if (!client || !lease) return;
  try {
    await client.destroy(lease, credential);
  } catch (error) {
    if (!(error instanceof CailSandboxError && error.status === 404)) throw error;
  }
}

let primaryError: unknown;
try {
  await waitForHealthy();
  await waitForAuthenticatedOpenapi();
  const created = await aliceClient.create(
    { scopeKey: control(), idempotencyKey: control() },
    credential,
  );
  aliceLease = created;
  assert.equal(created.quota?.limitGibSeconds, 10);

  // Do not poll: status reads also reconcile the meter and must not become the
  // mechanism that drives the alarm under test. Ten GiB-s on a 256 MiB lite
  // instance is due after about 40 seconds; this stays before idle/hard caps.
  await delay(70_000);
  await assert.rejects(
    aliceClient.running(created, credential),
    (error: unknown) =>
      error instanceof CailSandboxError && error.status === 404,
    "quota alarm did not fence and destroy exhausted compute",
  );

  try {
    await aliceClient.create(
      { scopeKey: control(), idempotencyKey: control() },
      credential,
    );
    assert.fail("exhausted subject started new compute");
  } catch (error) {
    assert(error instanceof CailSandboxError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "quota_exceeded");
    assert.equal(error.quota?.state, "exhausted");
    assert.equal(error.quota?.remainingGibSeconds, 0);
  }

  bobClient = clientFor(subject());
  const createdBob = await bobClient.create(
    { scopeKey: control(), idempotencyKey: control() },
    credential,
  );
  bobLease = createdBob;
  assert.equal(createdBob.quota?.state, "ok");
  await bobClient.destroy(createdBob, credential);
  bobLease = undefined;
} catch (error) {
  primaryError = error;
}

let cleanupError: unknown;
try {
  await destroyQuietly(bobClient, bobLease);
  await destroyQuietly(aliceClient, aliceLease);
} catch (error) {
  cleanupError = error;
}
if (primaryError || cleanupError) {
  throw new AggregateError(
    [primaryError, cleanupError].filter((error) => error !== undefined),
    "CAIL sandbox quota enforcement live E2E failed",
  );
}

console.log("CAIL sandbox quota enforcement live E2E: all assertions passed");
