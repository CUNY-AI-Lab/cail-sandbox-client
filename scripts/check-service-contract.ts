import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const localPath = resolve(import.meta.dir, "../contract/sandbox-openapi.json");
const servicePath =
  process.env.CAIL_SANDBOX_SERVICE_OPENAPI ??
  resolve(import.meta.dir, "../../cail-sandbox-service/contract/openapi.json");
const local = readFileSync(localPath);
const digest = createHash("sha256").update(local).digest("hex");
const expected =
  "d4a9179e1b57e345763ef505abc4cbc5f05be7dbbca5673edd2a7a159bdcad80";

if (process.env.CAIL_SANDBOX_SERVICE_OPENAPI && !existsSync(servicePath)) {
  throw new Error(
    `Configured Sandbox service OpenAPI does not exist: ${servicePath}`,
  );
}

if (digest !== expected) {
  throw new Error(
    `Sandbox OpenAPI drift: ${localPath} no longer matches ${expected}`,
  );
}

if (existsSync(servicePath) && !local.equals(readFileSync(servicePath))) {
  throw new Error(
    `Sandbox OpenAPI drift: ${localPath} must match ${servicePath}`,
  );
}

console.log(
  `Sandbox OpenAPI synchronized: ${digest}${existsSync(servicePath) ? " (service compared)" : " (pinned standalone)"}`,
);
