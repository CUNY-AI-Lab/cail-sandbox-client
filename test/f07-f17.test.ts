import { expect, test } from "bun:test";
import { createCailSandboxClient, type FetchLike } from "../src/index";

const jwt = { kind: "jwt" as const, token: "session-token" };
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
const responseRequestId = "33333333-3333-4333-8333-333333333333";
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
  return createCailSandboxClient({
    baseUrl: "https://sandbox.invalid",
    app: "f07-f17",
    fetchImpl,
    ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
  });
}

function stalledBody<T>() {
  let rejectRead!: (error: unknown) => void;
  let cancelCalls = 0;
  let releaseCalls = 0;
  let cancelReason: unknown;
  const reading = new Promise<T>((_, reject) => {
    rejectRead = reject;
  });
  const reader = {
    read: () => reading,
    cancel: (reason?: unknown) => {
      cancelCalls += 1;
      cancelReason = reason;
      return new Promise<void>(() => undefined);
    },
    releaseLock: () => {
      releaseCalls += 1;
    },
  };
  const body = {
    getReader: () => reader,
  } as unknown as ReadableStream<Uint8Array>;
  return {
    body,
    rejectRead,
    cancelCalls: () => cancelCalls,
    cancelReason: () => cancelReason,
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

type CleanupBehavior = "resolve" | "throw" | "stall";

function nativeStalledBody(cleanup: CleanupBehavior) {
  let cancelCalls = 0;
  let cancelReason: unknown;
  const pendingPull = new Promise<void>(() => undefined);
  const body = new ReadableStream<Uint8Array>({
    pull: () => pendingPull,
    cancel(reason) {
      cancelCalls += 1;
      cancelReason = reason;
      if (cleanup === "throw") {
        throw new Error("private native cancel sentinel");
      }
      if (cleanup === "stall") return new Promise<void>(() => undefined);
    },
  });
  return {
    body,
    cancelCalls: () => cancelCalls,
    cancelReason: () => cancelReason,
  };
}

type NativeSseBehavior = "cancel-stall" | "late-read-rejection";

function captureNativePipeline(
  stream: ReadableStream<unknown>,
  pipeline: ReadableStream<unknown>[],
) {
  const nativePipeThrough = (
    stream.pipeThrough as unknown as (
      transform: TransformStream<unknown, unknown>,
      options?: StreamPipeOptions,
    ) => ReadableStream<unknown>
  ).bind(stream);
  Object.defineProperty(stream, "pipeThrough", {
    configurable: true,
    value(
      transform: TransformStream<unknown, unknown>,
      options?: StreamPipeOptions,
    ) {
      const next = nativePipeThrough(transform, options);
      pipeline.push(next);
      captureNativePipeline(next, pipeline);
      return next;
    },
  });
}

function nativeSseFixture(behavior: NativeSseBehavior) {
  let cancelCalls = 0;
  let cancelReason: unknown;
  let rejectRead!: (error: unknown) => void;
  let pullStartedResolve!: () => void;
  let cancelAttemptedResolve!: () => void;
  let pendingRead: Promise<void> | undefined;
  const pullStarted = new Promise<void>((resolve) => {
    pullStartedResolve = resolve;
  });
  const cancelAttempted = new Promise<void>((resolve) => {
    cancelAttemptedResolve = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull() {
      pullStartedResolve();
      if (behavior === "late-read-rejection") {
        pendingRead ??= new Promise<void>((_, reject) => {
          rejectRead = reject;
        });
        return pendingRead;
      }
      // A no-op pull leaves the native reader pending while allowing native
      // cancellation to call the underlying source immediately.
    },
    cancel(reason) {
      cancelCalls += 1;
      cancelReason = reason;
      cancelAttemptedResolve();
      if (behavior === "cancel-stall") {
        // The client must not await this provider-controlled cleanup promise.
        return new Promise<void>(() => undefined);
      }
    },
  });
  const pipeline: ReadableStream<unknown>[] = [];
  captureNativePipeline(body as unknown as ReadableStream<unknown>, pipeline);
  return {
    body,
    pipeline,
    pullStarted,
    cancelAttempted,
    rejectRead: (error: unknown) => rejectRead(error),
    cancelCalls: () => cancelCalls,
    cancelReason: () => cancelReason,
  };
}

function stalledSseBody() {
  const stalled = stalledBody<ReadableStreamReadResult<unknown>>();
  const events = {
    getReader: stalled.body.getReader,
    cancel: stalled.body.cancel,
  };
  const body = new ReadableStream<Uint8Array>();
  Object.defineProperty(body, "pipeThrough", {
    value: () => ({
      pipeThrough: () => events,
    }),
  });
  return { ...stalled, body };
}

test("custom stalled JSON reader observes a late provider rejection", async () => {
  const controller = new AbortController();
  const stalled = stalledBody<ReadableStreamReadResult<Uint8Array>>();
  const response = responseWithBody(stalled.body, jsonHeaders);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = client(async () => response).running(lease, jwt, {
      signal: controller.signal,
    });
    await Bun.sleep(0);
    const reason = new DOMException("caller cancelled", "AbortError");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(stalled.cancelCalls()).toBe(1);
    expect(stalled.cancelReason()).toBe(reason);
    expect(stalled.releaseCalls()).toBe(1);

    // A provider may reject the original read after cancellation. The client
    // observed the rejection when it attached the race handler, so this
    // cannot replace or re-open the settled caller outcome.
    stalled.rejectRead(new Error("late provider read rejection"));
    await Bun.sleep(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

test("caller abort unlocks a real JSON body when cleanup stalls", async () => {
  const controller = new AbortController();
  const stalled = nativeStalledBody("stall");
  const response = new Response(stalled.body, { headers: jsonHeaders });
  const pending = client(async () => response).running(lease, jwt, {
    signal: controller.signal,
  });
  await Bun.sleep(0);
  expect(stalled.body.locked).toBe(true);

  const reason = new DOMException("caller cancelled", "AbortError");
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(stalled.cancelCalls()).toBe(1);
  expect(stalled.cancelReason()).toBe(reason);
  expect(stalled.body.locked).toBe(false);
});

test("default timeout races a real SSE parser through cleanup resolve and throw", async () => {
  for (const cleanup of ["resolve", "throw"] as const) {
    const stalled = nativeStalledBody(cleanup);
    const response = new Response(stalled.body, { headers: sseHeaders });
    const events = await client(async () => response, 5).exec(
      lease,
      operation,
      "true",
      jwt,
    );
    const pending = (async () => {
      for await (const event of events) void event;
    })();

    const outcome = await pending.catch((error) => error);
    expect(outcome).toMatchObject({ name: "TimeoutError" });
    expect(stalled.cancelCalls()).toBe(1);
    expect(stalled.cancelReason()).toMatchObject({ name: "TimeoutError" });
    await Bun.sleep(0);
    expect(stalled.body.locked).toBe(false);
  }
});

test("native SSE abort stays prompt when body cancellation stalls", async () => {
  const controller = new AbortController();
  const fixture = nativeSseFixture("cancel-stall");
  const response = new Response(fixture.body, { headers: sseHeaders });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const events = await client(async () => response).exec(
      lease,
      operation,
      "true",
      jwt,
      { signal: controller.signal },
    );
    const pending = (async () => {
      for await (const event of events) void event;
    })();
    await fixture.pullStarted;
    const reason = new DOMException("caller cancelled", "AbortError");
    controller.abort(reason);

    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error) => error,
      ),
      Bun.sleep(100).then(() => "deadline"),
    ]);
    expect(outcome).toBe(reason);
    await fixture.cancelAttempted;
    expect(fixture.cancelCalls()).toBe(1);
    expect(fixture.cancelReason()).toBe(reason);
    expect(fixture.pipeline).toHaveLength(2);
    // The parser output reader releases its lock even though cleanup below
    // never settles. The upstream body/transform lock is allowed to remain
    // held under native WHATWG cancellation semantics in that case.
    expect(fixture.pipeline.at(-1)?.locked).toBe(false);
    expect(fixture.body.locked).toBe(true);
    await Bun.sleep(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

test("native SSE abort observes a late body read rejection", async () => {
  const controller = new AbortController();
  const fixture = nativeSseFixture("late-read-rejection");
  const response = new Response(fixture.body, { headers: sseHeaders });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const events = await client(async () => response).exec(
      lease,
      operation,
      "true",
      jwt,
      { signal: controller.signal },
    );
    const pending = (async () => {
      for await (const event of events) void event;
    })();
    await fixture.pullStarted;
    const reason = new DOMException("caller cancelled", "AbortError");
    controller.abort(reason);

    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error) => error,
      ),
      Bun.sleep(100).then(() => "deadline"),
    ]);
    expect(outcome).toBe(reason);

    // Native cancellation waits for the in-flight pull to settle. Rejecting
    // it after the caller already received the abort must remain observed.
    const lateError = new Error("late provider read rejection");
    fixture.rejectRead(lateError);
    await fixture.cancelAttempted;
    await Bun.sleep(0);
    expect(fixture.cancelCalls()).toBe(1);
    expect(fixture.cancelReason()).toBe(reason);
    expect(fixture.pipeline).toHaveLength(2);
    expect(fixture.pipeline.at(-1)?.locked).toBe(false);
    expect(fixture.body.locked).toBe(false);
    await Bun.sleep(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

test("a stalled custom SSE pipeline still requests one exact cancellation", async () => {
  const stalled = stalledSseBody();
  const response = responseWithBody(stalled.body, sseHeaders);
  const events = await client(async () => response, 5).exec(
    lease,
    operation,
    "true",
    jwt,
  );
  const pending = (async () => {
    for await (const event of events) void event;
  })();

  const outcome = await pending.catch((error) => error);
  expect(outcome).toMatchObject({ name: "TimeoutError" });
  expect(stalled.cancelCalls()).toBe(1);
  expect(stalled.cancelReason()).toMatchObject({ name: "TimeoutError" });
  expect(stalled.releaseCalls()).toBe(1);
});

test("JSON overflow cancels once with the primary boundary error", async () => {
  let cancelCalls = 0;
  let cancelReason: unknown;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65_536));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel(reason) {
      cancelCalls += 1;
      cancelReason = reason;
      return new Promise<void>(() => undefined);
    },
  });

  const response = new Response(body, { headers: jsonHeaders });
  const error = await client(async () => response)
    .running(lease, jwt)
    .catch((caught) => caught);
  expect(error).toMatchObject({
    code: "invalid_response",
    cause: { name: "ResponseBodyReadError" },
  });
  expect(cancelCalls).toBe(1);
  expect(cancelReason).toMatchObject({ name: "ResponseBodyReadError" });
  expect(body.locked).toBe(false);
});

test("cail-log request-id validation accepts only lowercase UUIDv4/v7", async () => {
  const accepted = [
    "33333333-3333-4333-8333-333333333333",
    "018f47a2-6b5f-7cc0-8f31-9b8e1ad2c3d4",
  ];
  const rejected = [
    "33333333-3333-4333-8333-33333333333A",
    "33333333-3333-1333-8333-333333333333",
    "33333333-3333-2333-8333-333333333333",
    "33333333-3333-3333-8333-333333333333",
    "33333333-3333-5333-8333-333333333333",
    "33333333-3333-6333-8333-333333333333",
    "33333333-3333-8333-8333-333333333333",
  ];
  for (const requestId of accepted) {
    const headers = {
      ...jsonHeaders,
      "x-cail-request-id": requestId,
      "x-request-id": requestId,
    };
    const result = await client(async () =>
      Response.json(
        {
          running: true,
          state: "active",
          expires_at: "2026-07-12T12:00:00.000Z",
          lease_generation: 1,
        },
        { headers },
      ),
    ).running(lease, jwt);
    expect(result.running).toBe(true);
  }
  for (const requestId of rejected) {
    const headers = {
      ...jsonHeaders,
      "x-cail-request-id": requestId,
      "x-request-id": requestId,
    };
    await expect(
      client(async () =>
        Response.json(
          {
            running: true,
            state: "active",
            expires_at: "2026-07-12T12:00:00.000Z",
            lease_generation: 1,
          },
          { headers },
        ),
      ).running(lease, jwt),
    ).rejects.toMatchObject({ code: "invalid_response" });
  }
});

test("cail-log request-id validation also fences SSE terminal errors", async () => {
  const accepted = [
    "33333333-3333-4333-8333-333333333333",
    "018f47a2-6b5f-7cc0-8f31-9b8e1ad2c3d4",
  ];
  const rejected = [
    "33333333-3333-6333-8333-333333333333",
    "33333333-3333-8333-8333-333333333333",
  ];
  for (const requestId of accepted) {
    const headers = {
      ...sseHeaders,
      "x-cail-request-id": requestId,
      "x-request-id": requestId,
    };
    const events = await client(
      async () =>
        new Response(
          `event: error\ndata: ${JSON.stringify({
            code: "command_failed",
            message: "No.",
            request_id: requestId,
          })}\n\n`,
          { headers },
        ),
    ).exec(lease, operation, "true", jwt);
    const output = [];
    for await (const event of events) output.push(event);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: "error", requestId });
  }
  for (const requestId of rejected) {
    const headers = {
      ...sseHeaders,
      "x-cail-request-id": responseRequestId,
      "x-request-id": responseRequestId,
    };
    const events = await client(
      async () =>
        new Response(
          `event: error\ndata: ${JSON.stringify({
            code: "command_failed",
            message: "No.",
            request_id: requestId,
          })}\n\n`,
          { headers },
        ),
    ).exec(lease, operation, "true", jwt);
    await expect(
      (async () => {
        for await (const event of events) void event;
      })(),
    ).rejects.toMatchObject({ code: "invalid_stream" });
  }
});
