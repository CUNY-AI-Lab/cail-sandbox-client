import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const localPath = resolve(import.meta.dir, "../contract/sandbox-openapi.json");
// The override stays available for a developer pointing at a checkout elsewhere,
// and fails closed when the configured path is absent. It is deliberately NOT
// reachable from the release gate: kale-integration runs consumer guards with a
// sanitized environment, so an ambient value cannot redirect what the gate
// verifies.
const servicePath =
  process.env.CAIL_SANDBOX_SERVICE_OPENAPI ??
  resolve(import.meta.dir, "../../cail-sandbox-service/contract/openapi.json");
const local = readFileSync(localPath);
const digest = createHash("sha256").update(local).digest("hex");
const expected =
  "07f5ba6973b84dec313c22dcfd6877ce58ba909ab96af2ccc3e5e3ea82bd0c26";

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
