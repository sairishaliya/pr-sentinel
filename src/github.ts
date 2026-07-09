import { readFileSync } from "node:fs";

import { Octokit } from "@octokit/rest";

export const REVIEW_COMMENT_MARKER = "<!-- pr-sentinel-review -->";

export interface PullRequestContext {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  files: PullRequestFile[];
}

interface PullRequestEventPayload {
  pull_request?: {
    number?: number;
  };
  repository?: {
    full_name?: string;
    owner?: {
      login?: string;
    };
    name?: string;
  };
}

export function createGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token });
}

export function getPullRequestContext(): PullRequestContext | null {
  const payloadPath = process.env.GITHUB_EVENT_PATH;
  const repositoryFullName = process.env.GITHUB_REPOSITORY;

  if (!payloadPath || !repositoryFullName) {
    return null;
  }

  const payload = JSON.parse(
    readFileSync(payloadPath, "utf8"),
  ) as PullRequestEventPayload;
  const pullNumber = payload.pull_request?.number;

  if (!pullNumber) {
    return null;
  }

  const [owner, repo] = repositoryFullName.split("/");

  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    pullNumber,
  };
}

export async function fetchPullRequestDetails(
  octokit: Octokit,
  context: PullRequestContext,
): Promise<PullRequestDetails> {
  const [{ data: pullRequest }, files] = await Promise.all([
    octokit.rest.pulls.get({
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
    }),
    octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.pullNumber,
      per_page: 100,
    }) as Promise<PullRequestFile[]>,
  ]);

  return {
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body ?? "",
    htmlUrl: pullRequest.html_url,
    files,
  };
}

export function countDiffLines(files: PullRequestFile[]): number {
  return files.reduce((total, file) => total + countFileDiffLines(file), 0);
}

export function buildPullRequestDiff(files: PullRequestFile[]): string {
  return files
    .map((file) => {
      const previousFilename = file.previous_filename
        ? ` (previously ${file.previous_filename})`
        : "";
      const patch = file.patch?.trim() || "[patch unavailable: binary or truncated diff]";

      return [
        `diff --git a/${file.filename} b/${file.filename}`,
        `# file: ${file.filename}${previousFilename}`,
        `# status: ${file.status}, additions: ${file.additions}, deletions: ${file.deletions}`,
        patch,
      ].join("\n");
    })
    .join("\n\n");
}

export async function upsertPullRequestComment(
  octokit: Octokit,
  context: PullRequestContext,
  body: string,
): Promise<string> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullNumber,
    per_page: 100,
  });

  const existingComment = comments.find((comment) =>
    comment.body?.includes(REVIEW_COMMENT_MARKER),
  );

  if (existingComment) {
    const { data } = await octokit.rest.issues.updateComment({
      owner: context.owner,
      repo: context.repo,
      comment_id: existingComment.id,
      body,
    });

    return data.html_url;
  }

  const { data } = await octokit.rest.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullNumber,
    body,
  });

  return data.html_url;
}

function countFileDiffLines(file: PullRequestFile): number {
  if (file.patch) {
    return file.patch.split("\n").length;
  }

  return file.additions + file.deletions;
}
