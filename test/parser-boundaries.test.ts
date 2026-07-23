import { expect, spyOn, test } from "bun:test";
import {
  CailSandboxError,
  createCailSandboxClient,
  type FetchLike,
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

function client(fetchImpl: FetchLike) {
  return createCailSandboxClient({
    baseUrl: "https://sandbox.invalid",
    app: "parser-boundary",
    fetchImpl,
  });
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

  const error = await parser.openapi(jwt).catch((error) => error);
  expect(error).toMatchObject({
    code: "invalid_response",
    cause: { name: "ResponseBodyReadError" },
  });
  expect(cancelled).toBe(true);
});

test("stops a chunked JSON response at the first excess byte", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(maxJsonBytes));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
      return new Promise(() => undefined);
    },
  });
  const parser = client(async () => {
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  });

  const outcome = await Promise.race([
    parser.openapi(jwt).then(
      () => "resolved",
      (error) => error,
    ),
    Bun.sleep(50).then(() => "stalled"),
  ]);
  expect(outcome).not.toBe("stalled");
  expect(outcome).toMatchObject({
    code: "invalid_response",
    cause: { name: "ResponseBodyReadError" },
  });
  expect(cancelled).toBe(true);
});

test("preserves the JSON boundary failure when cleanup rejects", async () => {
  const cleanupSecret = "raw cleanup provider detail";
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maxJsonBytes));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        return Promise.reject(new Error(cleanupSecret));
      },
    });
    const error = await client(async () => {
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    })
      .openapi(jwt)
      .catch((error) => error);
    await Bun.sleep(0);

    expect(error).toMatchObject({
      code: "invalid_response",
      cause: { name: "ResponseBodyReadError" },
    });
    expect(error.message).not.toContain(cleanupSecret);
    expect(diagnostic).toHaveBeenCalledWith({
      event: "cail_sandbox_client.response_cleanup_failed",
      error: "response_cleanup_failed",
      operation: "reader_cancel",
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(cleanupSecret);
  } finally {
    diagnostic.mockRestore();
  }
});

test("does not stall an SSE protocol failure on broken cleanup", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: unknown\ndata: {}\n\n"));
    },
    cancel() {
      return new Promise(() => undefined);
    },
  });
  const execution = client(async () => {
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });

  const outcome = await Promise.race([
    (async () => {
      for await (const event of await execution.exec(
        lease,
        operation,
        "true",
        jwt,
      )) {
        void event;
      }
      return "resolved";
    })().catch((error) => error),
    Bun.sleep(50).then(() => "stalled"),
  ]);

  expect(outcome).not.toBe("stalled");
  expect(outcome).toMatchObject({ code: "invalid_stream" });
});

test("rejects malformed UTF-8 instead of repairing JSON response bytes", async () => {
  const body = new Uint8Array([
    ...new TextEncoder().encode('{"value":"'),
    0xff,
    ...new TextEncoder().encode('"}'),
  ]);
  const error = await client(async () => {
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  })
    .openapi(jwt)
    .catch((error) => error);

  expect(error).toMatchObject({
    code: "invalid_response",
    cause: {
      name: "ResponseBodyReadError",
      cause: { name: "TypeError" },
    },
  });
});

test("accepts an exact-limit JSON response", async () => {
  const empty = JSON.stringify({ padding: "" });
  const body = JSON.stringify({
    padding: "x".repeat(maxJsonBytes - empty.length),
  });
  expect(new TextEncoder().encode(body).byteLength).toBe(maxJsonBytes);

  const result = await client(async () => {
    return new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-length": String(maxJsonBytes),
      },
    });
  }).openapi(jwt);
  expect(result.padding).toHaveLength(maxJsonBytes - empty.length);
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
