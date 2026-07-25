import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type RegistryVersion = {
  id?: unknown;
  name?: unknown;
  created_at?: unknown;
};

const expectedPublishedClient = {
  id: 1_066_310_089,
  name: "0.1.0",
  createdAt: "2026-07-25T17:28:03Z",
};

export function hasValidLiveReleaseAuthority(
  value: unknown,
): boolean {
  if (!Array.isArray(value)) return false;
  return (
    value.some(
      (entry: RegistryVersion) =>
        entry !== null &&
        typeof entry === "object" &&
        entry.id === expectedPublishedClient.id &&
        entry.name === expectedPublishedClient.name &&
        entry.created_at === expectedPublishedClient.createdAt,
    ) &&
    !value.some(
      (entry: RegistryVersion) =>
        entry !== null &&
        typeof entry === "object" &&
        entry.name === "0.1.1",
    )
  );
}

function main(): void {
  const versionsPath = process.env.CAIL_REGISTRY_VERSIONS_FILE;
  if (!versionsPath) {
    throw new Error(
      "Sandbox Client publication authority: live registry preflight requires CAIL_REGISTRY_VERSIONS_FILE",
    );
  }
  const versions = JSON.parse(
    readFileSync(resolve(versionsPath), "utf8"),
  ) as unknown;
  if (!hasValidLiveReleaseAuthority(versions)) {
    throw new Error(
      "Sandbox Client publication authority: registry receipt changed or 0.1.1 already exists",
    );
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) main();
