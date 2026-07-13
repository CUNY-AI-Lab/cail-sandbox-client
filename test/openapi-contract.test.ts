import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import OPENAPI from "../contract/sandbox-openapi.json";

const CONTRACT_SHA256 =
  "b615f296796b91d5570636013e897a5ae6771afff83b173b216ec6658458edc5";

test("pins the reviewed gateway OpenAPI artifact", () => {
  const bytes = readFileSync("contract/sandbox-openapi.json");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    CONTRACT_SHA256,
  );
  expect(OPENAPI.openapi).toBe("3.1.1");
  expect(OPENAPI.info.version).toBe("0.1.0");
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
});

test("production auth contract excludes personal keys and declares canonical RS256 identity", () => {
  expect(OPENAPI.components.securitySchemes).toHaveProperty("identityJwt");
  expect(OPENAPI.components.securitySchemes).not.toHaveProperty("identityJwtV2");
  expect(OPENAPI.components.securitySchemes.identityJwt.description).toContain(
    "RS256 CAIL session JWT",
  );
  expect(OPENAPI.components.securitySchemes.bearerAuth.description).toContain(
    "delegated CAIL key",
  );
  expect(OPENAPI.components.securitySchemes.bearerAuth.description).toContain(
    "personal keys",
  );
  expect(JSON.stringify(OPENAPI)).not.toContain("x-cail-poc-auth-override");
});

test("sandbox quota contract is enforce-only", () => {
  expect(OPENAPI.components.headers.SandboxQuotaMode.schema).toEqual({
    const: "enforce",
  });
});
