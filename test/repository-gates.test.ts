import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

test("CI checks release authority, the contract, committed build, package, and secrets", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(workflow).not.toContain("CAIL_SANDBOX_SERVICE_OPENAPI");
  expect(workflow).toContain(
    "bun install --frozen-lockfile --ignore-scripts",
  );
  expect(workflow).toContain("bun run check");
  expect(workflow).toContain("bun pm pack --dry-run --ignore-scripts");
  expect(workflow).toContain("git diff --exit-code -- dist");
  expect(workflow.toLowerCase()).toContain("gitleaks");
});

test("package is a truthful 0.1.1 successor using published Log 0.6.0", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    packageManager?: string;
    files?: string[];
    publishConfig?: { access?: string; registry?: string };
    scripts?: {
      check?: string;
      prepublishOnly?: string;
    };
  };
  expect(pkg).toMatchObject({
    name: "@cuny-ai-lab/cail-sandbox-client",
    version: "0.1.1",
    packageManager: "bun@1.3.14",
  });
  expect(pkg.files).toContain("CONTRACT.md");
  expect(pkg.files).not.toContain("vendor");
  expect(pkg.dependencies?.["@cuny-ai-lab/cail-log"]).toBe("0.6.0");
  expect(pkg.publishConfig).toEqual({
    access: "restricted",
    registry: "https://npm.pkg.github.com",
  });
  expect(pkg.scripts?.check?.split(" && ")[0]).toBe(
    "bun run check:release-authority",
  );
  expect(pkg.scripts?.check).toContain("bun run check:dist");
  expect(pkg.scripts?.check?.indexOf("bun run check:dist")).toBeLessThan(
    pkg.scripts?.check?.indexOf("bun run build") ?? -1,
  );
  expect(pkg.scripts?.prepublishOnly).toContain("bun run check");
  expect(pkg.scripts?.prepublishOnly).toContain(
    "bun run check:clean",
  );
  expect(pkg.scripts?.prepublishOnly).toContain(
    "bun run check:release-live",
  );
  expect(pkg.scripts?.prepublishOnly).toContain(
    "git diff --exit-code -- dist",
  );
});

test("records immutable published package receipts without claiming 0.1.1 publication", () => {
  const receipt = JSON.parse(
    readFileSync("evidence/registry-publications.json", "utf8"),
  ) as {
    registry: string;
    published: Record<
      string,
      {
        version: string;
        packageVersionId: number;
        tarballSha256: string;
      }
    >;
    candidate: {
      package: string;
      version: string;
      publishedVersionClaim: boolean;
      reason: string;
    };
  };
  expect(receipt.registry).toBe("https://npm.pkg.github.com");
  expect(receipt.published["@cuny-ai-lab/cail-sandbox-client"]).toMatchObject({
    version: "0.1.0",
    packageVersionId: 1_066_310_089,
    tarballSha256:
      "9a67fa01cdf2ce2b5323a6d2cca75d2b96a8c0e85ab1ce58b1eea6509f393db7",
  });
  expect(receipt.published["@cuny-ai-lab/cail-log"]).toMatchObject({
    version: "0.6.0",
    packageVersionId: 1_066_236_862,
    tarballSha256:
      "8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215",
  });
  expect(receipt.candidate).toEqual({
    package: "@cuny-ai-lab/cail-sandbox-client",
    version: "0.1.1",
    publishedVersionClaim: false,
    reason: "compatible release hardening after immutable 0.1.0 publication",
  });
});

test("published Log tarball, provenance, lock, and installed package agree", () => {
  const provenance = JSON.parse(
    readFileSync("vendor/cail-log.provenance.json", "utf8"),
  ) as {
    manifestVersion: string;
    artifactKind: string;
    publishedVersionClaim: boolean;
    registryPackageVersionId: number;
    tarball: string;
    tarballBytes: number;
    tarballSha256: string;
  };
  const tarball = readFileSync(`vendor/${provenance.tarball}`);
  const installed = JSON.parse(
    readFileSync("node_modules/@cuny-ai-lab/cail-log/package.json", "utf8"),
  ) as { name?: string; version?: string };
  const lock = readFileSync("bun.lock", "utf8");

  expect(provenance).toMatchObject({
    manifestVersion: "0.6.0",
    artifactKind: "published-registry-package",
    publishedVersionClaim: true,
    registryPackageVersionId: 1_066_236_862,
    tarballBytes: 50_269,
    tarballSha256:
      "8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215",
  });
  expect(tarball.byteLength).toBe(provenance.tarballBytes);
  expect(createHash("sha256").update(tarball).digest("hex")).toBe(
    provenance.tarballSha256,
  );
  expect(installed).toMatchObject({
    name: "@cuny-ai-lab/cail-log",
    version: "0.6.0",
  });
  expect(lock).toContain(
    "https://npm.pkg.github.com/download/@cuny-ai-lab/cail-log/0.6.0/632c8a3d74bc4709c23b9636b73471c1291d7679",
  );
  expect(lock).not.toContain("file:../cail-log");
  expect(lock).not.toContain("@cuny-ai-lab/cail-log@0.4.0");
});
