import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("CI checks the canonical gateway, committed build, package, and secrets", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(workflow).toContain("CUNY-AI-Lab/cail-gateway");
  expect(workflow).toContain("CAIL_GATEWAY_OPENAPI");
  expect(workflow).toContain("secrets.CAIL_GATEWAY_READ_TOKEN");
  expect(workflow).toContain("must grant contents:read access");
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain("bun run check");
  expect(workflow).toContain("bun pm pack --dry-run");
  expect(workflow).toContain("git diff --exit-code -- dist");
  expect(workflow.toLowerCase()).toContain("gitleaks");
});
