/**
 * L1 zero-cost tool output micro-compaction.
 *
 * Folds bulky historical tool results into concise, ID-free entity headlines
 * before sending transcripts to the model. Operates strictly on the in-memory
 * prompt projection; stored conversation rows and audit records are untouched.
 */

export const MICRO_COMPACT_KEEP_RECENT_TOOLS = 2;
export const MICRO_COMPACT_MIN_TOKENS = 200;
export const MICRO_COMPACT_LARGE_TEXT_CHARS = 400;
export const MICRO_COMPACT_LARGE_LIST_ITEMS = 5;

const BULKY_TEXT_KEYS = [
  "resumeText",
  "jobDescription",
  "body",
  "content",
  "markdown",
  "text",
] as const;

const BULKY_LIST_KEYS = ["jobs", "items", "results", "pages", "blocks"] as const;

const SAFE_SCALAR_KEYS = [
  "title",
  "name",
  "jobTitle",
  "company",
  "status",
  "verdict",
  "url",
  "finalUrl",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cleanSnippet(value: unknown, max = 60): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}

function formatNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function topTitles(
  list: unknown[],
  pick: (item: Record<string, unknown>) => string | null,
  limit = 3,
): string {
  const labels: string[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (!item) continue;
    const label = pick(item);
    if (label) labels.push(label);
    if (labels.length >= limit) break;
  }
  return labels.join(", ");
}

function truncateHeadline(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}

export function shouldMicroCompactToolOutput(
  _toolName: string,
  projectedOutput: unknown,
  renderedText: string,
  estimateTokens: (text: string) => number,
  minTokens = MICRO_COMPACT_MIN_TOKENS,
): boolean {
  if (estimateTokens(renderedText) >= minTokens) return true;
  const obj = asRecord(projectedOutput);
  if (!obj) return false;
  for (const key of BULKY_TEXT_KEYS) {
    const val = obj[key];
    if (typeof val === "string" && val.length > MICRO_COMPACT_LARGE_TEXT_CHARS) {
      return true;
    }
    const job = asRecord(obj.job);
    if (job && typeof job[key] === "string" && (job[key] as string).length > MICRO_COMPACT_LARGE_TEXT_CHARS) {
      return true;
    }
  }
  for (const key of BULKY_LIST_KEYS) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > MICRO_COMPACT_LARGE_LIST_ITEMS) {
      return true;
    }
  }
  return false;
}

export function summarizeToolOutputHeadline(
  toolName: string,
  projectedOutput: unknown,
): string {
  const obj = asRecord(projectedOutput);
  if (!obj) {
    const len = typeof projectedOutput === "string" ? projectedOutput.length : JSON.stringify(projectedOutput ?? null).length;
    return truncateHeadline(`output (${len} chars)`);
  }

  switch (toolName) {
    case "get_resume": {
      const title = cleanSnippet(obj.title) ?? "Untitled resume";
      const chars =
        typeof obj.chars === "number"
          ? obj.chars
          : typeof obj.resumeText === "string"
            ? obj.resumeText.length
            : 0;
      return truncateHeadline(`Resume "${title}" (${chars} chars)`);
    }
    case "get_job": {
      const job = asRecord(obj.job) ?? obj;
      const title = cleanSnippet(job.title) ?? "Job";
      const company = cleanSnippet(job.company);
      const status = cleanSnippet(job.status) ?? "unknown";
      const descChars =
        typeof job.descriptionChars === "number"
          ? job.descriptionChars
          : typeof job.jobDescription === "string"
            ? job.jobDescription.length
            : 0;
      return truncateHeadline(
        `Job "${title}"${company ? ` at "${company}"` : ""} (status: ${status}, description: ${descChars} chars)`,
      );
    }
    case "list_jobs": {
      const jobs = Array.isArray(obj.jobs) ? obj.jobs : [];
      const total = typeof obj.total === "number" ? obj.total : jobs.length;
      const sample = topTitles(jobs, (item) => {
        const title = cleanSnippet(item.title, 36);
        const company = cleanSnippet(item.company, 28);
        if (title && company) return `${title} @ ${company}`;
        return title ?? company;
      });
      return truncateHeadline(
        `${jobs.length} of ${total} jobs${sample ? ` (e.g. ${sample})` : ""}`,
      );
    }
    case "read_webpage": {
      const title = cleanSnippet(obj.title) ?? cleanSnippet(obj.finalUrl, 80) ?? cleanSnippet(obj.url, 80) ?? "Webpage";
      const chars = typeof obj.content === "string" ? obj.content.length : 0;
      return truncateHeadline(`Webpage "${title}" (${chars} chars)`);
    }
    case "review_resume": {
      const title = cleanSnippet(obj.title) ?? "Resume";
      const scores = asRecord(obj.scores);
      const overall =
        scores && typeof scores.overall === "number"
          ? `overall ${scores.overall}`
          : cleanSnippet(obj.status) ?? "done";
      const bodyChars = typeof obj.body === "string" ? obj.body.length : 0;
      return truncateHeadline(`Resume review for "${title}" (${overall}, ${bodyChars} chars)`);
    }
    case "match_job": {
      const title = cleanSnippet(obj.jobTitle) ?? "Job";
      const company = cleanSnippet(obj.company);
      const scores = asRecord(obj.scores);
      const verdict = cleanSnippet(obj.verdict);
      const scoreBrief = verdict
        ? `verdict: ${verdict}`
        : scores && typeof scores.overall === "number"
          ? `score: ${scores.overall}`
          : cleanSnippet(obj.status) ?? "done";
      return truncateHeadline(
        `Match analysis for "${title}"${company ? ` at "${company}"` : ""} (${scoreBrief})`,
      );
    }
    case "generate_cover_letter": {
      const title = cleanSnippet(obj.jobTitle) ?? "Job";
      const company = cleanSnippet(obj.company);
      const bodyChars = typeof obj.body === "string" ? obj.body.length : 0;
      return truncateHeadline(
        `Cover letter for "${title}"${company ? ` at "${company}"` : ""} (${bodyChars} chars)`,
      );
    }
    case "notion_read":
    case "feishu_read_doc": {
      const title = cleanSnippet(obj.title) ?? "Document";
      const chars =
        typeof obj.content === "string"
          ? obj.content.length
          : typeof obj.markdown === "string"
            ? obj.markdown.length
            : typeof obj.text === "string"
              ? obj.text.length
              : 0;
      return truncateHeadline(`Document "${title}" (${chars} chars)`);
    }
    case "notion_search":
    case "feishu_search_docs": {
      const items = Array.isArray(obj.items)
        ? obj.items
        : Array.isArray(obj.results)
          ? obj.results
          : [];
      const sample = topTitles(items, (item) => cleanSnippet(item.title, 40));
      return truncateHeadline(
        `${items.length} items${sample ? ` (e.g. ${sample})` : ""}`,
      );
    }
    case "today_plan_read": {
      const buckets = asRecord(obj.buckets);
      const todayCount = Array.isArray(buckets?.today) ? buckets.today.length : 0;
      const tomorrowCount = Array.isArray(buckets?.tomorrow) ? buckets.tomorrow.length : 0;
      const overdueCount = Array.isArray(buckets?.overdue) ? buckets.overdue.length : 0;
      return truncateHeadline(
        `Checklist (today: ${todayCount}, tomorrow: ${tomorrowCount}, overdue: ${overdueCount})`,
      );
    }
    default: {
      const parts: string[] = [];
      for (const key of SAFE_SCALAR_KEYS) {
        const snippet = cleanSnippet(obj[key], 48);
        if (snippet) parts.push(`${key}: ${snippet}`);
      }
      for (const key of BULKY_LIST_KEYS) {
        const val = obj[key];
        if (Array.isArray(val)) parts.push(`${key}: ${val.length} items`);
      }
      const serializedChars = formatNumberOrZero(JSON.stringify(obj).length);
      if (parts.length === 0) {
        return truncateHeadline(`output (${serializedChars} chars)`);
      }
      return truncateHeadline(`${parts.join(", ")} (${serializedChars} chars)`);
    }
  }
}

export function microCompactToolOutputLine(
  toolName: string,
  projectedOutput: unknown,
): string {
  const headline = summarizeToolOutputHeadline(toolName, projectedOutput);
  return `Tool ${toolName} returned [compacted earlier output]: ${headline}. Re-call ${toolName} if full details are needed.`;
}

export function microCompactToolOutputValue(
  toolName: string,
  projectedOutput: unknown,
): Record<string, unknown> {
  return {
    _compacted: true,
    tool: toolName,
    summary: summarizeToolOutputHeadline(toolName, projectedOutput),
    hint: "Earlier tool output omitted to save context; re-call the tool if full details are needed.",
  };
}
