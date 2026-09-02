import { describe, expect, spyOn, test } from "bun:test";
import {
  CailSandboxError,
  createCailSandboxClient,
  type FetchLike,
  type SandboxClientOptions,
} from "../src/index";

const jwt = { kind: "jwt" as const, token: "session-token" };
const responseRequestId = "33333333-3333-4333-8333-333333333333";
const lease = {
  id: "11111111-1111-4111-8111-111111111111",
  leaseCapability: "lease-capability-00000000000000000000001",
  leaseGeneration: 1,
};
const operation = {
  id: "22222222-2222-4222-8222-222222222222",
  operationId: "operation-00000000000000000000000000001",
  operationCapability: "operation-capability-0000000000000000001",
  operationGeneration: 1,
  expiresAt: "2026-07-12T12:00:00.000Z",
};
const maxJsonBytes = 65_536;
const jsonHeaders = {
  "content-type": "application/json",
  "x-cail-request-id": responseRequestId,
  "x-request-id": responseRequestId,
  "x-should-retry": "false",
};
const sseHeaders = {
  "content-type": "text/event-stream",
  "x-cail-request-id": responseRequestId,
  "x-request-id": responseRequestId,
  "x-should-retry": "false",
};

function client(fetchImpl: FetchLike, defaultTimeoutMs?: number) {
  const options: SandboxClientOptions = {
    baseUrl: "https://sandbox.invalid",
    app: "boundaries",
    fetchImpl,
  };
  if (defaultTimeoutMs !== undefined) options.defaultTimeoutMs = defaultTimeoutMs;
  return createCailSandboxClient(options);
}

function sse(body: string) {
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function execError(body: string) {
  return (async () => {
    for await (const event of await client(async () => sse(body)).exec(
      lease,
      operation,
      "true",
      jwt,
    )) {
      void event;
    }
  })().catch((error) => error);
}

type CleanupMode = "resolve" | "reject" | "never" | "throw";
type ReleaseMode = "resolve" | "throw";

function customStalledReader<T>(onGetReader?: () => void) {
  let rejectRead!: (cause: unknown) => void;
  let cancelCalls = 0;
  let releaseCalls = 0;
  let cancelReason: unknown;
  const reading = new Promise<T>((_, reject) => {
    rejectRead = reject;
  });
  const reader = {
    read: () => reading,
    cancel: (cause?: unknown) => {
      cancelCalls += 1;
      cancelReason = cause;
      return new Promise<void>(() => undefined);
    },
    releaseLock: () => {
      releaseCalls += 1;
    },
  };
  // SAFETY: This fixture intentionally implements only the reader operations
  // exercised by cancellation and late-rejection tests.
  const body: ReadableStream<Uint8Array> = {
    getReader: () => {
      onGetReader?.();
      return reader;
    },
  } as never;
  return {
    body,
    rejectRead,
    cancelCalls: () => cancelCalls,
    cancelReason: () => cancelReason,
    releaseCalls: () => releaseCalls,
  };
}

function nativeStalledBody(cleanup: CleanupMode) {
  let cancelCalls = 0;
  let cancelReason: unknown;
  const cleanupError = new Error("private native cleanup sentinel");
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
    cancel(reason) {
      cancelCalls += 1;
      cancelReason = reason;
      if (cleanup === "throw") throw cleanupError;
      if (cleanup === "reject") return Promise.reject(cleanupError);
      if (cleanup === "never") return new Promise<void>(() => undefined);
    },
  });
  return {
    body,
    cancelCalls: () => cancelCalls,
    cancelReason: () => cancelReason,
  };
}

function erroredStream(
  cause: unknown,
  cleanup: CleanupMode,
  release: ReleaseMode = "resolve",
) {
  let cancelCalls = 0;
  let releaseCalls = 0;
  const cleanupError = new Error("private cleanup sentinel");
  const releaseError = new Error("private release sentinel");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(cause);
    },
  });
  const getReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, "getReader", {
    value: () => {
      const reader = getReader();
      const releaseLock = reader.releaseLock.bind(reader);
      Object.defineProperty(reader, "cancel", {
        value: () => {
          cancelCalls += 1;
          if (cleanup === "throw") throw cleanupError;
          if (cleanup === "reject") return Promise.reject(cleanupError);
          if (cleanup === "never") return new Promise<void>(() => undefined);
          return Promise.resolve();
        },
      });
      Object.defineProperty(reader, "releaseLock", {
        value: () => {
          releaseCalls += 1;
          if (release === "throw") throw releaseError;
          releaseLock();
        },
      });
      return reader;
    },
  });
  return {
    stream,
    cancelCalls: () => cancelCalls,
    releaseCalls: () => releaseCalls,
  };
}

function responseWithBody(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
) {
  const response = new Response(null, { headers });
  Object.defineProperty(response, "body", { value: body });
  return response;
}

function sseErrorResponse(
  stream: ReadableStream<Uint8Array>,
): Response {
  const body = new ReadableStream<Uint8Array>();
  Object.defineProperty(body, "pipeThrough", {
    value: () => ({ pipeThrough: () => stream }),
  });
  return new Response(body, { headers: sseHeaders });
}

async function executeToError(response: Response) {
  return (async () => {
    for await (const event of await client(async () => response).exec(
      lease,
      operation,
      "true",
      jwt,
    )) {
      void event;
    }
  })().catch((error) => error);
}

test("rejects non-UUID response correlation without retaining the junk value", async () => {
  const error = await client(async () =>
    Response.json(
      {
        error: {
          message: "No.",
          type: "permission_error",
          param: null,
          code: "forbidden",
        },
      },
      {
        status: 403,
        headers: {
          "x-cail-request-id": "not-a-uuid",
          "x-request-id": "not-a-uuid",
          "x-should-retry": "false",
        },
      },
    ),
  )
    .running(lease, jwt)
    .catch((error) => error);

  expect(error).toBeInstanceOf(CailSandboxError);
  expect(error).toMatchObject({
    code: "invalid_response",
    requestId: null,
    shouldRetry: false,
  });
  expect(error.message).not.toContain("not-a-uuid");
});

test("rejects non-UUID correlation on an otherwise valid success response", async () => {
  const error = await client(async () =>
    Response.json(
      {
        running: true,
        state: "active",
        expires_at: "2026-07-12T12:00:00.000Z",
        lease_generation: 1,
      },
      {
        headers: {
          "x-cail-request-id": "not-a-uuid",
          "x-request-id": "not-a-uuid",
        },
      },
    ),
  )
    .running(lease, jwt)
    .catch((error) => error);

  expect(error).toMatchObject({
    code: "invalid_response",
    requestId: null,
  });
  expect(error.message).not.toContain("not-a-uuid");
});

test("rejects a non-UUID command error request_id", async () => {
  const error = await execError(
    'event: error\ndata: {"code":"command_failed","message":"No.","request_id":"not-a-uuid"}\n\n',
  );
  expect(error).toMatchObject({
    code: "invalid_stream",
    requestId: null,
  });
});

test("rejects noncanonical RFC 4648 output encodings", async () => {
  for (const data of ["aGVsbG8", "aGVs bG8=", "Zh=="]) {
    const error = await execError(
      `event: stdout\ndata: ${JSON.stringify({ data })}\n\n` +
        'event: exit\ndata: {"exit_code":0}\n\n',
    );
    expect(error).toMatchObject({ code: "invalid_stream" });
  }
});

test("rejects unsafe integer generations and command exit codes", async () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const lifecycle = client(async () =>
    Response.json(
      {
        id: lease.id,
        state: "active",
        expires_at: operation.expiresAt,
        lease_capability: lease.leaseCapability,
        lease_generation: unsafe,
        instance_class: "lite",
      },
      { status: 201 },
    ),
  );
  await expect(
    lifecycle.create(
      {
        scopeKey: "scope-key-000000000000000000000000000001",
        idempotencyKey: "create-key-0000000000000000000000000001",
      },
      jwt,
    ),
  ).rejects.toMatchObject({ code: "invalid_response" });

  const session = client(async () =>
    Response.json(
      {
        id: operation.id,
        operation_capability: operation.operationCapability,
        operation_generation: unsafe,
        expires_at: operation.expiresAt,
      },
      { status: 201 },
    ),
  );
  await expect(
    session.createSession(
      lease,
      {
        operationId: operation.operationId,
        idempotencyKey: "operation-key-00000000000000000000000001",
      },
      jwt,
    ),
  ).rejects.toMatchObject({ code: "invalid_response" });

  const running = client(async () =>
    Response.json({
      running: true,
      state: "active",
      expires_at: operation.expiresAt,
      lease_generation: unsafe,
    }),
  );
  await expect(running.running(lease, jwt)).rejects.toMatchObject({
    code: "invalid_response",
  });

  const exitError = await execError(
    `event: exit\ndata: ${JSON.stringify({ exit_code: unsafe })}\n\n`,
  );
  expect(exitError).toMatchObject({ code: "invalid_stream" });
});

test("rejects and cancels a declared oversized JSON response", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([123]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const parser = client(async () => {
    return new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-length": String(maxJsonBytes + 1),
      },
    });
  });

  const error = await parser.running(lease, jwt).catch((error) => error);
  expect(error).toMatchObject({
    code: "invalid_response",
    cause: { name: "ResponseBodyReadError" },
  });
  expect(cancelled).toBe(true);
});

test("rejects malformed UTF-8 and cancels the still-open response", async () => {
  let cancelled = false;
  const malformed = new Uint8Array([
    ...new TextEncoder().encode('{"value":"'),
    0xff,
    ...new TextEncoder().encode('"}'),
  ]);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(malformed);
    },
    cancel() {
      cancelled = true;
      return new Promise(() => undefined);
    },
  });
  const outcome = await Promise.race([
    client(async () => {
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    })
      .running(lease, jwt)
      .catch((error) => error),
    Bun.sleep(50).then(() => "stalled"),
  ]);

  expect(outcome).not.toBe("stalled");
  expect(outcome).toMatchObject({
    code: "invalid_response",
    cause: {
      name: "ResponseBodyReadError",
      cause: { name: "TypeError" },
    },
  });
  expect(cancelled).toBe(true);
});

test("accepts an exact-limit JSON response", async () => {
  const wire = JSON.stringify({
    running: true,
    state: "active",
    expires_at: "2026-07-12T12:00:00.000Z",
    lease_generation: 1,
  });
  const body = `${" ".repeat(maxJsonBytes - wire.length)}${wire}`;
  expect(new TextEncoder().encode(body).byteLength).toBe(maxJsonBytes);

  const result = await client(async () => {
    return new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-length": String(maxJsonBytes),
      },
    });
  }).running(lease, jwt);
  expect(result.running).toBeTrue();
});

test("snapshots a JSON body once and cancels failed reader acquisition", async () => {
  let bodyReads = 0;
  let cancelCalls = 0;
  const primary = new Error("private reader acquisition failure");
  // SAFETY: This deliberately partial stream supplies only the reader and
  // cancellation operations exercised by the failed-acquisition boundary.
  const body: ReadableStream<Uint8Array> = {
    getReader() {
      throw primary;
    },
    cancel() {
      cancelCalls += 1;
    },
  } as never;
  const response = new Response(null, {
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "body", {
    configurable: true,
    get() {
      bodyReads += 1;
      return body;
    },
  });

  const error = await client(async () => response)
    .running(lease, jwt)
    .catch((caught) => caught);
  expect(error).toMatchObject({
    code: "invalid_response",
    cause: {
      name: "ResponseBodyReadError",
      cause: primary,
    },
  });
  expect(bodyReads).toBe(1);
  expect(cancelCalls).toBe(1);
});

test("bounds JSON error envelopes and preserves only safe metadata", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(maxJsonBytes));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const error = await client(async () => {
    return new Response(body, {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-cail-request-id": responseRequestId,
        "x-request-id": responseRequestId,
        "x-should-retry": "false",
      },
    });
  })
    .running(lease, jwt)
    .catch((error) => error);

  expect(error).toMatchObject({
    code: "unknown_error",
    requestId: responseRequestId,
    shouldRetry: false,
    cause: { name: "ResponseBodyReadError" },
  });
  expect(error.message).not.toContain("ResponseBodyReadError");
  expect(cancelled).toBe(true);
});

const cleanupModes = [
  ["resolve"],
  ["reject"],
  ["never"],
  ["throw"],
] as const;

describe.each(cleanupModes)("%s cleanup", (cleanup) => {
  test("does not stall or replace a JSON read failure", async () => {
    const primary = new Error("private JSON read sentinel");
    const tracked = erroredStream(primary, cleanup);
    const diagnostic = spyOn(console, "error").mockImplementation(() => {
      throw new Error("private diagnostic sentinel");
    });
    try {
      const outcome = await Promise.race([
        client(async () => new Response(tracked.stream, { headers: jsonHeaders }))
          .running(lease, jwt)
          .catch((error) => error),
        Bun.sleep(50).then(() => "stalled"),
      ]);
      await Bun.sleep(0);

      expect({ outcome, cancel: tracked.cancelCalls(), release: tracked.releaseCalls() })
        .toMatchObject({
          outcome: {
            code: "invalid_response",
            cause: { name: "ResponseBodyReadError", cause: primary },
          },
          cancel: 1,
          release: 1,
        });
    } finally {
      diagnostic.mockRestore();
    }
  });

  test("does not stall or replace an SSE read failure", async () => {
    const primary = new Error("private SSE read sentinel");
    const tracked = erroredStream(primary, cleanup);
    const diagnostic = spyOn(console, "error").mockImplementation(() => {
      throw new Error("private diagnostic sentinel");
    });
    try {
      const outcome = await Promise.race([
        executeToError(sseErrorResponse(tracked.stream)),
        Bun.sleep(50).then(() => "stalled"),
      ]);
      await Bun.sleep(0);

      expect({ outcome, cancel: tracked.cancelCalls(), release: tracked.releaseCalls() })
        .toMatchObject({
          outcome: { code: "stream_transport_error", cause: primary },
          cancel: 1,
          release: 1,
        });
    } finally {
      diagnostic.mockRestore();
    }
  });

  test("cleans an SSE setup failure without awaiting the body", async () => {
    const primary = new Error("private decoder setup sentinel");
    const tracked = nativeStalledBody(cleanup);
    Object.defineProperty(tracked.body, "pipeThrough", {
      value: () => {
        throw primary;
      },
    });
    const diagnostic = spyOn(console, "error").mockImplementation(() => {
      throw new Error("private diagnostic sentinel");
    });
    try {
      const outcome = await Promise.race([
        executeToError(new Response(tracked.body, { headers: sseHeaders })),
        Bun.sleep(50).then(() => "stalled"),
      ]);
      await Bun.sleep(0);

      expect({ outcome, cancel: tracked.cancelCalls() }).toMatchObject({
        outcome: { code: "stream_transport_error", cause: primary },
        cancel: 1,
      });
    } finally {
      diagnostic.mockRestore();
    }
  });
});

test("does not replace a read failure when releasing its reader throws", async () => {
  const primary = new Error("private reader failure sentinel");
  const tracked = erroredStream(primary, "resolve", "throw");
  const diagnostic = spyOn(console, "error").mockImplementation(() => {
    throw new Error("private diagnostic sentinel");
  });
  try {
    const outcome = await executeToError(sseErrorResponse(tracked.stream));
    expect({ outcome, cancel: tracked.cancelCalls(), release: tracked.releaseCalls() })
      .toMatchObject({
        outcome: { code: "stream_transport_error", cause: primary },
        cancel: 1,
        release: 1,
      });
  } finally {
    diagnostic.mockRestore();
  }
});

test("cancels when a signal aborts during reader acquisition", async () => {
  const controller = new AbortController();
  const reason = new DOMException("caller cancelled", "AbortError");
  const stalled = customStalledReader<ReadableStreamReadResult<Uint8Array>>(
    () => controller.abort(reason),
  );
  const response = responseWithBody(stalled.body, jsonHeaders);
  const outcome = await client(async () => response)
    .running(lease, jwt, { signal: controller.signal })
    .catch((error) => error);

  expect({ outcome, cancel: stalled.cancelCalls(), release: stalled.releaseCalls() })
    .toEqual({ outcome: reason, cancel: 1, release: 1 });
});

test("observes a late provider rejection after caller cancellation", async () => {
  const controller = new AbortController();
  const stalled = customStalledReader<ReadableStreamReadResult<Uint8Array>>();
  const response = responseWithBody(stalled.body, jsonHeaders);
  const unhandled: unknown[] = [];
  const onUnhandled = (cause: unknown) => unhandled.push(cause);
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = client(async () => response).running(lease, jwt, {
      signal: controller.signal,
    });
    await Bun.sleep(0);
    const reason = new DOMException("caller cancelled", "AbortError");
    controller.abort(reason);
    const outcome = await pending.catch((error) => error);
    stalled.rejectRead(new Error("late provider read rejection"));
    await Bun.sleep(0);

    expect({
      outcome,
      cancel: stalled.cancelCalls(),
      cancelReason: stalled.cancelReason(),
      release: stalled.releaseCalls(),
      unhandled,
    }).toEqual({
      outcome: reason,
      cancel: 1,
      cancelReason: reason,
      release: 1,
      unhandled: [],
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("caller cancellation unlocks a native JSON body without awaiting cleanup", async () => {
  const controller = new AbortController();
  const stalled = nativeStalledBody("never");
  const response = new Response(stalled.body, { headers: jsonHeaders });
  const pending = client(async () => response).running(lease, jwt, {
    signal: controller.signal,
  });
  await Bun.sleep(0);
  const reason = new DOMException("caller cancelled", "AbortError");
  controller.abort(reason);
  const outcome = await pending.catch((error) => error);

  expect({
    outcome,
    cancel: stalled.cancelCalls(),
    cancelReason: stalled.cancelReason(),
    locked: stalled.body.locked,
  }).toEqual({ outcome: reason, cancel: 1, cancelReason: reason, locked: false });
});

test("default timeout escapes a native SSE pipeline with throwing cleanup", async () => {
  const stalled = nativeStalledBody("throw");
  const response = new Response(stalled.body, { headers: sseHeaders });
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    const events = await client(async () => response, 5).exec(
      lease,
      operation,
      "true",
      jwt,
    );
    const outcome = await (async () => {
      for await (const event of events) void event;
    })().catch((error) => error);
    expect({
      outcome,
      cancel: stalled.cancelCalls(),
      cancelReason: stalled.cancelReason(),
    }).toMatchObject({
      outcome: { name: "TimeoutError" },
      cancel: 1,
      cancelReason: { name: "TimeoutError" },
    });
  } finally {
    diagnostic.mockRestore();
  }
});

test("classifies parser failures separately from stream transport failures", async () => {
  const error = await executeToError(
    new Response("retry: nope\n\n", { headers: sseHeaders }),
  );
  expect(error).toMatchObject({
    code: "invalid_stream",
    requestId: responseRequestId,
    cause: { name: "ParseError" },
  });
});

test("rejects malformed SSE UTF-8 and preserves valid split UTF-8", async () => {
  const encoder = new TextEncoder();
  const malformed = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: error\ndata: {\"message\":\""));
        controller.enqueue(new Uint8Array([0xff]));
      },
    }),
    { headers: sseHeaders },
  );
  const malformedError = await executeToError(malformed);

  const message = "valid 💚 split";
  const wire = encoder.encode(
    `event: error\ndata: ${JSON.stringify({
      code: "command_failed",
      message,
      request_id: responseRequestId,
    })}\n\n`,
  );
  const marker = encoder.encode("💚");
  const markerStart = wire.findIndex((value, index) =>
    marker.every((part, offset) => wire[index + offset] === part),
  );
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(wire.slice(0, markerStart + 1));
        controller.enqueue(wire.slice(markerStart + 1, markerStart + 3));
        controller.enqueue(wire.slice(markerStart + 3));
        controller.close();
      },
    }),
    { headers: sseHeaders },
  );
  const events = [];
  for await (const event of await client(async () => response).exec(
    lease,
    operation,
    "true",
    jwt,
  )) {
    events.push(event);
  }

  expect({ malformedError, events }).toMatchObject({
    malformedError: {
      code: "stream_transport_error",
      cause: { name: "TypeError" },
    },
    events: [{ type: "error", message, requestId: responseRequestId }],
  });
});

test("reads the SSE response body accessor once", async () => {
  const primary = new Error("private response body accessor sentinel");
  let reads = 0;
  const response = new Response(null, { headers: sseHeaders });
  Object.defineProperty(response, "body", {
    get() {
      reads += 1;
      throw primary;
    },
  });

  const error = await executeToError(response);
  expect({ error, reads }).toMatchObject({
    error: {
      code: "stream_transport_error",
      requestId: responseRequestId,
      cause: primary,
    },
    reads: 1,
  });
});

test("contains correlation reflection failures before fetch", async () => {
  let fetchCalls = 0;
  const correlation = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("private correlation reflection sentinel");
      },
    },
  );
  const boundaryClient = createCailSandboxClient({
    baseUrl: "https://sandbox.invalid",
    app: "boundaries",
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ running: true });
    },
  });
  const error = await boundaryClient
    .running(lease, jwt, {
      // SAFETY: This proxy deliberately crosses the static boundary to verify
      // that malformed correlation cannot reach transport.
      correlation: correlation as never,
    })
    .catch((caught) => caught);

  expect({ error, fetchCalls }).toMatchObject({
    error: {
      code: "invalid_correlation",
      status: 0,
      message: "Invalid CAIL correlation object.",
    },
    fetchCalls: 0,
  });
});
