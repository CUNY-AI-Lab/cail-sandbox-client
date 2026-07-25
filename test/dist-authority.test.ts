import { expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const sentinel = "// sandbox-client stale-dist sentinel\n";

function output(
  value: Uint8Array | undefined,
): string {
  return value ? new TextDecoder().decode(value) : "";
}

test("full check rejects preexisting dist drift before any in-place build", () => {
  if (process.env.CAIL_SKIP_DIST_AUTHORITY_REGRESSION === "1") return;

  const temporary = mkdtempSync(
    join(tmpdir(), "sandbox-client-dist-authority-"),
  );
  try {
    cpSync(root, temporary, {
      recursive: true,
      filter: (source) => {
        const path = relative(root, source);
        return (
          path !== ".git" &&
          !path.startsWith(`.git${process.platform === "win32" ? "\\" : "/"}`) &&
          path !== "node_modules" &&
          !path.startsWith(
            `node_modules${process.platform === "win32" ? "\\" : "/"}`,
          )
        );
      },
    });
    const distPath = join(temporary, "dist/index.js");
    appendFileSync(distPath, sentinel);
    const dirtyBytes = readFileSync(distPath);

    const install = Bun.spawnSync({
      cmd: [
        "bun",
        "install",
        "--frozen-lockfile",
        "--offline",
        "--ignore-scripts",
      ],
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(install.exitCode, output(install.stderr)).toBe(0);
    expect(readFileSync(distPath).equals(dirtyBytes)).toBe(true);

    const check = Bun.spawnSync({
      cmd: ["bun", "run", "check"],
      cwd: temporary,
      env: {
        ...process.env,
        CAIL_SKIP_DIST_AUTHORITY_REGRESSION: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(check.exitCode).toBe(1);
    expect(`${output(check.stdout)}${output(check.stderr)}`).toContain(
      "Sandbox Client: dist/index.js does not match source build",
    );
    expect(readFileSync(distPath).equals(dirtyBytes)).toBe(true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
