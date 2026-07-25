import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function runGit(args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(
  value: Uint8Array | undefined,
): string {
  return value ? new TextDecoder().decode(value) : "";
}

function git(args: string[]): string {
  const result = runGit(args);
  if (result.exitCode !== 0) {
    throw new Error(
      "Sandbox Client publication authority: could not inspect Git checkout",
    );
  }
  return output(result.stdout);
}

const inside = runGit(["rev-parse", "--is-inside-work-tree"]);
if (
  inside.exitCode !== 0 ||
  output(inside.stdout).trim() !== "true"
) {
  throw new Error(
    "Sandbox Client publication authority: publishing requires a Git checkout; source archives may run `bun run check` but cannot publish",
  );
}
if (git(["for-each-ref", "--format=%(refname)", "refs/replace"]).trim()) {
  throw new Error(
    "Sandbox Client publication authority: Git replacement refs are not allowed",
  );
}
const grafts = git(["rev-parse", "--git-path", "info/grafts"]).trim();
if (grafts && existsSync(resolve(root, grafts))) {
  throw new Error(
    "Sandbox Client publication authority: legacy Git grafts are not allowed",
  );
}
if (git(["status", "--porcelain", "--untracked-files=all"]).length > 0) {
  throw new Error(
    "Sandbox Client publication authority: publishing requires a clean Git worktree",
  );
}
for (const line of git(["ls-files", "-v"]).split("\n")) {
  if (line && !line.startsWith("H ")) {
    throw new Error(
      "Sandbox Client publication authority: nonordinary Git index flags are not allowed",
    );
  }
}
