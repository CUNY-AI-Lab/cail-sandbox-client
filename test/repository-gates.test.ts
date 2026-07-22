import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

test("CI checks the pinned contract, committed build, package, and secrets", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(workflow).not.toContain("CAIL_SANDBOX_SERVICE_OPENAPI");
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain("bun run check");
  expect(workflow).toContain("bun pm pack --dry-run");
  expect(workflow).toContain("git diff --exit-code -- dist");
  expect(workflow.toLowerCase()).toContain("gitleaks");
});

test("package publishing is reproducible and restricted to GitHub Packages", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    packageManager?: string;
    files?: string[];
    publishConfig?: { access?: string; registry?: string };
    scripts?: { prepublishOnly?: string };
  };
  expect(pkg.packageManager).toBe("bun@1.3.5");
  expect(pkg.files).toContain("CONTRACT.md");
  expect(pkg.files).toContain("vendor");
  expect(pkg.dependencies?.["@cuny-ai-lab/cail-log"]).toBeUndefined();
  expect(pkg.publishConfig).toEqual({
    access: "restricted",
    registry: "https://npm.pkg.github.com",
  });
  expect(pkg.scripts?.prepublishOnly).toContain("bun run check");
  expect(pkg.scripts?.prepublishOnly).toContain("git diff --exit-code -- dist");
});

test("vendors the exact accepted cail-log source package", () => {
  const provenance = JSON.parse(
    readFileSync("vendor/cail-log.provenance.json", "utf8"),
  ) as {
    sourceCommit: string;
    tarball: string;
    tarballSha256: string;
    contractSha256: string;
  };
  const tarball = readFileSync(`vendor/${provenance.tarball}`);
  const vendoredPackage = JSON.parse(
    readFileSync("vendor/cail-log/package.json", "utf8"),
  ) as { name?: string; version?: string };
  expect(provenance.sourceCommit).toBe(
    "482b2a102fddac589d6db8a03cbea171df819872",
  );
  expect(provenance.contractSha256).toBe(
    "3bf46b9810bbe06d8311f28d6491c78c02455a07b27f0ff46dfa5843478ee0ad",
  );
  expect(createHash("sha256").update(tarball).digest("hex")).toBe(
    provenance.tarballSha256,
  );
  expect(vendoredPackage).toMatchObject({
    name: "@cuny-ai-lab/cail-log",
    version: "0.6.0",
  });
  const extractedFiles = [
    "package.json",
    ...readdirSync("vendor/cail-log/dist").map((name) => `dist/${name}`),
  ];
  for (const file of extractedFiles) {
    const archived = Bun.spawnSync([
      "tar",
      "-xOf",
      `vendor/${provenance.tarball}`,
      `package/${file}`,
    ]);
    expect(archived.exitCode).toBe(0);
    expect(Buffer.from(archived.stdout)).toEqual(
      readFileSync(`vendor/cail-log/${file}`),
    );
  }
});
