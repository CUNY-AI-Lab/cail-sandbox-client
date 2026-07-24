import { expect, test } from "bun:test";
import {
  correlationFromHeaders,
  createCailSandboxClient,
  type CailCorrelation,
  type CailSandboxClient,
  type SandboxClientOptions,
} from "../dist/index.js";

const JWT = { kind: "jwt" as const, token: "black-box-session-token" };
const REQUEST_ID_V7 = "018f47a2-6b5f-7cc0-8f31-9b8e1ad2c3d4";
const LEASE = {
  id: "11111111-1111-4111-8111-111111111111",
  leaseCapability: "lease-capability-00000000000000000000001",
  leaseGeneration: 1,
};
const CORRELATION: CailCorrelation = {
  trace_id: "0af7651916cd43dd8448eb211c80319c",
  span_id: "b7ad6b7169203331",
  trace_flags: 1,
  request_id: REQUEST_ID_V7,
};

type LifecycleClient = Pick<
  CailSandboxClient,
  "create" | "running" | "destroy"
>;
type LifecycleFactory = (options: SandboxClientOptions) => LifecycleClient;

async function probeLifecycle(
  factory: LifecycleFactory,
  onStop?: (requests: readonly Request[]) => void,
): Promise<Request[]> {
  const requests: Request[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === "/sandbox/v1/sandbox"
      ) {
        return Response.json(
          {
            id: LEASE.id,
            state: "active",
            expires_at: "2026-07-24T12:00:00.000Z",
            lease_capability: LEASE.leaseCapability,
            lease_generation: LEASE.leaseGeneration,
            profile: "offline-code",
            instance_class: "lite",
          },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === `/sandbox/v1/sandbox/${LEASE.id}/running`
      ) {
        return Response.json({
          running: true,
          state: "active",
          expires_at: "2026-07-24T12:00:00.000Z",
          lease_generation: LEASE.leaseGeneration,
        });
      }
      if (
        request.method === "DELETE" &&
        url.pathname === `/sandbox/v1/sandbox/${LEASE.id}`
      ) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "unexpected probe route" }, { status: 500 });
    },
  });

  try {
    const client = factory({
      baseUrl: `http://${server.hostname}:${server.port}`,
      app: "black-box-probe",
    });
    const lease = await client.create(
      {
        scopeKey: "scope-key-000000000000000000000000000001",
        idempotencyKey: "create-key-0000000000000000000000000001",
        profile: "offline-code",
      },
      JWT,
      { correlation: CORRELATION },
    );
    await client.running(lease, JWT, { correlation: CORRELATION });
    await client.destroy(lease, JWT, { correlation: CORRELATION });
    return requests;
  } finally {
    onStop?.(requests);
    server.stop(true);
  }
}

test("public dist adopts and propagates UUIDv7 through the lifecycle", async () => {
  expect(
    correlationFromHeaders(
      new Headers({ "x-cail-request-id": REQUEST_ID_V7 }),
    ).request_id,
  ).toBe(REQUEST_ID_V7);

  const requests = await probeLifecycle(createCailSandboxClient);
  expect(requests.map((request) => request.method)).toEqual([
    "POST",
    "GET",
    "DELETE",
  ]);
  for (const request of requests) {
    expect(request.headers.get("x-cail-request-id")).toBe(REQUEST_ID_V7);
    expect(request.headers.get("x-cail-identity-jwt")).toBe(JWT.token);
    expect(request.headers.get("x-cail-app")).toBe("black-box-probe");
  }
});

test("the lifecycle probe rejects a realistic UUIDv4-only client control", async () => {
  let observedRequests = -1;
  const uuidV4OnlyFactory: LifecycleFactory = (options) => {
    const client = createCailSandboxClient(options);
    return {
      ...client,
      async create(input, credential, callOptions) {
        if (
          callOptions?.correlation &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            callOptions.correlation.request_id,
          )
        ) {
          throw new TypeError(
            "broken control: request_id must be a lowercase UUID v4",
          );
        }
        return client.create(input, credential, callOptions);
      },
    };
  };

  await expect(
    probeLifecycle(uuidV4OnlyFactory, (requests) => {
      observedRequests = requests.length;
    }),
  ).rejects.toThrow("broken control: request_id must be a lowercase UUID v4");
  expect(observedRequests).toBe(0);
});
