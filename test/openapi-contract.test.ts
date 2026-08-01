import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import OPENAPI from "../contract/sandbox-openapi.json";
import PACKAGE from "../package.json";

const CONTRACT_SHA256 =
  "07f5ba6973b84dec313c22dcfd6877ce58ba909ab96af2ccc3e5e3ea82bd0c26";

test("pins the reviewed Sandbox service OpenAPI artifact", () => {
  const bytes = readFileSync("contract/sandbox-openapi.json");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    CONTRACT_SHA256,
  );
  expect(OPENAPI.openapi).toBe("3.1.1");
  expect(OPENAPI.info.version).toBe("0.1.0");
  const service =
    process.env.CAIL_SANDBOX_SERVICE_OPENAPI ??
    new URL(
      "../../cail-sandbox-service/contract/openapi.json",
      import.meta.url,
    );
  if (existsSync(service)) expect(bytes).toEqual(readFileSync(service));
});

test("exports the reviewed OpenAPI artifact as a package subpath", () => {
  expect(PACKAGE.exports["./contract/sandbox-openapi.json"]).toBe(
    "./contract/sandbox-openapi.json",
  );
});

test("an explicitly configured missing service contract fails closed", () => {
  const result = Bun.spawnSync(
    ["bun", "run", "scripts/check-service-contract.ts"],
    {
      env: {
        ...process.env,
        CAIL_SANDBOX_SERVICE_OPENAPI: "/definitely/missing/cail-openapi.json",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    "Configured Sandbox service OpenAPI does not exist",
  );
});

test("thin client wraps every authenticated sandbox operation", () => {
  const client = readFileSync("src/index.ts", "utf8");
  const operationIds = Object.values(OPENAPI.paths).flatMap((item) =>
    Object.values(item).flatMap((operation) =>
      typeof operation === "object" &&
      operation !== null &&
      "operationId" in operation
        ? [String(operation.operationId)]
        : [],
    ),
  );
  expect(new Set(operationIds)).toEqual(
    new Set([
      "health",
      "getOpenApi",
      "getSandboxUsage",
      "getSandboxSettlement",
      "createSandbox",
      "destroySandbox",
      "isSandboxRunning",
      "execCommand",
      "readFile",
      "writeFile",
      "createSession",
      "destroySession",
    ]),
  );
  expect(client).not.toContain("health(");
  for (const method of [
    "create(",
    "running(",
    "destroy(",
    "usage(",
    "settlement(",
    "exec(",
    "readFile(",
    "writeFile(",
    "createSession(",
    "destroySession(",
    "openapi(",
  ]) {
    expect(client).toContain(method);
  }
  for (const forbidden of [
    "mount(",
    "persist(",
    "hydrate(",
    "pty(",
    "tunnel(",
    "keepAlive",
    "pool(",
  ]) {
    expect(client).not.toContain(forbidden);
  }
});

test("filtered OpenAPI retains raw files, explicit sessions, and error headers", () => {
  const file = OPENAPI.paths["/sandbox/v1/sandbox/{id}/file/{path}"];
  expect(file).toHaveProperty("get");
  expect(file).toHaveProperty("put");
  expect(OPENAPI.paths).toHaveProperty("/sandbox/v1/sandbox/{id}/session");
  expect(OPENAPI.components.parameters).toHaveProperty("LeaseCapability");
  expect(OPENAPI.components.parameters).toHaveProperty("OperationCapability");
  expect(OPENAPI.components.schemas).toHaveProperty("CreateSandboxRequest");
  expect(OPENAPI.components.schemas).toHaveProperty("CreateSessionRequest");
  expect(OPENAPI.components.responses.Error.headers).toHaveProperty(
    "X-CAIL-Request-Id",
  );
  expect(OPENAPI.components.responses.Error.headers).toHaveProperty(
    "x-request-id",
  );
  expect(OPENAPI.components.responses.Error.headers).toHaveProperty(
    "x-should-retry",
  );
  expect(file.get.description).toContain("ready or terminal");
  expect(file.get.description).toContain("409 operation_state");
  expect(file.put.description).toContain("while the operation is ready");
  expect(file.put.description).toContain("409 operation_state");
  expect(file.put.description).toContain("file_write_ambiguous");
  expect(
    OPENAPI.components.schemas.ErrorObject.properties.code.description,
  ).toContain("file_write_ambiguous");
});

test("service auth contract requires the canonical RS256 identity JWT", () => {
  expect(OPENAPI.components.securitySchemes).toHaveProperty("identityJwt");
  expect(OPENAPI.components.securitySchemes.identityJwt.description).toContain(
    "RS256 CAIL identity JWT",
  );
  expect(OPENAPI.components.securitySchemes).not.toHaveProperty("bearerAuth");
  expect(JSON.stringify(OPENAPI)).not.toContain("x-cail-poc-auth-override");
});

test("contract exposes aggregate and immutable settled usage", () => {
  expect(OPENAPI.paths).toHaveProperty("/sandbox/v1/usage");
  expect(OPENAPI.paths).toHaveProperty("/sandbox/v1/usage/{leaseId}");
  expect(OPENAPI.components.schemas.Usage.properties.unit).toEqual({
    const: "mib_milliseconds",
  });
  expect(OPENAPI.components.schemas.Settlement.properties.quantity).toEqual({
    type: "integer",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  });
});

test("contract fixes one strict JSON shape for command output events", () => {
  const response =
    OPENAPI.paths["/sandbox/v1/sandbox/{id}/exec"].post.responses["200"];
  expect(response["x-cail-sse-events"].stdout).toEqual({
    $ref: "#/components/schemas/ExecOutputEvent",
  });
  expect(OPENAPI.components.schemas.ExecOutputEvent).toMatchObject({
    type: "object",
    required: ["data"],
    additionalProperties: false,
  });
  expect(
    response.content["text/event-stream"].schema.description,
  ).toContain("never bare base64");
});
