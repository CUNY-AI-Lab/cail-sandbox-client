import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
const fail = (message: string): never => {
  throw new Error(`Sandbox Client release authority: ${message}`);
};

const expectedLog = {
  version: "0.6.0",
  packageVersionId: 1_066_236_862,
  publishedAt: "2026-07-25T16:40:58Z",
  tarballBytes: 50_269,
  tarballSha1: "632c8a3d74bc4709c23b9636b73471c1291d7679",
  tarballSha256:
    "8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215",
  reviewedSourceCommit: "cb6ffc0cfd4cb544639cbf288ff6eb24c7027e98",
  reviewedSourceTree: "618c4bdfae0effadbe23cfd6c4dfb1fcf6440697",
  publishedSourceCommit: "7d093f4c4d28367056c5124889a283d5ff9908c4",
  publishedSourceTree: "b0150aa34f31de914a9a32493c5abf3bb4d5ad43",
};
const expectedPublishedClient = {
  version: "0.1.0",
  packageVersionId: 1_066_310_089,
  publishedAt: "2026-07-25T17:28:03Z",
  tarballBytes: 97_671,
  tarballSha1: "e344844a09b745e46f4eb5f5ef6e4da8d744e0b8",
  tarballSha256:
    "9a67fa01cdf2ce2b5323a6d2cca75d2b96a8c0e85ab1ce58b1eea6509f393db7",
  sourceTag: "v0.1.0",
  sourceCommit: "e6926d2c7d425ac27f5a4bd3b81ad2e844574f34",
  sourceTree: "d6b8bcde833b8ac300b5401a5d8bc3ffe0ed511a",
};

const pkg = readJson<{
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  files?: string[];
}>("package.json");
if (pkg.name !== "@cuny-ai-lab/cail-sandbox-client") {
  fail("unexpected package name");
}
if (pkg.version !== "0.1.1") fail("candidate version must be 0.1.1");
if (pkg.dependencies?.["@cuny-ai-lab/cail-log"] !== "0.6.0") {
  fail("CAIL Log must be an exact 0.6.0 dependency");
}
if (pkg.files?.includes("vendor")) {
  fail("review evidence must not ship inside the Client package");
}

const receipt = readJson<{
  schemaVersion?: number;
  registry?: string;
  published?: Record<string, unknown>;
  candidate?: {
    package?: string;
    version?: string;
    publishedVersionClaim?: boolean;
  };
}>("evidence/registry-publications.json");
if (receipt.schemaVersion !== 1) fail("unsupported receipt schema");
if (receipt.registry !== "https://npm.pkg.github.com") {
  fail("unexpected registry");
}
if (
  JSON.stringify(receipt.published?.["@cuny-ai-lab/cail-log"]) !==
  JSON.stringify(expectedLog)
) {
  fail("published CAIL Log receipt drift");
}
if (
  JSON.stringify(receipt.published?.["@cuny-ai-lab/cail-sandbox-client"]) !==
  JSON.stringify(expectedPublishedClient)
) {
  fail("published Sandbox Client 0.1.0 receipt drift");
}
if (
  receipt.candidate?.package !== "@cuny-ai-lab/cail-sandbox-client" ||
  receipt.candidate.version !== "0.1.1" ||
  receipt.candidate.publishedVersionClaim !== false
) {
  fail("the 0.1.1 candidate must not claim publication");
}

const lock = readFileSync(resolve(root, "bun.lock"), "utf8");
const expectedLock =
  '"@cuny-ai-lab/cail-log": ["@cuny-ai-lab/cail-log@0.6.0", "https://npm.pkg.github.com/download/@cuny-ai-lab/cail-log/0.6.0/632c8a3d74bc4709c23b9636b73471c1291d7679", {}, "sha512-Hlj1K7TXL2XOI6nOkh5SKRafCldr87Zp+aHm73MqiV0hajAPMiqp7QuBlndzok7Vy0fIX7C6msi093s/a9Yesw=="]';
if (!lock.includes(expectedLock)) fail("CAIL Log registry lock drift");
if (
  /@cuny-ai-lab\/cail-log[^ \n]*.*(?:file:|git\+|github:|\^0\.6|~0\.6)/.test(
    lock,
  )
) {
  fail("CAIL Log lock contains a mutable or local authority");
}

const provenance = readJson<{
  artifactKind?: string;
  publishedVersionClaim?: boolean;
  registryPackageVersionId?: number;
  publishedAt?: string;
  registryTarballSha1?: string;
  tarball?: string;
  tarballBytes?: number;
  tarballSha256?: string;
}>("vendor/cail-log.provenance.json");
if (
  provenance.artifactKind !== "published-registry-package" ||
  provenance.publishedVersionClaim !== true ||
  provenance.registryPackageVersionId !== expectedLog.packageVersionId ||
  provenance.publishedAt !== expectedLog.publishedAt ||
  provenance.registryTarballSha1 !== expectedLog.tarballSha1 ||
  provenance.tarballBytes !== expectedLog.tarballBytes ||
  provenance.tarballSha256 !== expectedLog.tarballSha256
) {
  fail("CAIL Log provenance drift");
}
const provenanceTarball =
  provenance.tarball ?? fail("CAIL Log tarball path is missing");
const tarballPath = resolve(root, "vendor", provenanceTarball);
const tarball = readFileSync(tarballPath);
if (
  tarball.byteLength !== expectedLog.tarballBytes ||
  createHash("sha256").update(tarball).digest("hex") !==
    expectedLog.tarballSha256
) {
  fail("CAIL Log tarball bytes do not match the published receipt");
}

const installedRoot = resolve(
  root,
  "node_modules/@cuny-ai-lab/cail-log",
);
if (!existsSync(installedRoot)) fail("installed CAIL Log package is missing");
const installedPackage = readJson<{ name?: string; version?: string }>(
  "node_modules/@cuny-ai-lab/cail-log/package.json",
);
if (
  installedPackage.name !== "@cuny-ai-lab/cail-log" ||
  installedPackage.version !== "0.6.0"
) {
  fail("installed CAIL Log package identity drift");
}

const listing = Bun.spawnSync(["tar", "-tzf", tarballPath]);
if (listing.exitCode !== 0) fail("could not inspect the reviewed Log tarball");
const files = new TextDecoder()
  .decode(listing.stdout)
  .split("\n")
  .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"));
for (const entry of files) {
  const relative = entry.slice("package/".length);
  const extracted = Bun.spawnSync(["tar", "-xOf", tarballPath, entry]);
  const installedPath = resolve(installedRoot, relative);
  if (
    extracted.exitCode !== 0 ||
    !existsSync(installedPath) ||
    !Buffer.from(extracted.stdout).equals(readFileSync(installedPath))
  ) {
    fail(`installed CAIL Log file drift: ${relative}`);
  }
}

console.log(
  "Sandbox Client release authority verified: published Client 0.1.0, published Log 0.6.0, unpublished candidate 0.1.1.",
);
