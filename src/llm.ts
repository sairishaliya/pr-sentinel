import { GoogleGenAI } from "@google/genai";

import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "./promptTemplate.js";

export type LlmProvider = "gemini" | "mock";
export type ReviewVerdict = "Approve" | "Needs changes" | "Comment";

export interface ReviewFinding {
  severity: "high" | "medium" | "low";
  title: string;
  file: string;
  line: number;
  details: string;
  recommendation: string;
}

export interface StructuredReview {
  verdict: ReviewVerdict;
  summary: string;
  potentialBugs: ReviewFinding[];
  securityIssues: ReviewFinding[];
  styleReadabilityIssues: ReviewFinding[];
}

export interface PullRequestReviewInput {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  diff: string;
}

export class LlmReviewError extends Error {
  constructor(message: string, readonly causeDetail?: string) {
    super(message);
    this.name = "LlmReviewError";
  }
}

export async function reviewPullRequest(
  input: PullRequestReviewInput,
): Promise<StructuredReview> {
  if (input.provider === "mock") {
    return buildMockReview(input.diff);
  }

  return reviewWithGemini(input);
}

export function normalizeProvider(value: string): LlmProvider {
  const normalized = value.trim().toLowerCase();

  if (normalized === "gemini" || normalized === "mock") {
    return normalized;
  }

  throw new LlmReviewError(
    `Unsupported LLM provider: ${value}. Supported providers are: gemini, mock.`,
  );
}

export function getDefaultModel(provider: LlmProvider): string {
  return provider === "gemini" ? "gemini-2.5-flash" : "mock-reviewer-v1";
}

export function missingApiKeyMessage(provider: LlmProvider): string | null {
  if (provider === "mock") {
    return null;
  }

  return `The \`${provider}_api_key\` input or matching environment variable was not provided, so the AI review could not run.`;
}

async function reviewWithGemini(
  input: PullRequestReviewInput,
): Promise<StructuredReview> {
  const ai = new GoogleGenAI({ apiKey: input.apiKey });
  const prompt = buildReviewPrompt({
    pullRequestTitle: input.pullRequestTitle,
    pullRequestBody: input.pullRequestBody,
    diff: input.diff,
  });

  try {
    const response = await ai.models.generateContent({
      model: input.model,
      contents: prompt,
      config: {
        systemInstruction: REVIEW_SYSTEM_PROMPT,
        temperature: 0.1,
        maxOutputTokens: 1800,
        responseMimeType: "application/json",
      },
    });

    const responseText = response.text?.trim();

    if (!responseText) {
      throw new LlmReviewError("Gemini returned an empty review payload.");
    }

    return parseStructuredReview(responseText);
  } catch (error) {
    if (error instanceof LlmReviewError) {
      throw error;
    }

    throw new LlmReviewError(
      "Gemini review request failed.",
      getGeminiErrorDetail(error),
    );
  }
}

function buildMockReview(diff: string): StructuredReview {
  const findings = collectMockFindings(diff);
  const securityIssues = findings.filter((finding) => finding.category === "security");
  const potentialBugs = findings.filter((finding) => finding.category === "bug");
  const styleReadabilityIssues = findings.filter((finding) => finding.category === "style");
  const verdict = securityIssues.length > 0 || potentialBugs.length > 0
    ? "Needs changes"
    : "Comment";

  return {
    verdict,
    summary:
      "Offline mock review completed. This validates the action flow without calling an external LLM API.",
    potentialBugs: potentialBugs.map(({ category: _category, ...finding }) => finding),
    securityIssues: securityIssues.map(({ category: _category, ...finding }) => finding),
    styleReadabilityIssues: styleReadabilityIssues.map(({ category: _category, ...finding }) => finding),
  };
}

interface CategorizedFinding extends ReviewFinding {
  category: "bug" | "security" | "style";
}

function collectMockFindings(diff: string): CategorizedFinding[] {
  const findings: CategorizedFinding[] = [];
  const lines = diff.split("\n");
  let currentFile = "unknown";
  let newLineNumber = 0;

  for (const line of lines) {
    if (line.startsWith("# file: ")) {
      currentFile = line.replace("# file: ", "").trim().split(" ")[0] || currentFile;
      newLineNumber = 0;
      continue;
    }

    if (line.startsWith("@@")) {
      newLineNumber = parseNewFileStartLine(line);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const finding = classifyAddedLine(line.slice(1), currentFile, newLineNumber);

      if (finding) {
        findings.push(finding);
      }
    }

    if (!line.startsWith("-")) {
      newLineNumber += 1;
    }
  }

  return findings;
}

function classifyAddedLine(
  line: string,
  file: string,
  lineNumber: number,
): CategorizedFinding | null {
  if (/(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}/i.test(line)) {
    return {
      category: "security",
      severity: "high",
      title: "Possible hardcoded secret",
      file,
      line: lineNumber,
      details: "A newly added line looks like it may contain a credential or secret value.",
      recommendation: "Move secrets into GitHub Secrets or a secure secret manager and read them from the environment.",
    };
  }

  if (/\b(req\.query|req\.body|request\.body|request\.query)\b/i.test(line) && /\b(exec|eval|query|raw)\b/i.test(line)) {
    return {
      category: "security",
      severity: "high",
      title: "User input may reach a sensitive sink",
      file,
      line: lineNumber,
      details: "The added code appears to combine request input with a sensitive operation.",
      recommendation: "Validate and parameterize user input before it reaches database, shell, or dynamic execution APIs.",
    };
  }

  if (/TODO|FIXME/i.test(line)) {
    return {
      category: "style",
      severity: "low",
      title: "Follow-up marker added",
      file,
      line: lineNumber,
      details: "The change adds a TODO/FIXME marker that may hide unfinished behavior.",
      recommendation: "Resolve the follow-up now or link it to a tracked issue with clear ownership.",
    };
  }

  if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line) || /catch\s*\([^)]*\)\s*$/.test(line)) {
    return {
      category: "bug",
      severity: "medium",
      title: "Error handling may be swallowed",
      file,
      line: lineNumber,
      details: "The added code appears to catch errors without handling or reporting them.",
      recommendation: "Log the error, return a clear failure, or rethrow after adding context.",
    };
  }

  return null;
}

function parseNewFileStartLine(hunkHeader: string): number {
  const match = hunkHeader.match(/\+(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function parseStructuredReview(rawResponse: string): StructuredReview {
  const parsed = JSON.parse(extractJsonObject(rawResponse)) as Partial<StructuredReview>;

  return {
    verdict: normalizeVerdict(parsed.verdict),
    summary: ensureString(parsed.summary, "summary"),
    potentialBugs: normalizeFindings(parsed.potentialBugs),
    securityIssues: normalizeFindings(parsed.securityIssues),
    styleReadabilityIssues: normalizeFindings(parsed.styleReadabilityIssues),
  };
}

function extractJsonObject(rawResponse: string): string {
  const firstBrace = rawResponse.indexOf("{");
  const lastBrace = rawResponse.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new LlmReviewError("LLM returned a non-JSON review payload.", rawResponse);
  }

  return rawResponse.slice(firstBrace, lastBrace + 1);
}

function normalizeVerdict(value: unknown): ReviewVerdict {
  if (value === "Approve" || value === "Needs changes" || value === "Comment") {
    return value;
  }

  throw new LlmReviewError(`Unsupported verdict returned by LLM: ${String(value)}`);
}

function normalizeFindings(value: unknown): ReviewFinding[] {
  return Array.isArray(value) ? value.map((item) => normalizeFinding(item)) : [];
}

function normalizeFinding(value: unknown): ReviewFinding {
  const finding = (value ?? {}) as Record<string, unknown>;

  return {
    severity: normalizeSeverity(finding.severity),
    title: ensureString(finding.title, "title"),
    file: ensureString(finding.file, "file"),
    line: normalizeLine(finding.line),
    details: ensureString(finding.details, "details"),
    recommendation: ensureString(finding.recommendation, "recommendation"),
  };
}

function normalizeSeverity(value: unknown): ReviewFinding["severity"] {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return "medium";
}

function normalizeLine(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  return 0;
}

function ensureString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LlmReviewError(`LLM returned an invalid ${fieldName} field.`);
  }

  return value.trim();
}

function getGeminiErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    const status = "status" in error ? ` (${String(error.status)})` : "";
    return `Gemini API error${status}: ${error.message}`;
  }

  return String(error);
}
