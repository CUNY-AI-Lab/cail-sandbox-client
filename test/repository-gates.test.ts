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
    manifestVersion: string;
    artifactKind: string;
    publishedVersionClaim: boolean;
    sourceCommit: string;
    sourceTree: string;
    tarball: string;
    tarballBytes: number;
    tarballSha256: string;
    contractSha256: string;
  };
  const tarball = readFileSync(`vendor/${provenance.tarball}`);
  const vendoredPackage = JSON.parse(
    readFileSync("vendor/cail-log/package.json", "utf8"),
  ) as { name?: string; version?: string };
  expect(provenance).toMatchObject({
    manifestVersion: "0.6.0",
    artifactKind: "unpublished-source-build",
    publishedVersionClaim: false,
    sourceCommit: "cb6ffc0cfd4cb544639cbf288ff6eb24c7027e98",
    sourceTree: "618c4bdfae0effadbe23cfd6c4dfb1fcf6440697",
    tarball:
      "cuny-ai-lab-cail-log-0.6.0-cb6ffc0-8689422456eb4b7c.tgz",
    tarballBytes: 50_269,
    tarballSha256:
      "8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215",
    contractSha256:
      "4289398fe59affe1181789d111b779365fed951290ad07dd687061a681d299b1",
  });
  expect(tarball.byteLength).toBe(provenance.tarballBytes);
  expect(createHash("sha256").update(tarball).digest("hex")).toBe(
    provenance.tarballSha256,
  );
  const archivedContract = Bun.spawnSync([
    "tar",
    "-xOf",
    `vendor/${provenance.tarball}`,
    "package/contract/operational-event-v2.json",
  ]);
  expect(archivedContract.exitCode).toBe(0);
  expect(
    createHash("sha256").update(archivedContract.stdout).digest("hex"),
  ).toBe(provenance.contractSha256);
  expect(vendoredPackage).toMatchObject({
    name: "@cuny-ai-lab/cail-log",
    version: provenance.manifestVersion,
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
