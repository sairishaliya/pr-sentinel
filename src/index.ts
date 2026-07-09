import 'dotenv/config';

import { fileURLToPath } from "node:url";

import * as core from "@actions/core";

import {
  LlmReviewError,
  getDefaultModel,
  missingApiKeyMessage,
  normalizeProvider,
  type ReviewFinding,
  type StructuredReview,
  reviewPullRequest,
} from "./llm.js";
import {
  REVIEW_COMMENT_MARKER,
  buildPullRequestDiff,
  countDiffLines,
  createGitHubClient,
  fetchPullRequestDetails,
  getPullRequestContext,
  type PullRequestContext,
  type PullRequestDetails,
  upsertPullRequestComment,
} from "./github.js";

const DEFAULT_PROVIDER = "gemini";
const DEFAULT_MAX_DIFF_LINES = 5000;

export interface ActionDependencies {
  getPullRequestContext: typeof getPullRequestContext;
  createGitHubClient: typeof createGitHubClient;
  fetchPullRequestDetails: typeof fetchPullRequestDetails;
  reviewPullRequest: typeof reviewPullRequest;
  postComment: typeof upsertPullRequestComment;
}

export interface RunActionResult {
  status: "skipped" | "reviewed" | "commented" | "failed";
  verdict?: "Approve" | "Needs changes" | "Comment";
  commentUrl?: string;
  commentBody?: string;
}

export async function runAction(
  overrides: Partial<ActionDependencies> = {},
): Promise<RunActionResult> {
  const dependencies: ActionDependencies = {
    getPullRequestContext,
    createGitHubClient,
    fetchPullRequestDetails,
    reviewPullRequest,
    postComment: upsertPullRequestComment,
    ...overrides,
  };

  const githubToken = readInput("github_token", "GITHUB_TOKEN");
  const provider = normalizeProvider(readInput("llm_provider", "LLM_PROVIDER") || DEFAULT_PROVIDER);
  const apiKey = readProviderApiKey(provider);
  const model = readInput("model") || getDefaultModel(provider);
  const maxDiffLines = readNumberInput("max_diff_lines", DEFAULT_MAX_DIFF_LINES);

  const context = dependencies.getPullRequestContext();

  if (!context) {
    core.info("No pull request context found. Skipping PR-Sentinel.");
    return { status: "skipped" };
  }

  if (!githubToken) {
    core.setFailed("Missing GitHub token. Provide `github_token` to let PR-Sentinel read the PR and post comments.");
    return { status: "failed" };
  }

  const octokit = dependencies.createGitHubClient(githubToken);
  const pullRequest = await dependencies.fetchPullRequestDetails(octokit, context);
  const diffLineCount = countDiffLines(pullRequest.files);

  core.info(
    `Reviewing PR #${pullRequest.number} in ${context.owner}/${context.repo} with ${diffLineCount} diff lines.`,
  );

  if (diffLineCount > maxDiffLines) {
    const commentBody = buildSkippedReviewComment(
      pullRequest,
      diffLineCount,
      maxDiffLines,
    );
    const commentUrl = await postComment(
      dependencies.postComment,
      octokit,
      context,
      commentBody,
    );

    core.info(
      `Skipped review because the diff exceeded ${maxDiffLines} lines. Comment: ${commentUrl}`,
    );
    core.setOutput("verdict", "Comment");
    core.setOutput("comment_url", commentUrl);
    return {
      status: "commented",
      verdict: "Comment",
      commentUrl,
      commentBody,
    };
  }

  const apiKeyMessage = missingApiKeyMessage(provider);

  if (apiKeyMessage && !apiKey) {
    const commentBody = buildUnavailableReviewComment(
      pullRequest,
      apiKeyMessage,
    );
    const commentUrl = await postComment(
      dependencies.postComment,
      octokit,
      context,
      commentBody,
    );

    core.warning(`Skipping ${provider} review because the API key is missing.`);
    core.setOutput("verdict", "Comment");
    core.setOutput("comment_url", commentUrl);
    return {
      status: "commented",
      verdict: "Comment",
      commentUrl,
      commentBody,
    };
  }

  try {
    const review = await dependencies.reviewPullRequest({
      provider,
      apiKey,
      model,
      pullRequestTitle: pullRequest.title,
      pullRequestBody: pullRequest.body,
      diff: buildPullRequestDiff(pullRequest.files),
    });

    const commentBody = buildReviewComment(
      pullRequest,
      review,
      provider,
      model,
      diffLineCount,
    );
    const commentUrl = await postComment(
      dependencies.postComment,
      octokit,
      context,
      commentBody,
    );

    core.setOutput("verdict", review.verdict);
    core.setOutput("comment_url", commentUrl);
    core.info(`Posted PR-Sentinel review comment: ${commentUrl}`);
    return {
      status: "reviewed",
      verdict: review.verdict,
      commentUrl,
      commentBody,
    };
  } catch (error) {
    const detail = getFailureDetail(error);
    core.error(detail);

    const commentBody = buildUnavailableReviewComment(
      pullRequest,
      `The ${provider} review could not be completed. ${detail}`,
    );
    const commentUrl = await postComment(
      dependencies.postComment,
      octokit,
      context,
      commentBody,
    );

    core.setOutput("verdict", "Comment");
    core.setOutput("comment_url", commentUrl);
    return {
      status: "commented",
      verdict: "Comment",
      commentUrl,
      commentBody,
    };
  }
}

function readInput(name: string, fallbackEnvName?: string): string {
  const fromActionInput = core.getInput(name);

  if (fromActionInput) {
    return fromActionInput.trim();
  }

  if (fallbackEnvName) {
    return process.env[fallbackEnvName]?.trim() ?? "";
  }

  return "";
}

function readNumberInput(name: string, defaultValue: number): number {
  const rawValue = readInput(name);

  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function readProviderApiKey(provider: string): string {
  if (provider === "gemini") {
    return readInput("gemini_api_key", "GEMINI_API_KEY");
  }

  return "";
}

async function postComment(
  postCommentImpl: typeof upsertPullRequestComment,
  octokit: ReturnType<typeof createGitHubClient>,
  context: PullRequestContext,
  body: string,
): Promise<string> {
  return postCommentImpl(octokit, context, body);
}

function buildReviewComment(
  pullRequest: PullRequestDetails,
  review: StructuredReview,
  provider: string,
  model: string,
  diffLineCount: number,
): string {
  return [
    REVIEW_COMMENT_MARKER,
    "# PR-Sentinel Review",
    "",
    `**Verdict:** ${review.verdict}`,
    "",
    `Reviewed ${diffLineCount} diff lines from ${pullRequest.files.length} changed file(s) using \`${provider}\` / \`${model}\`.`,
    "",
    "## Summary Verdict",
    review.summary,
    "",
    "## Potential Bugs",
    formatFindings(review.potentialBugs, "No potential bugs identified from the diff."),
    "",
    "## Security Issues",
    formatFindings(review.securityIssues, "No obvious security issues identified from the diff."),
    "",
    "## Code Style / Readability",
    formatFindings(
      review.styleReadabilityIssues,
      "No notable style or readability issues identified from the diff.",
    ),
    "",
    `_Reviewed PR #${pullRequest.number}: ${pullRequest.htmlUrl}_`,
  ].join("\n");
}

function buildSkippedReviewComment(
  pullRequest: PullRequestDetails,
  diffLineCount: number,
  maxDiffLines: number,
): string {
  return [
    REVIEW_COMMENT_MARKER,
    "# PR-Sentinel Review",
    "",
    "**Verdict:** Comment",
    "",
    "## Summary Verdict",
    `Review skipped because this pull request diff is too large to analyze reliably (${diffLineCount} lines across ${pullRequest.files.length} file(s); limit: ${maxDiffLines}).`,
    "",
    "## Potential Bugs",
    "- Review not run.",
    "",
    "## Security Issues",
    "- Review not run.",
    "",
    "## Code Style / Readability",
    "- Review not run.",
    "",
    `_PR-Sentinel skipped PR #${pullRequest.number}: ${pullRequest.htmlUrl}_`,
  ].join("\n");
}

function buildUnavailableReviewComment(
  pullRequest: PullRequestDetails,
  reason: string,
): string {
  return [
    REVIEW_COMMENT_MARKER,
    "# PR-Sentinel Review",
    "",
    "**Verdict:** Comment",
    "",
    "## Summary Verdict",
    reason,
    "",
    "## Potential Bugs",
    "- Review unavailable.",
    "",
    "## Security Issues",
    "- Review unavailable.",
    "",
    "## Code Style / Readability",
    "- Review unavailable.",
    "",
    `_PR-Sentinel could not review PR #${pullRequest.number}: ${pullRequest.htmlUrl}_`,
  ].join("\n");
}

function formatFindings(findings: ReviewFinding[], emptyMessage: string): string {
  if (findings.length === 0) {
    return `- ${emptyMessage}`;
  }

  return findings
    .map((finding) => {
      const location =
        finding.line > 0
          ? `\`${finding.file}:${finding.line}\``
          : `\`${finding.file}\``;

      return [
        `- **${capitalize(finding.severity)}:** ${finding.title} (${location})`,
        `  ${finding.details}`,
        `  Recommendation: ${finding.recommendation}`,
      ].join("\n");
    })
    .join("\n");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getFailureDetail(error: unknown): string {
  if (error instanceof LlmReviewError) {
    return error.causeDetail ?? error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];

  if (!entryPath) {
    return false;
  }

  return fileURLToPath(import.meta.url) === entryPath;
}

if (isDirectExecution()) {
  runAction().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`PR-Sentinel failed: ${message}`);
  });
}
