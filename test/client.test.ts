import { expect, test } from "bun:test";
import {
  CailSandboxError,
  createCailSandboxClient,
  type CailCorrelation,
} from "../src/index";

const jwt = { kind: "jwt" as const, token: "session-token" };
const createInput = {
  scopeKey: "scope-key-000000000000000000000000000001",
  idempotencyKey: "create-key-0000000000000000000000000001",
};
const lease = {
  id: "11111111-1111-4111-8111-111111111111",
  leaseCapability: "lease-capability-00000000000000000000001",
  leaseGeneration: 1,
};
const operationInput = {
  operationId: "operation-00000000000000000000000000001",
  idempotencyKey: "operation-key-00000000000000000000000001",
};
const operation = {
  id: "22222222-2222-4222-8222-222222222222",
  operationId: operationInput.operationId,
  operationCapability: "operation-capability-0000000000000000001",
  operationGeneration: 1,
  expiresAt: "2026-07-12T12:00:00.000Z",
};
const leaseWire = {
  id: lease.id,
  state: "active",
  expires_at: "2026-07-12T12:00:00.000Z",
  lease_capability: lease.leaseCapability,
  lease_generation: lease.leaseGeneration,
};
const operationWire = {
  id: operation.id,
  operation_capability: operation.operationCapability,
  operation_generation: operation.operationGeneration,
  expires_at: operation.expiresAt,
};
const runningWire = {
  running: true,
  state: "active",
  expires_at: "2026-07-12T12:00:00.000Z",
  incarnation: "placement-1",
  restored_from_incarnation: null,
  lease_generation: 1,
};
const correlation: CailCorrelation = {
  trace_id: "0af7651916cd43dd8448eb211c80319c",
  span_id: "b7ad6b7169203331",
  trace_flags: 1,
  request_id: "9bb3ff5c-62c4-4e18-bca7-b48876e43af6",
};

test("owns exactly one CAIL credential and app header", async () => {
  let seen!: Request;
  let redirect: RequestRedirect | undefined;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale-workbench",
    fetchImpl: async (input, init) => {
      redirect = init?.redirect;
      seen = new Request(input, init);
      return Response.json(leaseWire, { status: 201 });
    },
  });
  const created = await client.create(createInput, jwt);
  expect(seen.headers.get("x-cail-identity-jwt")).toBe("session-token");
  expect(seen.headers.get("authorization")).toBeNull();
  expect(seen.headers.get("x-cail-app")).toBe("kale-workbench");
  expect(await seen.json()).toEqual({
    scope_key: createInput.scopeKey,
    idempotency_key: createInput.idempotencyKey,
  });
  expect(created).toEqual({
    id: lease.id,
    state: "active",
    expiresAt: "2026-07-12T12:00:00.000Z",
    leaseCapability: lease.leaseCapability,
    leaseGeneration: 1,
  });
  expect("call" in client).toBeFalse();
  expect(redirect).toBe("manual");
});

test("rejects redirects without following or leaking credentials", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale-workbench",
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example" },
    }),
  });
  await expect(client.create(createInput, jwt)).rejects.toMatchObject({
    code: "unexpected_redirect",
    status: 302,
  });
});

test("forwards cail-log correlation on typed sandbox operations", async () => {
  let seen!: Request;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async (input, init) => {
      seen = new Request(input, init);
      return Response.json({ ...runningWire, state: "destroying" });
    },
  });
  const result = await client.running(lease, jwt, { correlation });
  expect(result.state).toBe("destroying");
  expect(result.restoredFromIncarnation).toBeNull();
  expect(seen.headers.get("x-cail-request-id")).toBe(
    "9bb3ff5c-62c4-4e18-bca7-b48876e43af6",
  );
  expect(seen.headers.get("traceparent")).toBe(
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  );
  expect(seen.url).toBe(
    `https://x/sandbox/v1/sandbox/${lease.id}/running`,
  );
  expect(seen.headers.get("x-cail-sandbox-lease")).toBe(
    lease.leaseCapability,
  );
});

test("binds session, file, exec, and cleanup calls to one operation capability", async () => {
  const seen: Request[] = [];
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      if (request.url.endsWith("/session")) {
        return Response.json(operationWire, { status: 201 });
      }
      if (request.url.endsWith("/exec")) {
        return new Response('event: exit\ndata: {"exit_code":0}\n\n');
      }
      if (request.method === "GET") return new Response("file");
      if (request.method === "PUT") return Response.json({ ok: true });
      return new Response(null, { status: 204 });
    },
  });
  const createdOperation = await client.createSession(
    lease,
    operationInput,
    jwt,
  );
  await client.writeFile(lease, createdOperation, "a.txt", "data", jwt);
  for await (const event of await client.exec(
    lease,
    createdOperation,
    "true",
    jwt,
  )) {
    void event;
  }
  await client.readFile(lease, createdOperation, "a.txt", jwt);
  await client.destroySession(lease, createdOperation, jwt);

  expect(createdOperation.operationId).toBe(operationInput.operationId);
  expect(await seen[0].json()).toEqual({
    operation_id: operationInput.operationId,
    idempotency_key: operationInput.idempotencyKey,
  });
  for (const request of seen) {
    expect(request.headers.get("x-cail-sandbox-lease")).toBe(
      lease.leaseCapability,
    );
  }
  for (const request of seen.slice(1)) {
    expect(request.headers.get("x-cail-session-id")).toBe(operation.id);
    expect(request.headers.get("x-cail-operation-id")).toBe(
      operation.operationId,
    );
    expect(request.headers.get("x-cail-operation-capability")).toBe(
      operation.operationCapability,
    );
  }
  expect(await seen[2].json()).toEqual({
    command: "true",
    session_id: operation.id,
  });
  expect(seen[1].headers.get("content-type")).toBe(
    "application/octet-stream",
  );
});

test("forwards AbortSignal on every typed sandbox operation", async () => {
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.push(request.signal);
      if (request.url.endsWith("/sandbox")) {
        return Response.json(leaseWire, { status: 201 });
      }
      if (request.url.endsWith("/session")) {
        return Response.json(operationWire, { status: 201 });
      }
      if (request.url.endsWith("/running")) {
        return Response.json(runningWire);
      }
      if (request.url.endsWith("/openapi.json")) return Response.json({ openapi: "3.1.1" });
      if (request.method === "GET") return new Response("data");
      if (request.method === "PUT") return Response.json({ ok: true });
      return new Response(null, { status: 204 });
    },
  });
  const options = { signal: controller.signal };
  await client.create(createInput, jwt, options);
  await client.running(lease, jwt, options);
  await client.createSession(lease, operationInput, jwt, options);
  await client.writeFile(lease, operation, "a.txt", "data", jwt, options);
  await client.readFile(lease, operation, "a.txt", jwt, options);
  await client.destroySession(lease, operation, jwt, options);
  await client.destroy(lease, jwt, options);
  await client.openapi(jwt, options);
  controller.abort();
  expect(seen).toHaveLength(8);
  expect(seen.every((signal) => signal.aborted)).toBeTrue();
});

test("rejects malformed correlation before fetch", async () => {
  let calls = 0;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => {
      calls += 1;
      return new Response();
    },
  });
  await expect(
    client.create(createInput, jwt, {
      correlation: { ...correlation, request_id: "has spaces" },
    }),
  ).rejects.toMatchObject({ code: "invalid_correlation", status: 0 });
  expect(calls).toBe(0);
});

test("rejects malformed runtime credentials before fetch", async () => {
  let calls = 0;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => {
      calls += 1;
      return Response.json(runningWire);
    },
  });
  for (const credential of [
    { kind: "jwt", token: "" },
    { kind: "other", token: "secret" },
    { kind: "key", token: "line\nbreak" },
  ]) {
    await expect(
      client.running(lease, credential as typeof jwt),
    ).rejects.toThrow("valid jwt or key token");
  }
  expect(calls).toBe(0);
});

test("enforces operation-specific success statuses and write acknowledgements", async () => {
  for (const response of [
    Response.json(leaseWire),
    Response.json(leaseWire, { status: 202 }),
  ]) {
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => response.clone(),
    });
    await expect(client.create(createInput, jwt)).rejects.toMatchObject({
      code: "invalid_response",
    });
  }

  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => Response.json({ ok: false }),
  });
  await expect(
    client.writeFile(lease, operation, "a.txt", "data", jwt),
  ).rejects.toMatchObject({ code: "invalid_response" });
});

test("rejects malformed scope and capability values before fetch", async () => {
  let calls = 0;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => {
      calls += 1;
      return new Response();
    },
  });
  await expect(
    client.create({ ...createInput, scopeKey: "conversation-1" }, jwt),
  ).rejects.toThrow("high-entropy opaque value");
  await expect(
    client.exec(lease, operation, "x".repeat(16_385), jwt),
  ).rejects.toThrow("1-16384");
  await expect(
    client.running({ ...lease, leaseCapability: "not-a-capability" }, jwt),
  ).rejects.toThrow("high-entropy opaque value");
  await expect(
    client.exec(
      lease,
      { ...operation, operationCapability: "not-a-capability" },
      "true",
      jwt,
    ),
  ).rejects.toThrow("high-entropy opaque value");
  expect(calls).toBe(0);
});

test("normalizes malformed server-issued capabilities to invalid_response", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      Response.json({ ...leaseWire, lease_capability: "too-short" }),
  });
  const error = await client.create(createInput, jwt).catch((caught) => caught);
  expect(error).toBeInstanceOf(CailSandboxError);
  expect(error).toMatchObject({ code: "invalid_response" });
});

test("normalizes invalid JSON and null success bodies to invalid_response", async () => {
  for (const response of [new Response("not json"), Response.json(null)]) {
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => response,
    });
    const error = await client.create(createInput, jwt).catch((caught) => caught);
    expect(error).toBeInstanceOf(CailSandboxError);
    expect(error).toMatchObject({ code: "invalid_response" });
  }
});

test("rejects non-RFC3339 and impossible lifecycle timestamps", async () => {
  for (const expires_at of [
    "2026-07-12",
    "July 12, 2026",
    "2026-02-30T12:00:00Z",
  ]) {
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => Response.json({ ...leaseWire, expires_at }),
    });
    const error = await client.create(createInput, jwt).catch((caught) => caught);
    expect(error).toBeInstanceOf(CailSandboxError);
    expect(error).toMatchObject({ code: "invalid_response" });
  }
});

test("preserves raw file response", async () => {
  const original = new Response(new Uint8Array([0, 255]), {
    headers: { "content-type": "application/octet-stream" },
  });
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => original,
  });
  expect(await client.readFile(lease, operation, "a.bin", jwt)).toBe(original);
});

test("parses nested CAIL errors and response metadata", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      Response.json(
        {
          error: {
            message: "No.",
            type: "permission_error",
            param: null,
            code: "forbidden",
            cail: { scope: "sandbox:exec" },
          },
        },
        {
          status: 403,
          headers: {
            "x-request-id": "req-error",
            "x-should-retry": "false",
          },
        },
      ),
  });
  const error = await client.running(lease, jwt).catch((caught) => caught);
  expect(error).toBeInstanceOf(CailSandboxError);
  expect(error).toMatchObject({
    code: "forbidden",
    requestId: "req-error",
    shouldRetry: false,
    details: { scope: "sandbox:exec" },
  });
});

test("rejects malformed nested envelopes but retains response metadata", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      Response.json(
        {
          error: {
            message: "bad shape",
            type: "server_error",
            code: "broken",
            cail: [],
          },
        },
        {
          status: 500,
          headers: {
            "x-request-id": "req-malformed",
            "x-should-retry": "true",
          },
        },
      ),
  });
  const error = await client.running(lease, jwt).catch((caught) => caught);
  expect(error).toMatchObject({
    code: "unknown_error",
    requestId: "req-malformed",
    shouldRetry: true,
  });
});

test("streams decoded output and one terminal event", async () => {
  const body =
    'event: stdout\ndata: {"data":"aGk="}\n\nevent: exit\ndata: {"exit_code":0}\n\n';
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const output = [];
  for await (const event of await client.exec(lease, operation, "echo hi", jwt)) {
    output.push(event);
  }
  expect(output[0]).toEqual({
    type: "stdout",
    data: new TextEncoder().encode("hi"),
  });
  expect(output[1]).toEqual({ type: "exit", exitCode: 0 });
});

test("a terminal SSE event completes without waiting for transport EOF", async () => {
  for (const terminal of [
    'event: exit\ndata: {"exit_code":0}\n\n',
    'event: error\ndata: {"code":"command_failed","message":"No.","request_id":"req-1"}\n\n',
  ]) {
    let canceled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(terminal));
      },
      cancel() {
        canceled = true;
      },
    });
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => new Response(stream),
    });
    const output = [];
    for await (const event of await client.exec(lease, operation, "x", jwt)) {
      output.push(event);
    }
    expect(output).toHaveLength(1);
    expect(canceled).toBeTrue();
  }
});

test("uses standard SSE framing across CRLF and split chunks", async () => {
  const encoder = new TextEncoder();
  const parts = [
    'event: stdout\r\ndata: {"data":',
    '"aGk="}\r\n\r\nevent: exit\r\ndata: {"exit_code":0}\r\n\r\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  const output = [];
  for await (const event of await client.exec(lease, operation, "echo hi", jwt)) {
    output.push(event);
  }
  expect(output).toHaveLength(2);
  expect(output[1]).toEqual({ type: "exit", exitCode: 0 });
});

test("canceling iteration cancels the underlying command response", async () => {
  let canceled = false;
  const bytes = new TextEncoder().encode(
    'event: stdout\ndata: {"data":"eA=="}\n\n',
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      canceled = true;
    },
  });
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  const events = await client.exec(lease, operation, "long command", jwt);
  expect((await events.next()).value).toEqual({
    type: "stdout",
    data: new TextEncoder().encode("x"),
  });
  await events.return(undefined);
  expect(canceled).toBeTrue();
});

test("rejects unknown SSE event types consistently", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response("event: heartbeat\ndata: not-json\n\n"),
  });
  await expect(
    (async () => {
      for await (const event of await client.exec(lease, operation, "x", jwt)) void event;
    })(),
  ).rejects.toThrow("unknown event type");
});

test("rejects undeclared or oversized command output event data", async () => {
  const oversized = btoa("x".repeat(1_048_577));
  for (const data of [
    '{"data":"eA==","extra":true}',
    JSON.stringify({ data: oversized }),
  ]) {
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => new Response(`event: stdout\ndata: ${data}\n\n`),
    });
    await expect(
      (async () => {
        for await (const event of await client.exec(lease, operation, "x", jwt)) void event;
      })(),
    ).rejects.toMatchObject({ code: "invalid_stream" });
  }
});

test("rejects stream without exactly one terminal event", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response('event: stdout\ndata: {"data":"eA=="}\n\n'),
  });
  await expect(
    (async () => {
      for await (const event of await client.exec(lease, operation, "x", jwt)) void event;
    })(),
  ).rejects.toThrow("without a terminal");
});

test("rejects plaintext baseUrl hosts that merely resemble localhost", () => {
  expect(() =>
    createCailSandboxClient({
      baseUrl: "http://localhost.evil.com",
      app: "kale",
      fetchImpl: async () => new Response(),
    }),
  ).toThrow("HTTPS");
});

test("accepts HTTPS and loopback-only plaintext baseUrls", () => {
  for (const baseUrl of [
    "https://x",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ]) {
    expect(() =>
      createCailSandboxClient({
        baseUrl,
        app: "kale",
        fetchImpl: async () => new Response(),
      }),
    ).not.toThrow();
  }
});

test("rejects non-HTTP schemes and unparseable baseUrls", () => {
  for (const baseUrl of ["ftp://x", "http://10.0.0.5", "not a url", ""]) {
    expect(() =>
      createCailSandboxClient({
        baseUrl,
        app: "kale",
        fetchImpl: async () => new Response(),
      }),
    ).toThrow();
  }
});

test("rejects baseUrl userinfo, query strings, and fragments", () => {
  for (const baseUrl of [
    "https://user:pass@x/api",
    "https://x/api?tenant=1",
    "https://x/api#sandbox",
  ]) {
    expect(() =>
      createCailSandboxClient({
        baseUrl,
        app: "kale",
        fetchImpl: async () => new Response(),
      }),
    ).toThrow("must not contain");
  }
});

test("normalizes a baseUrl path prefix without string-concatenation ambiguity", async () => {
  let seen!: Request;
  const client = createCailSandboxClient({
    baseUrl: "https://x/api/",
    app: "kale",
    fetchImpl: async (input, init) => {
      seen = new Request(input, init);
      return Response.json({ openapi: "3.1.1" });
    },
  });
  await client.openapi(jwt);
  expect(seen.url).toBe("https://x/api/sandbox/v1/openapi.json");
});

test("normalizes mid-stream transport errors to a typed invalid_stream", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: stdout\ndata: {"data":"eA=="}\n\n'));
    },
    pull(controller) {
      controller.error(new Error("connection reset by peer"));
    },
  });
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  const error = await (async () => {
    for await (const event of await client.exec(lease, operation, "x", jwt)) void event;
  })().catch((caught) => caught);
  expect(error).toBeInstanceOf(CailSandboxError);
  expect(error).toMatchObject({ code: "invalid_stream" });
});

test("surfaces a mid-stream abort as an abort, not invalid_stream", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: stdout\ndata: {"data":"eA=="}\n\n'));
    },
    pull(controller) {
      controller.error(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  const error = await (async () => {
    for await (const event of await client.exec(lease, operation, "x", jwt)) void event;
  })().catch((caught) => caught);
  expect(error).not.toBeInstanceOf(CailSandboxError);
  expect(error).toMatchObject({ name: "AbortError" });
});

test("rejects path-shaped sandbox and session ids client-side", async () => {
  let calls = 0;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => {
      calls += 1;
      return new Response();
    },
  });
  await expect(client.running({ ...lease, id: ".." }, jwt)).rejects.toThrow("identifier");
  await expect(client.destroy({ ...lease, id: "a/../b" }, jwt)).rejects.toThrow("identifier");
  await expect(client.readFile({ ...lease, id: "box\\evil" }, operation, "a.txt", jwt)).rejects.toThrow(
    "identifier",
  );
  await expect(client.destroySession(lease, { ...operation, id: ".." }, jwt)).rejects.toThrow(
    "identifier",
  );
  await expect(client.createSession({ ...lease, id: "id\nwith-control" }, operationInput, jwt)).rejects.toThrow(
    "identifier",
  );
  await expect(client.exec({ ...lease, id: "" }, operation, "x", jwt)).rejects.toThrow("identifier");
  expect(calls).toBe(0);
});

test("accepts contract-shaped uuid ids", async () => {
  let seen!: Request;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async (input, init) => {
      seen = new Request(input, init);
      return Response.json(runningWire);
    },
  });
  await client.running(
    { ...lease, id: "123e4567-e89b-42d3-a456-426614174000" },
    jwt,
  );
  expect(seen.url).toBe(
    "https://x/sandbox/v1/sandbox/123e4567-e89b-42d3-a456-426614174000/running",
  );
});

test("rejects client-side path traversal", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => new Response(),
  });
  await expect(client.readFile(lease, operation, "../secret", jwt)).rejects.toThrow(
    "workspace-relative",
  );
  await expect(client.readFile(lease, operation, "", jwt)).rejects.toThrow(
    "workspace-relative",
  );
});
