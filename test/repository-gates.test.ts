import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("CI checks the canonical gateway, committed build, package, and secrets", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(workflow).toContain(
    "api.github.com/repos/CUNY-AI-Lab/cail-gateway/contents/sandbox-bridge/src/openapi.json",
  );
  expect(workflow).toContain("CAIL_GATEWAY_OPENAPI");
  expect(workflow).toContain("secrets.CAIL_GATEWAY_READ_TOKEN");
  expect(workflow).toContain("must grant contents:read access");
  expect(workflow).not.toContain("repository: CUNY-AI-Lab/cail-gateway");
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain("bun run check");
  expect(workflow).toContain("bun pm pack --dry-run");
  expect(workflow).toContain("git diff --exit-code -- dist");
  expect(workflow.toLowerCase()).toContain("gitleaks");
});

test("package publishing is reproducible and restricted to GitHub Packages", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    packageManager?: string;
    files?: string[];
    publishConfig?: { access?: string; registry?: string };
    scripts?: { prepublishOnly?: string };
  };
  expect(pkg.packageManager).toBe("bun@1.3.14");
  expect(pkg.files).toContain("CONTRACT.md");
  expect(pkg.publishConfig).toEqual({
    access: "restricted",
    registry: "https://npm.pkg.github.com",
  });
  expect(pkg.scripts?.prepublishOnly).toContain("bun run check");
  expect(pkg.scripts?.prepublishOnly).toContain("git diff --exit-code -- dist");
});
