# PR-Sentinel

Reusable GitHub Action that performs first-pass pull request review with Gemini or an offline mock reviewer and posts a structured Markdown comment back to the PR.

## Problem

Human reviewers should not spend their first pass looking for obvious mistakes. PR-Sentinel catches likely bugs, security risks, and readability issues early, then leaves a compact review comment for the author and reviewer to use as a starting point.

## Verification On A Restricted Laptop

The project includes an offline verification mode. It does not need GitHub access, an API key, or outbound network calls.

```bash
npm install
npm run verify
```

The verification command checks:

- Normal PR review flow using the offline `mock` provider.
- Large diff skip flow for diffs over `5000` lines.
- Gemini API failure fallback flow.

It also writes sample comments to `verification-output/`:

- `success-review.md`
- `skip-large-diff.md`
- `gemini-failure-fallback.md`
- `summary.json`

These files are useful for demos, screenshots, and CV discussions because they show exactly what the action would post on a PR.

## Live Setup With Gemini

Gemini is the recommended live provider because Google offers a Gemini Developer API free tier for supported models. OpenAI's public API pricing is token-based, so this project uses Gemini as the lower-friction live option.

1. Push this action repository to GitHub.
2. Commit the generated `dist/` folder because `action.yml` runs `dist/index.js`.
3. Add a repository or organization secret named `GEMINI_API_KEY`.
4. Add this workflow to the target repository:

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  pr-sentinel:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: write

    steps:
      - name: Run PR-Sentinel
        uses: your-org/pr-sentinel@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          llm_provider: gemini
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
          model: gemini-2.5-flash
          max_diff_lines: "5000"
```

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `github_token` | Yes | None | Token used to fetch PR data and write the PR comment. |
| `llm_provider` | No | `gemini` | Provider used for review. Supported values: `gemini`, `mock`. |
| `gemini_api_key` | For Gemini | None | Gemini API key read from `GEMINI_API_KEY`. Not needed for `mock`. |
| `model` | No | `gemini-2.5-flash` | Model used for live Gemini review. |
| `max_diff_lines` | No | `5000` | Skip review gracefully when the diff is larger than this threshold. |

## Architecture

PR opened or updated -> GitHub Action triggers -> Octokit fetches PR files and patches -> PR-Sentinel builds a structured review prompt -> Gemini or the offline mock reviewer analyzes the diff -> response is normalized into review categories -> Octokit posts or updates one PR comment.

## Review Output

Each PR comment includes:

- Summary verdict: `Approve`, `Needs changes`, or `Comment`.
- Potential bugs.
- Security issues.
- Code style and readability issues.
- A note when review was skipped or unavailable.

## Error Handling

- If the diff is larger than `max_diff_lines`, PR-Sentinel posts a clear skip comment.
- If Gemini fails because of rate limits, network restrictions, or API errors, PR-Sentinel logs the reason and posts a fallback comment.
- If the GitHub token is missing or comment creation fails, the action fails loudly so maintainers can fix the workflow configuration.

## Screenshot / GIF

_Add a screenshot or GIF of PR-Sentinel reviewing a real pull request here._
