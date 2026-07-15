import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const localPath = resolve(import.meta.dir, "../contract/sandbox-openapi.json");
const gatewayPath = process.env.CAIL_GATEWAY_OPENAPI ?? resolve(
  import.meta.dir,
  "../../cail-gateway/sandbox-bridge/src/openapi.json",
);
const local = readFileSync(localPath);
const digest = createHash("sha256").update(local).digest("hex");
const expected = "47a662a0073405e727a8dd17e70ed23e78f6eb6819551624934f4d9e8c99f784";

if (process.env.CAIL_GATEWAY_OPENAPI && !existsSync(gatewayPath)) {
  throw new Error(`Configured gateway OpenAPI does not exist: ${gatewayPath}`);
}

if (digest !== expected) {
  throw new Error(
    `Sandbox OpenAPI drift: ${localPath} no longer matches ${expected}`,
  );
}

if (existsSync(gatewayPath) && !local.equals(readFileSync(gatewayPath))) {
  throw new Error(
    `Sandbox OpenAPI drift: ${localPath} must be regenerated from ${gatewayPath}`,
  );
}

console.log(
  `Sandbox OpenAPI synchronized: ${digest}${existsSync(gatewayPath) ? " (gateway compared)" : " (pinned standalone)"}`,
);
