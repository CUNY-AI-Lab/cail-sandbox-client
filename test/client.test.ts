import { expect, test } from "bun:test";
import {
  CailSandboxError,
  correlationFromHeaders,
  createCailSandboxClient,
  type CailCorrelation,
} from "../src/index";

const jwt = { kind: "jwt" as const, token: "session-token" };
const createInput = {
  scopeKey: "scope-key-000000000000000000000000000001",
  idempotencyKey: "create-key-0000000000000000000000000001",
  profile: "offline-code" as const,
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
  profile: "offline-code",
  instance_class: "lite",
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
  lease_generation: 1,
};
const correlation: CailCorrelation = {
  trace_id: "0af7651916cd43dd8448eb211c80319c",
  span_id: "b7ad6b7169203331",
  trace_flags: 1,
  request_id: "9bb3ff5c-62c4-4e18-bca7-b48876e43af6",
};
const responseRequestId = "33333333-3333-4333-8333-333333333333";
const alternateRequestId = "44444444-4444-4444-8444-444444444444";

function sseResponse(body: BodyInit | null, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/event-stream");
  return new Response(body, { ...init, headers });
}

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
    profile: "offline-code",
  });
  expect(created).toEqual({
    id: lease.id,
    state: "active",
    expiresAt: "2026-07-12T12:00:00.000Z",
    leaseCapability: lease.leaseCapability,
    leaseGeneration: 1,
    profile: "offline-code",
    instanceClass: "lite",
  });
  expect("call" in client).toBeFalse();
  expect(redirect).toBe("manual");
});

test("rejects redirects without following or leaking credentials", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale-workbench",
    fetchImpl: async () =>
      new Response(null, {
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
      return Response.json(runningWire);
    },
  });
  const result = await client.running(lease, jwt, { correlation });
  expect(result.state).toBe("active");
  expect(seen.headers.get("x-cail-request-id")).toBe(
    "9bb3ff5c-62c4-4e18-bca7-b48876e43af6",
  );
  expect(seen.headers.get("traceparent")).toBe(
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  );
  expect(seen.url).toBe(`https://x/sandbox/v1/sandbox/${lease.id}/running`);
  expect(seen.headers.get("x-cail-sandbox-lease")).toBe(lease.leaseCapability);
});

test("reads strict aggregate usage and immutable per-lease settlement", async () => {
  const seen: Request[] = [];
  const usageWire = {
    period: "2026-07-22",
    unit: "mib_milliseconds",
    limit: 1_000,
    used: 400,
    reserved: 100,
    remaining: 500,
    active_leases: 1,
  };
  const settlementWire = {
    lease_id: lease.id,
    period_start: "2026-07-22T12:00:00.000Z",
    period_end: "2026-07-22T12:05:00.000Z",
    unit: "mib_milliseconds",
    quantity: 400,
    settled_at: "2026-07-22T12:05:01.000Z",
    state: "settled",
  };
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale-workbench",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      return Response.json(
        request.url.endsWith(`/usage/${lease.id}`)
          ? settlementWire
          : usageWire,
      );
    },
  });

  await expect(client.usage(jwt)).resolves.toEqual({
    period: "2026-07-22",
    unit: "mib_milliseconds",
    limit: 1_000,
    used: 400,
    reserved: 100,
    remaining: 500,
    activeLeases: 1,
  });
  await expect(client.settlement(lease.id, jwt)).resolves.toEqual({
    leaseId: lease.id,
    periodStart: "2026-07-22T12:00:00.000Z",
    periodEnd: "2026-07-22T12:05:00.000Z",
    unit: "mib_milliseconds",
    quantity: 400,
    settledAt: "2026-07-22T12:05:01.000Z",
    state: "settled",
  });
  expect(seen.map((request) => request.url)).toEqual([
    "https://x/sandbox/v1/usage",
    `https://x/sandbox/v1/usage/${lease.id}`,
  ]);
  expect(
    seen.every(
      (request) =>
        request.headers.get("x-cail-identity-jwt") === "session-token" &&
        request.headers.get("x-cail-app") === "kale-workbench" &&
        request.headers.get("x-cail-sandbox-lease") === null,
    ),
  ).toBeTrue();
});

test("fails closed on malformed usage and settlement responses", async () => {
  for (const body of [
    {
      period: "2026-02-30",
      unit: "mib_milliseconds",
      limit: 1_000,
      used: 400,
      reserved: 100,
      remaining: 500,
      active_leases: 1,
    },
    {
      period: "2026-07-22",
      unit: "mib_milliseconds",
      limit: 1_000,
      used: 400,
      reserved: 100,
      remaining: 501,
      active_leases: 1,
    },
  ]) {
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => Response.json(body),
    });
    await expect(client.usage(jwt)).rejects.toMatchObject({
      code: "invalid_response",
    });
  }

  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      Response.json({
        lease_id: "33333333-3333-4333-8333-333333333333",
        period_start: "2026-07-22T12:00:00.000Z",
        period_end: "2026-07-22T12:05:00.000Z",
        unit: "mib_milliseconds",
        quantity: Number.MAX_SAFE_INTEGER + 1,
        settled_at: "2026-07-22T12:05:01.000Z",
        state: "settled",
      }),
  });
  await expect(client.settlement(lease.id, jwt)).rejects.toMatchObject({
    code: "invalid_response",
  });
});

test("adopts only the canonical cail-log request-id header", () => {
  const canonical = "b5213d52-04cc-4b89-a5bd-f1db8884a34e";
  const alias = "916fc59d-d79a-40d5-a822-4e096d85bd01";
  expect(
    correlationFromHeaders(
      new Headers({
        "x-cail-request-id": canonical,
        "x-request-id": alias,
      }),
    ).request_id,
  ).toBe(canonical);

  const aliasOnly = correlationFromHeaders(
    new Headers({ "x-request-id": alias }),
  ).request_id;
  expect(aliasOnly).not.toBe(alias);
  expect(aliasOnly).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
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
        return sseResponse('event: exit\ndata: {"exit_code":0}\n\n');
      }
      if (request.method === "GET")
        return new Response("file", {
          headers: { "content-type": "application/octet-stream" },
        });
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
  expect(seen[1].headers.get("content-type")).toBe("application/octet-stream");
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
      if (request.url.endsWith(`/usage/${lease.id}`)) {
        return Response.json({
          lease_id: lease.id,
          period_start: "2026-07-22T12:00:00.000Z",
          period_end: "2026-07-22T12:05:00.000Z",
          unit: "mib_milliseconds",
          quantity: 400,
          settled_at: "2026-07-22T12:05:01.000Z",
          state: "settled",
        });
      }
      if (request.url.endsWith("/usage")) {
        return Response.json({
          period: "2026-07-22",
          unit: "mib_milliseconds",
          limit: 1_000,
          used: 400,
          reserved: 100,
          remaining: 500,
          active_leases: 1,
        });
      }
      if (request.url.endsWith("/openapi.json"))
        return Response.json({ openapi: "3.1.1" });
      if (request.method === "GET")
        return new Response("data", {
          headers: { "content-type": "application/octet-stream" },
        });
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
  await client.usage(jwt, options);
  await client.settlement(lease.id, jwt, options);
  await client.openapi(jwt, options);
  controller.abort();
  expect(seen).toHaveLength(10);
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
    ).rejects.toThrow("valid identity JWT");
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

test("cancels response bodies rejected before parsing", async () => {
  let canceled = 0;
  const rejectedBody = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        canceled += 1;
      },
    });

  const wrongStatus = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(rejectedBody(), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
  });
  await expect(wrongStatus.create(createInput, jwt)).rejects.toMatchObject({
    code: "invalid_response",
  });

  const wrongJsonMedia = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(rejectedBody(), {
        status: 201,
        headers: { "content-type": "text/plain" },
      }),
  });
  await expect(wrongJsonMedia.create(createInput, jwt)).rejects.toMatchObject({
    code: "invalid_response",
  });

  const wrongSseMedia = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(rejectedBody(), {
        headers: { "content-type": "text/plain" },
      }),
  });
  await expect(
    (async () => {
      for await (const event of await wrongSseMedia.exec(
        lease,
        operation,
        "true",
        jwt,
      )) {
        void event;
      }
    })(),
  ).rejects.toMatchObject({ code: "invalid_stream" });
  expect(canceled).toBe(3);

  let stalledCancelCalled = false;
  const stalledCancel = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
          },
          cancel() {
            stalledCancelCalled = true;
            return new Promise(() => undefined);
          },
        }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      ),
  });
  expect(
    await Promise.race([
      stalledCancel.create(createInput, jwt).then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(50).then(() => "stalled"),
    ]),
  ).toBe("rejected");
  expect(stalledCancelCalled).toBeTrue();
});

test("cancels unexpected successful no-content lifecycle bodies", async () => {
  const cancelled: boolean[] = [];
  const responseWithBody = () => {
    const index = cancelled.length;
    cancelled.push(false);
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, "body", {
      value: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled[index] = true;
        },
      }),
    });
    return response;
  };
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => responseWithBody(),
  });

  await client.destroy(lease, jwt);
  await client.destroySession(lease, operation, jwt);
  expect(cancelled).toEqual([true, true]);
});

test("rejects and cancels a successful file response with the wrong media type", async () => {
  let cancelled = false;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
  });

  await expect(
    client.readFile(lease, operation, "a.txt", jwt),
  ).rejects.toMatchObject({ code: "invalid_response" });
  expect(cancelled).toBeTrue();
});

test("preserves response metadata on unexpected statuses and malformed success bodies", async () => {
  for (const response of [
    Response.json(leaseWire, {
      status: 202,
      headers: {
        "x-cail-request-id": responseRequestId,
        "x-request-id": responseRequestId,
        "x-should-retry": "false",
      },
    }),
    new Response("not json", {
      status: 201,
      headers: {
        "x-cail-request-id": responseRequestId,
        "x-request-id": responseRequestId,
        "x-should-retry": "false",
      },
    }),
  ]) {
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => response.clone(),
    });
    await expect(client.create(createInput, jwt)).rejects.toMatchObject({
      code: "invalid_response",
      requestId: responseRequestId,
      shouldRetry: false,
    });
  }
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
    client.create({ ...createInput, scopeKey: "short" }, jwt),
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
    const error = await client
      .create(createInput, jwt)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(CailSandboxError);
    expect(error).toMatchObject({ code: "invalid_response" });
  }
});

test("requires the OpenAPI media type for JSON success responses", async () => {
  for (const contentType of [null, "text/plain", "application/problem+json"]) {
    const headers = new Headers({
      "x-cail-request-id": responseRequestId,
      "x-request-id": responseRequestId,
      "x-should-retry": "false",
    });
    if (contentType !== null) headers.set("content-type", contentType);
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () =>
        new Response(JSON.stringify(leaseWire), { status: 201, headers }),
    });
    await expect(client.create(createInput, jwt)).rejects.toMatchObject({
      code: "invalid_response",
      requestId: responseRequestId,
      shouldRetry: false,
    });
  }

  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(JSON.stringify(leaseWire), {
        status: 201,
        headers: { "content-type": "Application/JSON; charset=utf-8" },
      }),
  });
  await expect(client.create(createInput, jwt)).resolves.toMatchObject({
    id: lease.id,
  });
});

test("does not trust a typed error envelope sent with the wrong media type", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Do not trust this shape.",
            type: "permission_error",
            param: null,
            code: "forged_typed_error",
          },
        }),
        {
          status: 403,
          headers: {
            "content-type": "text/plain",
            "x-cail-request-id": responseRequestId,
            "x-request-id": responseRequestId,
            "x-should-retry": "false",
          },
        },
      ),
  });
  await expect(client.running(lease, jwt)).rejects.toMatchObject({
    code: "unknown_error",
    type: "unknown_error",
    requestId: responseRequestId,
    shouldRetry: false,
  });
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
    const error = await client
      .create(createInput, jwt)
      .catch((caught) => caught);
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
            "x-cail-request-id": responseRequestId,
            "x-request-id": responseRequestId,
            "x-should-retry": "false",
          },
        },
      ),
  });
  const error = await client.running(lease, jwt).catch((caught) => caught);
  expect(error).toBeInstanceOf(CailSandboxError);
  expect(error).toMatchObject({
    code: "forbidden",
    requestId: responseRequestId,
    shouldRetry: false,
    details: { scope: "sandbox:exec" },
  });
});

test("requires exact error metadata and rejects conflicting aliases", async () => {
  const errorBody = {
    error: {
      message: "No.",
      type: "permission_error",
      param: null,
      code: "forbidden",
    },
  };
  const exact = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      Response.json(errorBody, {
        status: 403,
        headers: {
          "x-cail-request-id": responseRequestId,
          "x-request-id": responseRequestId,
          "x-should-retry": "false",
        },
      }),
  });
  await expect(exact.running(lease, jwt)).rejects.toMatchObject({
    code: "forbidden",
    requestId: responseRequestId,
    shouldRetry: false,
  });

  for (const headers of [
    new Headers({
      "x-request-id": responseRequestId,
      "x-should-retry": "false",
    }),
    new Headers({
      "x-cail-request-id": responseRequestId,
      "x-should-retry": "false",
    }),
    new Headers({
      "x-cail-request-id": responseRequestId,
      "x-request-id": responseRequestId,
    }),
    new Headers({
      "x-cail-request-id": responseRequestId,
      "x-request-id": responseRequestId,
      "x-should-retry": "FALSE",
    }),
  ]) {
    const incomplete = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => Response.json(errorBody, { status: 403, headers }),
    });
    await expect(incomplete.running(lease, jwt)).rejects.toMatchObject({
      code: "unknown_error",
      type: "unknown_error",
    });
  }

  const conflicting = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      Response.json(errorBody, {
        status: 403,
        headers: {
          "x-cail-request-id": responseRequestId,
          "x-request-id": alternateRequestId,
          "x-should-retry": "false",
        },
      }),
  });
  await expect(conflicting.running(lease, jwt)).rejects.toMatchObject({
    code: "invalid_response",
    requestId: null,
    shouldRetry: false,
  });
});

test("fails closed on nested errors outside the OpenAPI schema", async () => {
  for (const error of [
    {
      message: "No.",
      type: "future_error_type",
      param: null,
      code: "future_code",
    },
    {
      message: "No.",
      type: "server_error",
      param: null,
      code: "broken",
      extra: true,
    },
    {
      message: "No.",
      type: "server_error",
      param: null,
      code: "broken_details",
      cail: { nested: { secret: "not allowed" } },
    },
  ]) {
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () =>
        Response.json(
          { error },
          {
            status: 500,
            headers: {
              "x-cail-request-id": responseRequestId,
              "x-request-id": responseRequestId,
              "x-should-retry": "false",
            },
          },
        ),
    });
    await expect(client.running(lease, jwt)).rejects.toMatchObject({
      code: "unknown_error",
      type: "unknown_error",
      requestId: responseRequestId,
      shouldRetry: false,
    });
  }
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
            "x-cail-request-id": responseRequestId,
            "x-request-id": responseRequestId,
            "x-should-retry": "true",
          },
        },
      ),
  });
  const error = await client.running(lease, jwt).catch((caught) => caught);
  expect(error).toMatchObject({
    code: "unknown_error",
    requestId: responseRequestId,
    shouldRetry: true,
  });
});

test("streams decoded output and one terminal event", async () => {
  const body =
    'event: stdout\ndata: {"data":"aGk="}\n\nevent: exit\ndata: {"exit_code":0}\n\n';
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => sseResponse(body),
  });
  const output = [];
  for await (const event of await client.exec(
    lease,
    operation,
    "echo hi",
    jwt,
  )) {
    output.push(event);
  }
  expect(output[0]).toEqual({
    type: "stdout",
    data: new TextEncoder().encode("hi"),
  });
  expect(output[1]).toEqual({ type: "exit", exitCode: 0 });
});

test("requires text/event-stream before parsing command events", async () => {
  for (const contentType of [null, "text/plain", "application/json"]) {
    const headers = new Headers({
      "x-cail-request-id": responseRequestId,
      "x-request-id": responseRequestId,
      "x-should-retry": "false",
    });
    if (contentType !== null) headers.set("content-type", contentType);
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () =>
        new Response('event: exit\ndata: {"exit_code":0}\n\n', { headers }),
    });
    const error = await (async () => {
      for await (const event of await client.exec(
        lease,
        operation,
        "true",
        jwt,
      )) {
        void event;
      }
    })().catch((caught) => caught);
    expect(error).toMatchObject({
      code: "invalid_stream",
      requestId: responseRequestId,
      shouldRetry: false,
    });
  }
});

test("a terminal SSE event is withheld until EOF proves uniqueness", async () => {
  for (const terminal of [
    'event: exit\ndata: {"exit_code":0}\n\n',
    'event: error\ndata: {"code":"command_failed","message":"No.","request_id":"33333333-3333-4333-8333-333333333333"}\n\n',
  ]) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream({
      start(activeController) {
        controller = activeController;
        activeController.enqueue(new TextEncoder().encode(terminal));
      },
    });
    const client = createCailSandboxClient({
      baseUrl: "https://x",
      app: "kale",
      fetchImpl: async () => sseResponse(stream),
    });
    const events = await client.exec(lease, operation, "x", jwt);
    const terminalResult = events.next();
    expect(
      await Promise.race([
        terminalResult.then(() => "resolved"),
        Bun.sleep(5).then(() => "pending"),
      ]),
    ).toBe("pending");
    controller.close();
    expect((await terminalResult).value).toMatchObject({
      type: terminal.startsWith("event: exit") ? "exit" : "error",
    });
    expect((await events.next()).done).toBeTrue();
  }
});

test("rejects a second terminal event instead of accepting the first", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      sseResponse(
          'event: exit\ndata: {"exit_code":0}\n\n' +
          'event: error\ndata: {"code":"late","message":"Late.","request_id":"33333333-3333-4333-8333-333333333333"}\n\n',
      ),
  });
  await expect(
    (async () => {
      for await (const event of await client.exec(lease, operation, "x", jwt)) {
        void event;
      }
    })(),
  ).rejects.toThrow("multiple terminal events");
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
    fetchImpl: async () => sseResponse(stream),
  });
  const output = [];
  for await (const event of await client.exec(
    lease,
    operation,
    "echo hi",
    jwt,
  )) {
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
    fetchImpl: async () => sseResponse(stream),
  });
  const events = await client.exec(lease, operation, "long command", jwt);
  expect((await events.next()).value).toEqual({
    type: "stdout",
    data: new TextEncoder().encode("x"),
  });
  await events.return(undefined);
  await Bun.sleep(0);
  expect(canceled).toBeTrue();
});

test("rejects unknown SSE event types consistently", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => sseResponse("event: heartbeat\ndata: not-json\n\n"),
  });
  await expect(
    (async () => {
      for await (const event of await client.exec(lease, operation, "x", jwt))
        void event;
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
      fetchImpl: async () => sseResponse(`event: stdout\ndata: ${data}\n\n`),
    });
    await expect(
      (async () => {
        for await (const event of await client.exec(lease, operation, "x", jwt))
          void event;
      })(),
    ).rejects.toMatchObject({ code: "invalid_stream" });
  }
});

test("rejects stream without exactly one terminal event", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      sseResponse('event: stdout\ndata: {"data":"eA=="}\n\n'),
  });
  await expect(
    (async () => {
      for await (const event of await client.exec(lease, operation, "x", jwt))
        void event;
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

test("preserves mid-stream transport errors and response metadata", async () => {
  const encoder = new TextEncoder();
  const transportError = new Error("connection reset by peer");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('event: stdout\ndata: {"data":"eA=="}\n\n'),
      );
    },
    pull(controller) {
      controller.error(transportError);
    },
  });
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () =>
      sseResponse(stream, {
        headers: {
          "x-cail-request-id": responseRequestId,
          "x-request-id": responseRequestId,
          "x-should-retry": "false",
        },
      }),
  });
  const error = await (async () => {
    for await (const event of await client.exec(lease, operation, "x", jwt))
      void event;
  })().catch((caught) => caught);
  expect(error).toBeInstanceOf(CailSandboxError);
  expect(error).toMatchObject({
    code: "stream_transport_error",
    requestId: responseRequestId,
    shouldRetry: false,
    cause: transportError,
  });
});

test("applies an optional default timeout and rejects invalid configuration", async () => {
  for (const defaultTimeoutMs of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    expect(() =>
      createCailSandboxClient({
        baseUrl: "https://x",
        app: "kale",
        defaultTimeoutMs,
      }),
    ).toThrow("defaultTimeoutMs");
  }

  let seenSignal!: AbortSignal;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    defaultTimeoutMs: 5,
    fetchImpl: async (_input, init) => {
      seenSignal = init!.signal!;
      return await new Promise<Response>((_resolve, reject) => {
        seenSignal.addEventListener("abort", () => reject(seenSignal.reason), {
          once: true,
        });
      });
    },
  });
  const error = await client.running(lease, jwt).catch((caught) => caught);
  expect(seenSignal.aborted).toBeTrue();
  expect(error).toMatchObject({ name: "TimeoutError" });
});

test("surfaces a mid-stream abort as an abort, not invalid_stream", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('event: stdout\ndata: {"data":"eA=="}\n\n'),
      );
    },
    pull(controller) {
      controller.error(
        new DOMException("The operation was aborted.", "AbortError"),
      );
    },
  });
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => sseResponse(stream),
  });
  const error = await (async () => {
    for await (const event of await client.exec(lease, operation, "x", jwt))
      void event;
  })().catch((caught) => caught);
  expect(error).not.toBeInstanceOf(CailSandboxError);
  expect(error).toMatchObject({ name: "AbortError" });
});

test("surfaces a mid-stream timeout as a timeout, not a transport error", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    defaultTimeoutMs: 5,
    fetchImpl: async (_input, init) => {
      const signal = init!.signal!;
      const stream = new ReadableStream({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return sseResponse(stream);
    },
  });
  const error = await (async () => {
    for await (const event of await client.exec(lease, operation, "x", jwt)) {
      void event;
    }
  })().catch((caught) => caught);
  expect(error).toMatchObject({ name: "TimeoutError" });
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
  await expect(client.running({ ...lease, id: ".." }, jwt)).rejects.toThrow(
    "identifier",
  );
  await expect(client.destroy({ ...lease, id: "a/../b" }, jwt)).rejects.toThrow(
    "identifier",
  );
  await expect(
    client.readFile({ ...lease, id: "box\\evil" }, operation, "a.txt", jwt),
  ).rejects.toThrow("identifier");
  await expect(
    client.destroySession(lease, { ...operation, id: ".." }, jwt),
  ).rejects.toThrow("identifier");
  await expect(
    client.createSession(
      { ...lease, id: "id\nwith-control" },
      operationInput,
      jwt,
    ),
  ).rejects.toThrow("identifier");
  await expect(
    client.exec({ ...lease, id: "" }, operation, "x", jwt),
  ).rejects.toThrow("identifier");
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

test("rejects paths the service cannot represent before sending credentials", async () => {
  let calls = 0;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => {
      calls += 1;
      return new Response();
    },
  });
  for (const path of [
    "../secret",
    "",
    "/absolute",
    "nested/%2e%2e/secret",
    "nested/%",
    "nested/\0secret",
  ]) {
    await expect(client.readFile(lease, operation, path, jwt)).rejects.toThrow(
      "workspace-relative",
    );
  }
  expect(calls).toBe(0);
});
