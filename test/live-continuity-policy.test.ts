import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("live continuity harness is locked to the disposable FUSE proof", () => {
  const source = readFileSync(
    new URL("../scripts/live-continuity-e2e.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain(
    "cail-sandbox-bridge-continuity-e2e.veritas44.workers.dev",
  );
  expect(source).toContain("CAIL_SANDBOX_CONTINUITY_E2E_BASE_URL");
  expect(source).toContain("restored.restoredFromIncarnation");
  expect(source).toContain("before.incarnation");
  expect(source).toContain("findmnt -T /workspace");
  expect(source).toContain("production FUSE overlay");
  expect(source).toContain("upper-only.txt");
  expect(source).toContain("client.destroy(lease, credential)");
  expect(source).not.toContain("CAIL_SANDBOX_LOCAL_BACKUPS");
  expect(source).not.toContain("R2_ACCESS_KEY_ID");
  expect(source).not.toContain("R2_SECRET_ACCESS_KEY");
});
