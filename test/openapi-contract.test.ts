import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import OPENAPI from "../contract/sandbox-openapi.json";

const CONTRACT_SHA256 =
  "3525c9bd2b0a3655051a1d8aaf93d70ad9b584259dcc43b045c8664294d61661";

test("pins the reviewed gateway OpenAPI artifact", () => {
  const bytes = readFileSync("contract/sandbox-openapi.json");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    CONTRACT_SHA256,
  );
  expect(OPENAPI.openapi).toBe("3.1.1");
  expect(OPENAPI.info.version).toBe("0.0.1");
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
