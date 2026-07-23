import { expect, spyOn, test } from "bun:test";
import { ParseError } from "eventsource-parser/stream";
import {
  CailSandboxError as DistCailSandboxError,
  createCailSandboxClient as createDistClient,
} from "../dist/index.js";
import {
  CailSandboxError as SourceCailSandboxError,
  createCailSandboxClient as createSourceClient,
} from "../src/index";

const jwt = { kind: "jwt" as const, token: "session-token" };
const requestId = "33333333-3333-4333-8333-333333333333";
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

const runtimes = [
  {
    label: "source",
    create: createSourceClient,
    ErrorClass: SourceCailSandboxError,
  },
  {
    label: "committed dist",
    create: createDistClient,
    ErrorClass: DistCailSandboxError,
  },
] as const;

type CleanupMode = "resolve" | "reject" | "never";

function trackedErroredStream(primary: unknown, cleanup: CleanupMode) {
  let cancelCalls = 0;
  let releaseCalls = 0;
  const cleanupError = new Error("private cleanup sentinel");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(primary);
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
          if (cleanup === "reject") return Promise.reject(cleanupError);
          if (cleanup === "never") return new Promise<void>(() => undefined);
          return Promise.resolve();
        },
      });
      Object.defineProperty(reader, "releaseLock", {
        value: () => {
          releaseCalls += 1;
          releaseLock();
        },
      });
      return reader;
    },
  });
  return {
    stream,
    cleanupError,
    cancelCalls: () => cancelCalls,
    releaseCalls: () => releaseCalls,
  };
}

function jsonResponse(body: ReadableStream<Uint8Array>) {
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "x-cail-request-id": requestId,
      "x-request-id": requestId,
      "x-should-retry": "false",
    },
  });
}

function sseResponseForError(primary: unknown, cleanup: CleanupMode) {
  const tracked = trackedErroredStream(primary, cleanup);
  const responseBody = new ReadableStream<Uint8Array>();
  Object.defineProperty(responseBody, "pipeThrough", {
    value: () => ({
      pipeThrough: () => tracked.stream,
    }),
  });
  return {
    response: new Response(responseBody, {
      headers: {
        "content-type": "text/event-stream",
        "x-cail-request-id": requestId,
        "x-request-id": requestId,
        "x-should-retry": "false",
      },
    }),
    ...tracked,
  };
}

async function executeToError(
  runtime: (typeof runtimes)[number],
  response: Response,
) {
  const client = runtime.create({
    baseUrl: "https://sandbox.invalid",
    app: "runtime-classification",
    fetchImpl: async () => response,
  });
  return (async () => {
    for await (const event of await client.exec(
      lease,
      operation,
      "true",
      jwt,
    )) {
      void event;
    }
  })().catch((error) => error);
}

test("preserves hostile JSON read failures through every cleanup outcome", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {
    throw new Error("private diagnostic sink sentinel");
  });
  try {
    for (const runtime of runtimes) {
      for (const cleanup of ["resolve", "reject", "never"] as const) {
        let prototypeReads = 0;
        const primary = new Proxy(
          {},
          {
            getPrototypeOf() {
              prototypeReads += 1;
              throw new Error("private JSON reflection sentinel");
            },
          },
        );
        const tracked = trackedErroredStream(primary, cleanup);
        const client = runtime.create({
          baseUrl: "https://sandbox.invalid",
          app: "runtime-classification",
          fetchImpl: async () => jsonResponse(tracked.stream),
        });
        const outcome = await Promise.race([
          client.openapi(jwt).catch((error) => error),
          Bun.sleep(50).then(() => "stalled"),
        ]);
        expect(outcome, `${runtime.label}/${cleanup}`).not.toBe("stalled");
        expect(outcome, `${runtime.label}/${cleanup}`).toBeInstanceOf(
          runtime.ErrorClass,
        );
        expect(outcome).toMatchObject({
          code: "invalid_response",
          status: 200,
          requestId,
          shouldRetry: false,
          cause: { name: "ResponseBodyReadError" },
        });
        const responseError = outcome as SourceCailSandboxError;
        expect((responseError.cause as Error).cause).toBe(primary);
        expect(responseError.message).not.toContain("sentinel");
        expect(prototypeReads).toBe(0);
        expect(tracked.cancelCalls()).toBe(1);
        expect(tracked.releaseCalls()).toBe(1);
        expect(tracked.stream.locked).toBeFalse();
      }
    }
    await Bun.sleep(0);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(
      "private cleanup sentinel",
    );
    expect(unhandled).toEqual([]);
  } finally {
    diagnostic.mockRestore();
    process.off("unhandledRejection", onUnhandled);
  }
});

test("contains every hostile SSE classifier stage and preserves metadata", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {
    throw new Error("private diagnostic sink sentinel");
  });
  try {
    for (const runtime of runtimes) {
      let cailPrototypeReads = 0;
      const cailStage = new Proxy(
        {},
        {
          getPrototypeOf() {
            cailPrototypeReads += 1;
            throw new Error("private CailSandboxError reflection sentinel");
          },
        },
      );

      let abortGetterCalls = 0;
      const abortStage = {};
      Object.defineProperty(abortStage, "name", {
        get() {
          abortGetterCalls += 1;
          throw new Error("private AbortError accessor sentinel");
        },
      });

      let parsePrototypeReads = 0;
      const parseStage = new Proxy(
        { name: "not-an-abort" },
        {
          getPrototypeOf() {
            parsePrototypeReads += 1;
            if (parsePrototypeReads === 1) return Object.prototype;
            throw new Error("private ParseError reflection sentinel");
          },
        },
      );

      for (const [stage, primary, cleanup] of [
        ["cail", cailStage, "never"],
        ["abort", abortStage, "reject"],
        ["parse", parseStage, "resolve"],
      ] as const) {
        const tracked = sseResponseForError(primary, cleanup);
        const outcome = await Promise.race([
          executeToError(runtime, tracked.response),
          Bun.sleep(50).then(() => "stalled"),
        ]);
        expect(outcome, `${runtime.label}/${stage}`).not.toBe("stalled");
        expect(outcome, `${runtime.label}/${stage}`).toBeInstanceOf(
          runtime.ErrorClass,
        );
        expect(outcome).toMatchObject({
          code: "stream_transport_error",
          status: 200,
          requestId,
          shouldRetry: false,
          cause: primary,
        });
        expect((outcome as Error).message).not.toContain("sentinel");
        expect(tracked.cancelCalls()).toBe(1);
        expect(tracked.releaseCalls()).toBe(1);
      }

      expect(cailPrototypeReads).toBe(1);
      expect(abortGetterCalls).toBe(0);
      expect(parsePrototypeReads).toBe(1);
    }
    await Bun.sleep(0);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("sentinel");
    expect(unhandled).toEqual([]);
  } finally {
    diagnostic.mockRestore();
    process.off("unhandledRejection", onUnhandled);
  }
});

test("retains genuine typed, AbortError, TimeoutError, and ParseError controls", async () => {
  for (const runtime of runtimes) {
    const typed = await executeToError(
      runtime,
      new Response("event: unknown\ndata: {}\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "x-cail-request-id": requestId,
          "x-request-id": requestId,
          "x-should-retry": "false",
        },
      }),
    );
    expect(typed).toBeInstanceOf(runtime.ErrorClass);
    expect(typed).toMatchObject({ code: "invalid_stream", requestId });

    for (const name of ["AbortError", "TimeoutError"] as const) {
      const primary = new DOMException("authoritative cancellation", name);
      const tracked = sseResponseForError(primary, "resolve");
      const outcome = await executeToError(runtime, tracked.response);
      expect(outcome, `${runtime.label}/${name}`).toBe(primary);
      expect(tracked.cancelCalls()).toBe(1);
      expect(tracked.releaseCalls()).toBe(1);
    }

    const parseError = await executeToError(
      runtime,
      new Response("retry: nope\n\n", {
        headers: {
          "content-type": "text/event-stream",
          "x-cail-request-id": requestId,
          "x-request-id": requestId,
          "x-should-retry": "false",
        },
      }),
    );
    expect(parseError).toBeInstanceOf(runtime.ErrorClass);
    expect(parseError).toMatchObject({
      code: "invalid_stream",
      requestId,
      cause: { name: "ParseError" },
    });
    expect((parseError as SourceCailSandboxError).cause).toBeInstanceOf(
      ParseError,
    );
  }
});

test("contains hostile correlation failures before fetch", async () => {
  for (const runtime of runtimes) {
    let fetchCalls = 0;
    let rejectedPrototypeReads = 0;
    const rejected = new Proxy(
      {},
      {
        getPrototypeOf() {
          rejectedPrototypeReads += 1;
          throw new Error("private correlation reflection sentinel");
        },
      },
    );
    const correlation = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw rejected;
        },
      },
    );
    const client = runtime.create({
      baseUrl: "https://sandbox.invalid",
      app: "runtime-classification",
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ openapi: "3.1.1" });
      },
    });
    const error = await client
      .openapi(jwt, {
        correlation: correlation as never,
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(runtime.ErrorClass);
    expect(error).toMatchObject({
      code: "invalid_correlation",
      status: 0,
    });
    expect(error.message).toBe("Invalid CAIL correlation object.");
    expect(error.message).not.toContain("sentinel");
    expect(rejectedPrototypeReads).toBe(2);
    expect(fetchCalls).toBe(0);
  }
});

test("retains a bounded ordinary correlation validation message", async () => {
  for (const runtime of runtimes) {
    const client = runtime.create({
      baseUrl: "https://sandbox.invalid",
      app: "runtime-classification",
      fetchImpl: async () => Response.json({ openapi: "3.1.1" }),
    });
    const error = await client
      .openapi(jwt, {
        correlation: {
          trace_id: "bad",
          span_id: "b7ad6b7169203331",
          trace_flags: 1,
          request_id: requestId,
        },
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(runtime.ErrorClass);
    expect(error).toMatchObject({ code: "invalid_correlation", status: 0 });
    expect(error.message).toBe(
      "cail-log: trace_id must be 32 lowercase hex chars, not all-zero",
    );
  }
});
