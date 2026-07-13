import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CailSandboxError,
  createCailSandboxClient,
  type CailSandboxCredential,
  type CommandTerminalEvent,
  type FetchLike,
  type SandboxLease,
  type SandboxOperation,
} from "../dist/index.js";
import {
  LOCAL_E2E_WORKER_NAME,
  LOCAL_E2E_WRANGLER_ARGS,
  sanitizedLocalE2EEnvironment,
} from "./local-continuity-policy.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(
  process.env.CAIL_GATEWAY_SANDBOX_DIR ??
    join(scriptDir, "..", "..", "cail-gateway", "sandbox-bridge"),
);
const configPath = join(gatewayDir, "wrangler.local-e2e.jsonc");
await access(configPath);

const port = Number(process.env.CAIL_SANDBOX_LOCAL_E2E_PORT ?? "8794");
assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65_535);
const baseUrl = `http://127.0.0.1:${port}`;
const authSecret = crypto.randomUUID().replaceAll("-", "");
const capabilitySecret = crypto.randomUUID().replaceAll("-", "");
const subject = `cail-${crypto.randomUUID().replaceAll("-", "")}`;
const credential: CailSandboxCredential = { kind: "key", token: authSecret };
const control = () => crypto.randomUUID();
const proxyImage = "cloudflare/proxy-everything:3cb1195";
const proxyIndexDigest =
  "sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";
const proxyPlatform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
const sandboxBaseImage = "cloudflare/sandbox:0.12.3";
const lockDir = join(tmpdir(), `${LOCAL_E2E_WORKER_NAME}.lock`);
const serverLogs: string[] = [];

type BunProcess = ReturnType<typeof Bun.spawn>;

function output(value: Uint8Array) {
  return new TextDecoder().decode(value).trim();
}

function runDocker(args: string[], purpose: string, errors?: unknown[]) {
  const result = Bun.spawnSync(["docker", ...args]);
  if (result.exitCode !== 0) {
    const error = new Error(`${purpose}: ${output(result.stderr)}`);
    if (errors) {
      errors.push(error);
      return undefined;
    }
    throw error;
  }
  return output(result.stdout);
}

function sandboxImageTags() {
  return new Set(
    (runDocker(
      ["images", "cloudflare-dev/sandbox", "--format", "{{.Repository}}:{{.Tag}}"],
      "Could not inventory local sandbox images",
    ) ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function proxyContainerIds() {
  return new Set(
    (runDocker(
      ["ps", "-aq", "--filter", `name=workerd-${LOCAL_E2E_WORKER_NAME}-`],
      "Could not inventory local proxy containers",
    ) ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function imageExists(image: string) {
  const result = Bun.spawnSync(["docker", "image", "inspect", image]);
  return result.exitCode === 0;
}

function prepareProxyImage() {
  const manifest = Bun.spawnSync(["docker", "buildx", "imagetools", "inspect", proxyImage]);
  assert.equal(manifest.exitCode, 0, "Could not inspect Cloudflare's local egress proxy manifest");
  assert(
    output(manifest.stdout).includes(`Digest:    ${proxyIndexDigest}`),
    "Cloudflare's local egress proxy tag did not match Wrangler's pinned index digest",
  );
  const pulled = Bun.spawnSync(["docker", "pull", proxyImage, "--platform", proxyPlatform], {
    stdout: "ignore",
    stderr: "pipe",
  });
  assert.equal(pulled.exitCode, 0, `Could not pull Cloudflare's local egress proxy: ${output(pulled.stderr)}`);
  assert.equal(
    runDocker(["image", "inspect", proxyImage, "--format", "{{.Architecture}}"], "Could not inspect local egress proxy platform"),
    proxyPlatform.replace("linux/", ""),
    "Cloudflare's local egress proxy did not match the host platform",
  );
}

async function acquireSingletonLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, "pid"), String(process.pid), "utf8");
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const pid = Number(await readFile(join(lockDir, "pid"), "utf8").catch(() => "0"));
      let active = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          active = true;
        } catch {
          // A dead owner left a stale lock.
        }
      }
      if (active) throw new Error(`Another ${LOCAL_E2E_WORKER_NAME} run is active (pid ${pid})`);
      await rm(lockDir, { recursive: true, force: true });
    }
  }
  throw new Error(`Could not acquire ${LOCAL_E2E_WORKER_NAME} lock`);
}

function retainLog(value: string) {
  serverLogs.push(
    value
      .replaceAll(authSecret, "[synthetic-auth-redacted]")
      .replaceAll(capabilitySecret, "[synthetic-capability-redacted]"),
  );
  if (serverLogs.length > 200) serverLogs.shift();
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    retainLog(decoder.decode(value, { stream: true }));
  }
  const final = decoder.decode();
  if (final) retainLog(final);
}

const delay = (milliseconds: number) => Bun.sleep(milliseconds);

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

async function main() {
  let lockHeld = false;
  let stateDir: string | undefined;
  let server: BunProcess | undefined;
  let drains: Promise<unknown> = Promise.resolve();
  let lease: SandboxLease | undefined;
  let operation: SandboxOperation | undefined;
  let preexistingSandboxImages = new Set<string>();
  let preexistingProxyContainers = new Set<string>();
  let proxyWasPresent = false;
  let baseWasPresent = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];

  const stopForSignal = () => server?.kill("SIGTERM");
  process.on("SIGINT", stopForSignal);
  process.on("SIGTERM", stopForSignal);

  try {
    await acquireSingletonLock();
    lockHeld = true;
    preexistingSandboxImages = sandboxImageTags();
    preexistingProxyContainers = proxyContainerIds();
    proxyWasPresent = imageExists(proxyImage);
    baseWasPresent = imageExists(sandboxBaseImage);
    prepareProxyImage();
    stateDir = await mkdtemp(join(tmpdir(), "cail-sandbox-local-e2e-"));

    const childEnv = sanitizedLocalE2EEnvironment(process.env);
    childEnv.MINIFLARE_CONTAINER_EGRESS_IMAGE = proxyImage;
    childEnv.MINIFLARE_CONTAINER_EGRESS_IMAGE_PLATFORM = proxyPlatform;

    server = Bun.spawn(
      [
        "bunx",
        "wrangler",
        "dev",
        "--config",
        configPath,
        ...LOCAL_E2E_WRANGLER_ARGS,
        stateDir,
        "--port",
        String(port),
        "--var",
        `CAIL_POC_AUTH_SECRET:${authSecret}`,
        "--var",
        `CAIL_POC_CAPABILITY_SECRET:${capabilitySecret}`,
        "--log-level",
        "warn",
        "--show-interactive-dev-session=false",
      ],
      { cwd: gatewayDir, env: childEnv, stdout: "pipe", stderr: "pipe" },
    );
    drains = Promise.all([
      drain(server.stdout as ReadableStream<Uint8Array>),
      drain(server.stderr as ReadableStream<Uint8Array>),
    ]);

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) {
        throw new Error(`Local Wrangler exited before readiness (${server.exitCode}).\n${serverLogs.join("")}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health`, { redirect: "error" });
        if (response.status === 200) break;
      } catch {
        // The local Worker is still starting.
      }
      await delay(500);
    }
    if (Date.now() >= deadline) throw new Error(`Local Wrangler did not become ready.\n${serverLogs.join("")}`);

    const fetchForSubject: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-cail-poc-subject", subject);
      return fetch(input, { ...init, headers });
    };
    const client = createCailSandboxClient({ baseUrl, app: "sandbox-local-e2e", fetchImpl: fetchForSubject });

    async function runCommand(currentLease: SandboxLease, currentOperation: SandboxOperation, command: string) {
      let commandOutput = "";
      let terminal: CommandTerminalEvent | undefined;
      for await (const event of await client.exec(currentLease, currentOperation, command, credential)) {
        if ("data" in event) commandOutput += new TextDecoder().decode(event.data);
        else terminal = event;
      }
      assert.deepEqual(terminal, { type: "exit", exitCode: 0 }, commandOutput);
      return commandOutput;
    }

    const openapi = await client.openapi(credential);
    const reviewedOpenapi = JSON.parse(await readFile(new URL("../contract/sandbox-openapi.json", import.meta.url), "utf8"));
    assert.deepEqual(openapi, reviewedOpenapi);
    lease = await client.create({ scopeKey: control(), idempotencyKey: control() }, credential);
    operation = await client.createSession(lease, { operationId: control(), idempotencyKey: control() }, credential);

    const binary = new Uint8Array([0, 255, 1, 2, 3, 254]);
    await client.writeFile(lease, operation, "nested/local-proof.bin", binary, credential);
    await runCommand(
      lease,
      operation,
      "set -eu; mkdir -p /workspace/node_modules/local-proof; printf 'restored-dependency\\n' > /workspace/node_modules/local-proof/state.txt; printf ready",
    );
    const before = await client.running(lease, credential);
    assert.equal(before.running, true);
    assert(before.incarnation, "Initial container omitted its incarnation");
    assert.equal(before.restoredFromIncarnation, null);

    await client.destroySession(lease, operation, credential);
    operation = undefined;
    const idleDeadline = Date.now() + 120_000;
    let stopped = await client.running(lease, credential);
    while (stopped.running && Date.now() < idleDeadline) {
      await delay(1_000);
      stopped = await client.running(lease, credential);
    }
    assert.equal(stopped.running, false, "Local sandbox did not snapshot and stop after its idle window");
    assert.equal(stopped.incarnation, before.incarnation);

    operation = await client.createSession(lease, { operationId: control(), idempotencyKey: control() }, credential);
    const restored = await client.running(lease, credential);
    assert.equal(restored.running, true);
    assert(restored.incarnation, "Restored container omitted its incarnation");
    assert.notEqual(restored.incarnation, before.incarnation);
    assert.equal(restored.restoredFromIncarnation, before.incarnation);
    await runCommand(
      lease,
      operation,
      "set -eu; test \"$(cat /workspace/node_modules/local-proof/state.txt)\" = restored-dependency; test -f /workspace/nested/local-proof.bin",
    );
    const raw = await client.readFile(lease, operation, "nested/local-proof.bin", credential);
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), binary);

    await client.destroySession(lease, operation, credential);
    operation = undefined;
    await client.destroy(lease, credential);
    await client.destroy(lease, credential);
    await assert.rejects(
      client.running(lease, credential),
      (error: unknown) => error instanceof CailSandboxError && error.status === 404 && error.code === "not_found",
    );
    lease = undefined;
  } catch (error) {
    primaryError = error;
  } finally {
    if (lease && operation) {
      try {
        const client = createCailSandboxClient({ baseUrl, app: "sandbox-local-e2e", fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("x-cail-poc-subject", subject);
          return fetch(input, { ...init, headers });
        } });
        await bounded(client.destroySession(lease, operation, credential), 10_000, "session cleanup");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (lease) {
      try {
        const client = createCailSandboxClient({ baseUrl, app: "sandbox-local-e2e", fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("x-cail-poc-subject", subject);
          return fetch(input, { ...init, headers });
        } });
        await bounded(client.destroy(lease, credential), 10_000, "lease cleanup");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (server?.exitCode === null) server.kill("SIGTERM");
    if (server) {
      await Promise.race([server.exited, delay(5_000)]).catch((error) => cleanupErrors.push(error));
      if (server.exitCode === null) server.kill("SIGKILL");
      await server.exited.catch((error) => cleanupErrors.push(error));
    }
    await drains.catch((error) => cleanupErrors.push(error));
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
      try {
        await access(stateDir);
        cleanupErrors.push(new Error("Disposable Wrangler state remains after cleanup"));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          cleanupErrors.push(error);
        }
      }
    }

    try {
      const createdContainers = [...proxyContainerIds()].filter((id) => !preexistingProxyContainers.has(id));
      if (createdContainers.length > 0) runDocker(["rm", "-f", ...createdContainers], "Could not remove run-owned proxy containers", cleanupErrors);
      const createdImages = [...sandboxImageTags()].filter((tag) => !preexistingSandboxImages.has(tag));
      for (const image of createdImages) runDocker(["image", "rm", image], `Could not remove run-owned image ${image}`, cleanupErrors);
      if (!proxyWasPresent && imageExists(proxyImage)) runDocker(["image", "rm", proxyImage], "Could not remove introduced proxy image", cleanupErrors);
      if (!baseWasPresent && imageExists(sandboxBaseImage)) runDocker(["image", "rm", sandboxBaseImage], "Could not remove introduced sandbox base image", cleanupErrors);
      if (!setsEqual(proxyContainerIds(), preexistingProxyContainers)) cleanupErrors.push(new Error("Run-owned proxy container cleanup did not restore the initial inventory"));
      if (!setsEqual(sandboxImageTags(), preexistingSandboxImages)) cleanupErrors.push(new Error("Run-owned sandbox image cleanup did not restore the initial inventory"));
      if (!proxyWasPresent && imageExists(proxyImage)) cleanupErrors.push(new Error("Introduced proxy image remains after cleanup"));
      if (!baseWasPresent && imageExists(sandboxBaseImage)) cleanupErrors.push(new Error("Introduced sandbox base image remains after cleanup"));
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (lockHeld) await rm(lockDir, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
    process.off("SIGINT", stopForSignal);
    process.off("SIGTERM", stopForSignal);
  }

  if (primaryError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter((error) => error !== undefined),
      `CAIL local continuity E2E failed.\n${serverLogs.join("")}`,
    );
  }
  console.log("CAIL local continuity E2E: all assertions passed; local state removed and inventory restored");
}

await main();
