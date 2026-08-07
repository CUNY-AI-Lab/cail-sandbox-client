import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasValidLiveReleaseAuthority } from "../scripts/check-live-release-authority.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function run(
  cwd: string,
  command: string[],
  env?: Record<string, string>,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: command,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env }),
  });
}

function output(
  value: Uint8Array | undefined,
): string {
  return value ? new TextDecoder().decode(value) : "";
}

function git(cwd: string, args: string[]): void {
  const result = run(cwd, ["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(output(result.stderr));
  }
}

function publicationCheckout(): string {
  const root = mkdtempSync(
    join(tmpdir(), "sandbox-client-publication-authority-"),
  );
  temporaryRoots.push(root);
  mkdirSync(join(root, "scripts"));
  cpSync(
    resolve("scripts/check-clean.ts"),
    join(root, "scripts/check-clean.ts"),
  );
  writeFileSync(join(root, "tracked.txt"), "authority\n");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Review"]);
  git(root, ["config", "user.email", "review@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "authority fixture"]);
  return root;
}

function cleanGate(root: string): ReturnType<typeof Bun.spawnSync> {
  return run(root, ["bun", "scripts/check-clean.ts"]);
}

test("live registry authority requires exact 0.1.0 and absent 0.1.1", () => {
  const published = [
    {
      id: 1_066_310_089,
      name: "0.1.0",
      created_at: "2026-07-25T17:28:03Z",
    },
  ];
  expect(hasValidLiveReleaseAuthority(published)).toBe(true);
  expect(
    hasValidLiveReleaseAuthority([
      ...published,
      {
        id: 1,
        name: "0.1.1",
        created_at: "2026-07-25T18:00:00Z",
      },
    ]),
  ).toBe(false);
  expect(
    hasValidLiveReleaseAuthority([
      { ...published[0], id: 1_066_310_090 },
    ]),
  ).toBe(false);
  expect(hasValidLiveReleaseAuthority({ versions: published })).toBe(
    false,
  );
});

test("publish workflow uses live authority and Bun token without dirtying checkout", () => {
  const workflow = readFileSync(".github/workflows/publish.yml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  expect(workflow).toContain(
    "/orgs/CUNY-AI-Lab/packages/npm/cail-sandbox-client/versions",
  );
  expect(workflow).toContain("name: Install frozen dependencies");
  expect(workflow).toContain(
    "run: bash scripts/install-registry-dependencies.sh",
  );
  expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  expect(workflow).toContain("bun run check:release-live");
  expect(workflow).toContain(
    "NPM_CONFIG_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
  );
  expect(workflow).toContain("permissions:\n  contents: read\n  packages: write");
  expect(workflow).not.toContain("packages: delete");
  expect(workflow).not.toContain("packages: admin");
  expect(workflow).not.toContain("actions/setup-node");
  expect(pkg.scripts?.prepublishOnly).toContain("bun run check:clean");
  expect(pkg.scripts?.prepublishOnly).toContain(
    "bun run check:release-live",
  );
});

test("registry install preserves an ignored npmrc on success and failure", () => {
  const script = resolve("scripts/install-registry-dependencies.sh");
  const fakeBin = mkdtempSync(join(tmpdir(), "sandbox-client-fake-bun-"));
  temporaryRoots.push(fakeBin);
  const fakeBun = join(fakeBin, "bun");
  const capture = join(fakeBin, "captured-npmrc");
  writeFileSync(
    fakeBun,
    '#!/bin/sh\ncat .npmrc > "$FAKE_NPMRC_CAPTURE"\n(mode=$(stat -c "%a" .npmrc 2>/dev/null || stat -f "%Lp" .npmrc); printf "%s" "$mode" > "$FAKE_NPMRC_MODE")\nexit "${FAKE_BUN_EXIT:-0}"\n',
    { mode: 0o755 },
  );

  for (const exitCode of ["0", "23"]) {
    const root = mkdtempSync(join(tmpdir(), "sandbox-client-npmrc-"));
    temporaryRoots.push(root);
    const original = `pre-existing-${exitCode}\n`;
    writeFileSync(join(root, ".npmrc"), original, { mode: 0o640 });
    const originalMode = statSync(join(root, ".npmrc")).mode & 0o777;
    const modeCapture = join(root, "captured-mode");
    const result = run(root, ["/bin/bash", script], {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      RUNNER_TEMP: fakeBin,
      NODE_AUTH_TOKEN: "fixture-token",
      FAKE_NPMRC_CAPTURE: capture,
      FAKE_NPMRC_MODE: modeCapture,
      FAKE_BUN_EXIT: exitCode,
    });
    expect(result.exitCode).toBe(Number(exitCode));
    expect(readFileSync(join(root, ".npmrc"), "utf8")).toBe(original);
    expect(statSync(join(root, ".npmrc")).mode & 0o777).toBe(originalMode);
    expect(readFileSync(modeCapture, "utf8")).toBe("600");
    expect(readFileSync(capture, "utf8")).toContain(
      "@cuny-ai-lab:registry=https://npm.pkg.github.com",
    );
    expect(readFileSync(capture, "utf8")).toContain(
      "_authToken=fixture-token",
    );
  }

  const cleanRoot = mkdtempSync(join(tmpdir(), "sandbox-client-npmrc-clean-"));
  temporaryRoots.push(cleanRoot);
  const cleanResult = run(cleanRoot, ["/bin/bash", script], {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    RUNNER_TEMP: fakeBin,
    NODE_AUTH_TOKEN: "fixture-token",
    FAKE_NPMRC_CAPTURE: capture,
    FAKE_NPMRC_MODE: join(cleanRoot, "captured-mode"),
  });
  expect(cleanResult.exitCode).toBe(0);
  expect(existsSync(join(cleanRoot, ".npmrc"))).toBeFalse();

  for (const token of [undefined, ""] as const) {
    const missingTokenRoot = mkdtempSync(
      join(tmpdir(), "sandbox-client-npmrc-missing-token-"),
    );
    temporaryRoots.push(missingTokenRoot);
    const original = "pre-existing-token-check\n";
    const npmrcPath = join(missingTokenRoot, ".npmrc");
    writeFileSync(npmrcPath, original, { mode: 0o640 });
    const missingCapture = join(missingTokenRoot, "captured-npmrc");
    const tokenEnvironment: Record<string, string> = {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      RUNNER_TEMP: fakeBin,
      FAKE_NPMRC_CAPTURE: missingCapture,
    };
    if (token !== undefined) tokenEnvironment.NODE_AUTH_TOKEN = token;
    const result = run(
      missingTokenRoot,
      ["/bin/bash", script],
      tokenEnvironment,
    );
    expect(result.exitCode).toBe(64);
    expect(output(result.stderr)).toContain(
      "NODE_AUTH_TOKEN must be non-empty",
    );
    expect(readFileSync(npmrcPath, "utf8")).toBe(original);
    expect(existsSync(missingCapture)).toBeFalse();
  }

  const directoryRoot = mkdtempSync(
    join(tmpdir(), "sandbox-client-npmrc-directory-"),
  );
  temporaryRoots.push(directoryRoot);
  const directoryNpmrc = join(directoryRoot, ".npmrc");
  mkdirSync(directoryNpmrc);
  const directoryMarker = join(directoryNpmrc, "keep");
  writeFileSync(directoryMarker, "untouched\n");
  const directoryResult = run(directoryRoot, ["/bin/bash", script], {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    RUNNER_TEMP: fakeBin,
    NODE_AUTH_TOKEN: "fixture-token",
    FAKE_NPMRC_CAPTURE: join(directoryRoot, "captured-npmrc"),
    FAKE_NPMRC_MODE: join(directoryRoot, "captured-mode"),
  });
  expect(directoryResult.exitCode).toBe(65);
  expect(output(directoryResult.stderr)).toContain(
    ".npmrc must be a regular file or symlink",
  );
  expect(statSync(directoryNpmrc).isDirectory()).toBeTrue();
  expect(readFileSync(directoryMarker, "utf8")).toBe("untouched\n");
});

test("publication checkout gate accepts an ordinary clean repository", () => {
  expect(cleanGate(publicationCheckout()).exitCode).toBe(0);
});

test("publication checkout gate rejects replacement refs and grafts", () => {
  const replacement = publicationCheckout();
  writeFileSync(join(replacement, "tracked.txt"), "replacement\n");
  git(replacement, ["commit", "-am", "replacement fixture"]);
  git(replacement, ["replace", "HEAD", "HEAD^"]);
  expect(output(cleanGate(replacement).stderr)).toContain(
    "Git replacement refs are not allowed",
  );

  const graft = publicationCheckout();
  const graftPath = run(
    graft,
    ["git", "rev-parse", "--git-path", "info/grafts"],
  );
  const resolvedGraftPath = output(graftPath.stdout).trim();
  mkdirSync(resolve(graft, resolvedGraftPath, ".."), {
    recursive: true,
  });
  writeFileSync(
    resolve(graft, resolvedGraftPath),
    `${output(run(graft, ["git", "rev-parse", "HEAD"]).stdout).trim()}\n`,
  );
  expect(output(cleanGate(graft).stderr)).toContain(
    "legacy Git grafts are not allowed",
  );
});

test("publication checkout gate rejects hidden index flags", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const root = publicationCheckout();
    git(root, ["update-index", flag, "tracked.txt"]);
    const result = cleanGate(root);
    expect(result.exitCode).toBe(1);
    expect(output(result.stderr)).toContain(
      "nonordinary Git index flags are not allowed",
    );
  }
});

test("publication checkout gate rejects tracked and untracked dirt", () => {
  const tracked = publicationCheckout();
  writeFileSync(join(tracked, "tracked.txt"), "dirty\n");
  expect(output(cleanGate(tracked).stderr)).toContain(
    "publishing requires a clean Git worktree",
  );

  const untracked = publicationCheckout();
  writeFileSync(join(untracked, "untracked.txt"), "dirty\n");
  expect(output(cleanGate(untracked).stderr)).toContain(
    "publishing requires a clean Git worktree",
  );
});

test("publication checkout gate rejects a source archive", () => {
  const root = mkdtempSync(
    join(tmpdir(), "sandbox-client-publication-archive-"),
  );
  temporaryRoots.push(root);
  mkdirSync(join(root, "scripts"));
  cpSync(
    resolve("scripts/check-clean.ts"),
    join(root, "scripts/check-clean.ts"),
  );
  const result = cleanGate(root);
  expect(result.exitCode).toBe(1);
  expect(output(result.stderr)).toContain(
    "publishing requires a Git checkout",
  );
});
