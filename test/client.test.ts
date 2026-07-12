import { expect, test } from "bun:test";
import {
  CailSandboxError,
  createCailSandboxClient,
  type CailCorrelation,
} from "../src/index";

const jwt = { kind: "jwt" as const, token: "session-token" };
const correlation: CailCorrelation = {
  trace_id: "0af7651916cd43dd8448eb211c80319c",
  span_id: "b7ad6b7169203331",
  request_id: "req-123",
};

test("owns exactly one CAIL credential and app header", async () => {
  let seen!: Request;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale-workbench",
    fetchImpl: async (input, init) => {
      seen = new Request(input, init);
      return Response.json(
        { id: "x", state: "active", expires_at: "later" },
        { status: 201 },
      );
    },
  });
  await client.create(jwt);
  expect(seen.headers.get("x-cail-identity-jwt")).toBe("session-token");
  expect(seen.headers.get("authorization")).toBeNull();
  expect(seen.headers.get("x-cail-app")).toBe("kale-workbench");
  expect("call" in client).toBeFalse();
});

test("forwards cail-log correlation on typed sandbox operations", async () => {
  let seen!: Request;
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async (input, init) => {
      seen = new Request(input, init);
      return Response.json({ running: true, state: "destroying", expires_at: "later" });
    },
  });
  const result = await client.running("box", jwt, { correlation });
  expect(result.state).toBe("destroying");
  expect(seen.headers.get("x-cail-request-id")).toBe("req-123");
  expect(seen.headers.get("traceparent")).toBe(
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  );
  expect(seen.url).toBe("https://x/sandbox/v1/sandbox/box/running");
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
    client.create(jwt, {
      correlation: { ...correlation, request_id: "has spaces" },
    }),
  ).rejects.toMatchObject({ code: "invalid_correlation", status: 0 });
  expect(calls).toBe(0);
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
  expect(await client.readFile("box", "a.bin", jwt)).toBe(original);
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
  const error = await client.running("x", jwt).catch((caught) => caught);
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
  const error = await client.running("x", jwt).catch((caught) => caught);
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
  for await (const event of await client.exec("box", "echo hi", jwt)) {
    output.push(event);
  }
  expect(output[0]).toEqual({
    type: "stdout",
    data: new TextEncoder().encode("hi"),
  });
  expect(output[1]).toEqual({ type: "exit", exitCode: 0 });
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
  for await (const event of await client.exec("box", "echo hi", jwt)) {
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
  const events = await client.exec("box", "long command", jwt);
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
      for await (const event of await client.exec("box", "x", jwt)) void event;
    })(),
  ).rejects.toThrow("unknown event type");
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
      for await (const event of await client.exec("box", "x", jwt)) void event;
    })(),
  ).rejects.toThrow("without a terminal");
});

test("rejects client-side path traversal", async () => {
  const client = createCailSandboxClient({
    baseUrl: "https://x",
    app: "kale",
    fetchImpl: async () => new Response(),
  });
  await expect(client.readFile("box", "../secret", jwt)).rejects.toThrow(
    "workspace-relative",
  );
});
