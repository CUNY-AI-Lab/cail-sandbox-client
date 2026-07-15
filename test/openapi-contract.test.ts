import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import OPENAPI from "../contract/sandbox-openapi.json";
import PACKAGE from "../package.json";

const CONTRACT_SHA256 =
  "47a662a0073405e727a8dd17e70ed23e78f6eb6819551624934f4d9e8c99f784";

test("pins the reviewed gateway OpenAPI artifact", () => {
  const bytes = readFileSync("contract/sandbox-openapi.json");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    CONTRACT_SHA256,
  );
  expect(OPENAPI.openapi).toBe("3.1.1");
  expect(OPENAPI.info.version).toBe("0.1.0");
  const gateway = new URL(
    "../../cail-gateway/sandbox-bridge/src/openapi.json",
    import.meta.url,
  );
  if (existsSync(gateway)) expect(bytes).toEqual(readFileSync(gateway));
});

test("exports the reviewed OpenAPI artifact as a package subpath", () => {
  expect(PACKAGE.exports["./contract/sandbox-openapi.json"]).toBe(
    "./contract/sandbox-openapi.json",
  );
});

test("an explicitly configured missing gateway contract fails closed", () => {
  const result = Bun.spawnSync(
    ["bun", "run", "scripts/check-gateway-contract.ts"],
    {
      env: {
        ...process.env,
        CAIL_GATEWAY_OPENAPI: "/definitely/missing/cail-openapi.json",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    "Configured gateway OpenAPI does not exist",
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

test("contract exposes no cumulative Sandbox quota or remaining balance", () => {
  expect("headers" in OPENAPI.components).toBeFalse();
  expect(JSON.stringify(OPENAPI)).not.toContain("Sandbox-Quota");
});
