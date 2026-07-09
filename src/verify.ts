import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PullRequestContext, PullRequestDetails } from "./github.js";
import { LlmReviewError } from "./llm.js";
import { runAction } from "./index.js";

const TEST_CONTEXT: PullRequestContext = {
  owner: "acme",
  repo: "widgets",
  pullNumber: 42,
};

const BASE_PULL_REQUEST: PullRequestDetails = {
  number: 42,
  title: "Harden input validation",
  body: "Adds validation and updates controller logic.",
  htmlUrl: "https://github.com/acme/widgets/pull/42",
  files: [
    {
      filename: "src/controller.ts",
      status: "modified",
      additions: 8,
      deletions: 2,
      changes: 10,
      patch: [
        "@@ -10,4 +10,10 @@ export async function createUser(req, res) {",
        '-  const id = req.body.id;',
        '+  const id = String(req.body.id ?? "").trim();',
        "+  if (!id) {",
        '+    return res.status(400).json({ error: "missing id" });',
        "+  }",
        "+",
        "+  const token = 'hardcoded-demo-token-123456789';",
        "+  await audit.log(token);",
        "+  // TODO: connect this to the production policy engine",
      ].join("\n"),
    },
  ],
};

const OUTPUT_DIR = "verification-output";

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  await runOfflineMockReviewScenario();
  await runOversizedDiffScenario();
  await runGeminiFailureScenario();

  writeFileSync(
    join(OUTPUT_DIR, "summary.json"),
    `${JSON.stringify({
      status: "passed",
      checked: [
        "offline mock review without API keys",
        "oversized diff skip comment",
        "Gemini API failure fallback comment",
      ],
      generatedFiles: [
        "verification-output/success-review.md",
        "verification-output/skip-large-diff.md",
        "verification-output/gemini-failure-fallback.md",
      ],
    }, null, 2)}\n`,
  );

  console.log("Verification passed: offline mock, large-diff skip, and Gemini fallback flows behaved as expected.");
}

async function runOfflineMockReviewScenario(): Promise<void> {
  let postedCommentBody = "";

  const result = await withActionInputs(
    {
      INPUT_GITHUB_TOKEN: "ghs_test_token",
      INPUT_LLM_PROVIDER: "mock",
      INPUT_MAX_DIFF_LINES: "5000",
    },
    () =>
      runAction({
        getPullRequestContext: () => TEST_CONTEXT,
        createGitHubClient: () => ({}) as never,
        fetchPullRequestDetails: async () => BASE_PULL_REQUEST,
        postComment: async (_octokit, _context, body) => {
          postedCommentBody = body;
          writeFileSync(join(OUTPUT_DIR, "success-review.md"), `${body}\n`);
          return "https://github.com/acme/widgets/pull/42#issuecomment-1";
        },
      }),
  );

  assert.equal(result.status, "reviewed");
  assert.equal(result.verdict, "Needs changes");
  assert.match(postedCommentBody, /# PR-Sentinel Review/);
  assert.match(postedCommentBody, /\*\*Verdict:\*\* Needs changes/);
  assert.match(postedCommentBody, /Possible hardcoded secret/);
  assert.match(postedCommentBody, /## Potential Bugs/);
  assert.match(postedCommentBody, /## Security Issues/);
  assert.match(postedCommentBody, /## Code Style \/ Readability/);
  console.log("Verified offline mock review path.");
}

async function runOversizedDiffScenario(): Promise<void> {
  let reviewWasCalled = false;
  let postedCommentBody = "";

  const oversizedPullRequest: PullRequestDetails = {
    ...BASE_PULL_REQUEST,
    files: [
      {
        filename: "src/huge.ts",
        status: "modified",
        additions: 5001,
        deletions: 0,
        changes: 5001,
        patch: Array.from({ length: 5001 }, (_, index) => `+line ${index + 1}`).join("\n"),
      },
    ],
  };

  const result = await withActionInputs(
    {
      INPUT_GITHUB_TOKEN: "ghs_test_token",
      INPUT_LLM_PROVIDER: "mock",
      INPUT_MAX_DIFF_LINES: "5000",
    },
    () =>
      runAction({
        getPullRequestContext: () => TEST_CONTEXT,
        createGitHubClient: () => ({}) as never,
        fetchPullRequestDetails: async () => oversizedPullRequest,
        reviewPullRequest: async () => {
          reviewWasCalled = true;
          throw new Error("Review should not be called for oversized diffs.");
        },
        postComment: async (_octokit, _context, body) => {
          postedCommentBody = body;
          writeFileSync(join(OUTPUT_DIR, "skip-large-diff.md"), `${body}\n`);
          return "https://github.com/acme/widgets/pull/42#issuecomment-2";
        },
      }),
  );

  assert.equal(result.status, "commented");
  assert.equal(result.verdict, "Comment");
  assert.equal(reviewWasCalled, false);
  assert.match(postedCommentBody, /Review skipped because this pull request diff is too large to analyze reliably/);
  console.log("Verified oversized diff skip path.");
}

async function runGeminiFailureScenario(): Promise<void> {
  let postedCommentBody = "";

  const result = await withActionInputs(
    {
      INPUT_GITHUB_TOKEN: "ghs_test_token",
      INPUT_LLM_PROVIDER: "gemini",
      INPUT_GEMINI_API_KEY: "gemini_test_key",
      INPUT_MAX_DIFF_LINES: "5000",
    },
    () =>
      runAction({
        getPullRequestContext: () => TEST_CONTEXT,
        createGitHubClient: () => ({}) as never,
        fetchPullRequestDetails: async () => BASE_PULL_REQUEST,
        reviewPullRequest: async () => {
          throw new LlmReviewError(
            "Gemini review request failed.",
            "Rate limited by the Gemini API.",
          );
        },
        postComment: async (_octokit, _context, body) => {
          postedCommentBody = body;
          writeFileSync(join(OUTPUT_DIR, "gemini-failure-fallback.md"), `${body}\n`);
          return "https://github.com/acme/widgets/pull/42#issuecomment-3";
        },
      }),
  );

  assert.equal(result.status, "commented");
  assert.equal(result.verdict, "Comment");
  assert.match(postedCommentBody, /The gemini review could not be completed\. Rate limited by the Gemini API\./);
  assert.match(postedCommentBody, /## Security Issues/);
  console.log("Verified Gemini failure fallback path.");
}

async function withActionInputs<T>(
  values: Record<string, string>,
  callback: () => Promise<T>,
): Promise<T> {
  const previousEntries = Object.entries(values).map(([key]) => [key, process.env[key]] as const);

  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, previousValue] of previousEntries) {
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
