import { expect, test } from "bun:test";
import { verifyReleaseRef, type GithubJson, type ReleaseRefContext } from "../scripts/check-release-ref.js";

const currentHead = "a".repeat(40);
const oldHead = "b".repeat(40);
const repository = "CUNY-AI-Lab/cail-sandbox-client";
const repositoryPath = `/repos/${repository}`;
const expectedTag = "v0.1.1";

const exactContext: ReleaseRefContext = {
  packageVersion: "0.1.1",
  repository,
  eventName: "release",
  eventAction: "published",
  ref: `refs/tags/${expectedTag}`,
  refType: "tag",
  refName: expectedTag,
  sha: currentHead,
};

function releaseApi(options: {
  branch?: unknown;
  tag?: unknown;
  tags?: Record<string, unknown>;
  repository?: unknown;
} = {}): GithubJson {
  const responses = new Map<string, unknown>([
    [repositoryPath, options.repository ?? { default_branch: "main" }],
    [
      `${repositoryPath}/git/ref/heads/main`,
      { object: options.branch ?? { sha: currentHead, type: "commit" } },
    ],
    [
      `${repositoryPath}/git/ref/tags/${expectedTag}`,
      { object: options.tag ?? { sha: currentHead, type: "commit" } },
    ],
  ]);
  for (const [sha, value] of Object.entries(options.tags ?? {})) {
    responses.set(`${repositoryPath}/git/tags/${sha}`, value);
  }
  return async (path) => {
    if (!responses.has(path)) throw new Error(`unexpected API path: ${path}`);
    return responses.get(path);
  };
}

test("accepts a lightweight tag whose commit is the live default-branch head", async () => {
  await expect(
    verifyReleaseRef(exactContext, releaseApi()),
  ).resolves.toBeUndefined();
});

test("accepts a bounded chain of annotated tags ending at a commit", async () => {
  const tagOne = "c".repeat(40);
  const tagTwo = "d".repeat(40);
  const tagThree = "e".repeat(40);
  await expect(
    verifyReleaseRef(
      exactContext,
      releaseApi({
        tag: { sha: tagOne, type: "tag" },
        tags: {
          [tagOne]: { object: { sha: tagTwo, type: "tag" } },
          [tagTwo]: { object: { sha: tagThree, type: "tag" } },
          [tagThree]: { object: { sha: currentHead, type: "commit" } },
        },
      }),
    ),
  ).resolves.toBeUndefined();
});

test("rejects an over-deep annotated tag chain", async () => {
  const tagShas = ["c", "d", "e", "f"].map((value) =>
    value.repeat(40),
  );
  const tags: Record<string, unknown> = {};
  for (let index = 0; index < tagShas.length - 1; index += 1) {
    tags[tagShas[index]!] = {
      object: { sha: tagShas[index + 1], type: "tag" },
    };
  }
  tags[tagShas.at(-1)!] = {
    object: { sha: currentHead, type: "commit" },
  };
  await expect(
    verifyReleaseRef(
      exactContext,
      releaseApi({
        tag: { sha: tagShas[0], type: "tag" },
        tags,
      }),
    ),
  ).rejects.toThrow("too many nested annotated tags");
});

test("rejects wrong release event, action, ref, type, and name", async () => {
  const cases: Array<[string, Partial<ReleaseRefContext>, string]> = [
    ["event", { eventName: "push" }, "published release event"],
    ["action", { eventAction: "created" }, "published release event"],
    ["ref", { ref: `refs/heads/${expectedTag}` }, "expected tag ref"],
    ["type", { refType: "branch" }, "requires a tag ref"],
    ["name", { refName: "v0.1.0" }, "does not match package version"],
  ];
  for (const [, change, message] of cases) {
    await expect(
      verifyReleaseRef({ ...exactContext, ...change }, releaseApi()),
    ).rejects.toThrow(message);
  }
});

test("rejects a tag commit that differs from GITHUB_SHA", async () => {
  await expect(
    verifyReleaseRef(
      { ...exactContext, sha: oldHead },
      releaseApi({ tag: { sha: currentHead, type: "commit" } }),
    ),
  ).rejects.toThrow("GITHUB_SHA is not the commit named by the release tag");
});

test("rejects a tag that is not the live default-branch head", async () => {
  await expect(
    verifyReleaseRef(
      exactContext,
      releaseApi({ branch: { sha: oldHead, type: "commit" } }),
    ),
  ).rejects.toThrow("live default-branch head");
});

test("rejects malformed refs, objects, and noncommit terminal types", async () => {
  const cases: Array<[string, Parameters<typeof releaseApi>[0], string]> = [
    ["repository response", { repository: [] }, "repository object"],
    ["default branch", { repository: { default_branch: [] } }, "default branch"],
    [
      "branch object type",
      { branch: { sha: currentHead, type: "tag" } },
      "default-branch ref does not resolve directly to a commit",
    ],
    [
      "tag object type",
      { tag: { sha: currentHead, type: "tree" } },
      "unsupported Git object type",
    ],
    [
      "tag object shape",
      { tag: { sha: currentHead, type: "tag" }, tags: { [currentHead]: {} } },
      "annotated tag target object",
    ],
    [
      "invalid branch SHA",
      { branch: { sha: "not-a-sha", type: "commit" } },
      "invalid default-branch head SHA",
    ],
  ];
  for (const [label, options, message] of cases) {
    await expect(
      verifyReleaseRef(exactContext, releaseApi(options)),
      label,
    ).rejects.toThrow(message);
  }
});

test("fails closed when the GitHub API callback errors", async () => {
  await expect(
    verifyReleaseRef(exactContext, async () => {
      throw new Error("network failure");
    }),
  ).rejects.toThrow("network failure");
});
