export interface ReviewPromptInput {
  pullRequestTitle: string;
  pullRequestBody: string;
  diff: string;
}

export const REVIEW_SYSTEM_PROMPT = `You are PR-Sentinel, an expert pull request reviewer.
Focus on issues that are observable from the diff. Be specific, technically rigorous, and concise.
Only report issues that are reasonably supported by the code changes. Do not invent missing context.
Return only valid JSON that matches the requested schema.`;

export function buildReviewPrompt({
  pullRequestTitle,
  pullRequestBody,
  diff,
}: ReviewPromptInput): string {
  return `Review the following GitHub pull request diff and produce a structured review.

Evaluation goals:
- Potential bugs introduced by the change
- Security issues such as hardcoded secrets, injection risks, or unsafe handling of inputs
- Code style and readability issues that would make the change harder to maintain
- A short summary verdict choosing exactly one of: Approve, Needs changes, Comment

Output requirements:
- Return only JSON, with no markdown fences and no extra text.
- Use this exact schema:
{
  "verdict": "Approve | Needs changes | Comment",
  "summary": "One short paragraph",
  "potentialBugs": [
    {
      "severity": "high | medium | low",
      "title": "Short issue title",
      "file": "path/to/file.ext",
      "line": 0,
      "details": "Why this matters",
      "recommendation": "Concrete suggested fix"
    }
  ],
  "securityIssues": [
    {
      "severity": "high | medium | low",
      "title": "Short issue title",
      "file": "path/to/file.ext",
      "line": 0,
      "details": "Why this matters",
      "recommendation": "Concrete suggested fix"
    }
  ],
  "styleReadabilityIssues": [
    {
      "severity": "high | medium | low",
      "title": "Short issue title",
      "file": "path/to/file.ext",
      "line": 0,
      "details": "Why this matters",
      "recommendation": "Concrete suggested fix"
    }
  ]
}

Rules:
- If a category has no findings, return an empty array for that category.
- Use line 0 when the exact line cannot be determined from the diff.
- Keep the summary under 80 words.
- Do not approve if you found a high-confidence bug or security issue.

Pull request title:
${pullRequestTitle || "(no title provided)"}

Pull request description:
${pullRequestBody || "(no description provided)"}

Unified diff:
${diff}`;
}
