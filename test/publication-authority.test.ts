import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: command,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
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
  expect(workflow).toContain("bun run check:release-live");
  expect(workflow).toContain(
    "NPM_CONFIG_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
  );
  expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  expect(workflow).not.toContain("> .npmrc");
  expect(workflow).not.toContain("NPM_CONFIG_USERCONFIG");
  expect(workflow).not.toContain("actions/setup-node");
  expect(pkg.scripts?.prepublishOnly).toContain("bun run check:clean");
  expect(pkg.scripts?.prepublishOnly).toContain(
    "bun run check:release-live",
  );
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
