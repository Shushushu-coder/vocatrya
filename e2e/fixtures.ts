import {
  test as base,
  expect,
  type APIResponse,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "crypto";
import { E2E_TEST_USER } from "./support/testUser";

// The app's product default locale is zh-CN, but this suite is written with
// English locators. Pin the locale cookie deterministically instead of
// inheriting whatever locale a developer machine last stored in the browser.
// Call this before the first page.goto on any context that needs English.
export async function useEnglishLocale(context: BrowserContext, baseURL = "") {
  const url = baseURL || process.env.BASE_URL || "http://localhost:3737";
  await context.addCookies([
    { name: "vocatrya_locale", value: "en", url },
  ]);
}

// Unique per invocation so each test's job/company/location/title rows never
// collide with another run's leftovers — the basis for test isolation.
export function uniqueName(base: string): string {
  return `${base} ${randomUUID().slice(0, 8)}`;
}

export async function login(page: Page) {
  await page.getByPlaceholder("id@example.com").fill(E2E_TEST_USER.email);
  await page.getByRole("textbox", { name: "Password" }).fill(E2E_TEST_USER.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
}

// Fills a "search or create" combobox and picks the entry. Unique names mean
// the Create option is the expected path; the existing-option branch is a
// fallback for the rare case a prior run leaked the row.
export async function selectOrCreate(
  page: Page,
  label: string,
  placeholder: string,
  value: string,
) {
  await page.getByLabel(label).click();
  const input = page.getByPlaceholder(placeholder);
  await input.click();
  await input.fill(value);
  const createOption = page.getByText(`Create: ${value}`);
  const existingOption = page.getByRole("option", { name: value, exact: true });
  // Deterministic wait for the filtered list instead of a fixed timeout.
  await expect(createOption.or(existingOption).first()).toBeVisible();
  if (await existingOption.isVisible()) {
    await existingOption.click();
  } else {
    await createOption.click();
  }
  // The popover closes only once the selection (or the create server action,
  // which runs inside a React transition) commits the field value. Wait on
  // that — not the trigger label, which can render blank after a create
  // because ComboBox mutates its options prop in place, so options.find()
  // may miss the new row even though field.value is set correctly.
  await expect(input).not.toBeVisible({ timeout: 20000 });
}

// Same contract as selectOrCreate, but commits with the Enter key instead of
// clicking the option — ComboBox handles Enter itself on the create path and
// defers to cmdk when an option is highlighted, so both branches are covered.
export async function selectOrCreateWithEnter(
  page: Page,
  label: string,
  placeholder: string,
  value: string,
) {
  await page.getByLabel(label).click();
  const input = page.getByPlaceholder(placeholder);
  await input.click();
  await input.fill(value);
  const createOption = page.getByText(`Create: ${value}`);
  const existingOption = page.getByRole("option", { name: value, exact: true });
  await expect(createOption.or(existingOption).first()).toBeVisible();
  await input.press("Enter");
  // Same rationale as selectOrCreate: wait for the popover to close, not the
  // trigger label, which renders blank after an inline create.
  await expect(input).not.toBeVisible({ timeout: 20000 });
}

export async function createNewJob(
  page: Page,
  jobText: string,
  cleanup: CleanupRegistry,
  options?: {
    skipUrl?: boolean;
    beforeSave?: (page: Page) => Promise<void>;
    company?: string;
    location?: string;
    useEnterKey?: boolean;
  },
): Promise<string> {
  const suffix = jobText.replace(/\s+/g, "-");
  const companyText = options?.company ?? `company ${suffix}`;
  const locationText = options?.location ?? `location ${suffix}`;

  // Matches either entry point: the header's "New" create menu (menuitem
  // "Job") when starting from /dashboard, or the myjobs page's own inline
  // trigger (labeled "New Job", from AddJob.tsx) when already on
  // /dashboard/myjobs — createNewJob is called from both contexts.
  const directTrigger = page.getByRole("button", { name: /^(New )?Job$/ });
  if (await directTrigger.count()) {
    await directTrigger.first().click();
  } else {
    await page.getByTestId("header-create-menu").click();
    await page.getByRole("menuitem", { name: "Job" }).click();
  }
  await expect(page).toHaveURL(/\/dashboard\/myjobs/, { timeout: 30000 });
  // The "Job" entry auto-opens the dialog via ?add-job=true.
  await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
  if (!options?.skipUrl) {
    await page
      .getByPlaceholder("Copy and paste job link here")
      .fill("www.google.com");
  }

  // Register each Library item the moment it's persisted (the "Create" click
  // saves it via its own server action), so a failure before the job is saved
  // still tears the item down.
  const pick = options?.useEnterKey ? selectOrCreateWithEnter : selectOrCreate;
  await pick(page, "Job Title", "Create or Search Job Title", jobText);
  cleanup.title(jobText);
  await pick(page, "Company", "Create or Search Company", companyText);
  cleanup.company(companyText);
  await pick(page, "Job Location", "Create or Search Job Location", locationText);
  cleanup.location(locationText);

  await page.getByText("Part-time").click();
  await page.getByLabel("Job Source").click();
  await page.getByRole("option", { name: "Indeed" }).click();
  await expect(page.getByLabel("Job Source")).toContainText("Indeed");
  await page.getByLabel("Job Description").locator("div").click();
  await page
    .getByLabel("Job Description")
    .locator("div")
    .fill("test description");
  if (options?.beforeSave) {
    await options.beforeSave(page);
  }
  await page.getByTestId("save-job-btn").click();

  // Wait for the save action to settle and the dialog to close before asserting row visibility.
  await expect(page.getByTestId("add-job-dialog-title")).not.toBeVisible();
  // Ensure the ?add-job=true query param cleanup effect has committed.
  await expect(page).toHaveURL(/\/dashboard\/myjobs$/, { timeout: 30000 });

  // Register the saved job for deletion, and return its id (from the row link)
  // in case a test needs it. Names are unique per run, so .first() is just
  // belt-and-suspenders.
  const row = page.getByRole("row", { name: jobText }).first();
  await expect(row).toBeVisible();
  const href = await row
    .getByRole("link", { name: jobText })
    .getAttribute("href");
  const jobId = href!.split("/").pop()!;
  cleanup.job(jobId);
  return jobId;
}

// Records the ids/names a test creates so they can be torn down after the
// test, pass or fail, via the test-only cleanup API.
export type CleanupRegistry = {
  job: (id: string) => void;
  resume: (title: string) => void;
  task: (title: string) => void;
  question: (text: string) => void;
  title: (name: string) => void;
  company: (name: string) => void;
  location: (name: string) => void;
  activityType: (name: string) => void;
  activity: (name: string) => void;
  tag: (name: string) => void;
  mcpToken: (name: string) => void;
  automation: (name: string) => void;
  contact: (name: string) => void;
  contactRole: (name: string) => void;
};

type Fixtures = {
  cleanup: CleanupRegistry;
};

// A cleanup POST payload subset; the route defaults missing keys to [].
type CleanupPayload = Record<string, string[]>;

const CLEANUP_DETAIL_MAX = 240;

// A failed cleanup response can carry request or environment fragments (the
// dev server renders HTML error pages and upstream errors may echo values).
// Only a short redacted excerpt may reach the test report - never a
// connection string, credential, or the test user's identity.
function redactCleanupDetail(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\bfile:[^\s"'<>]+/gi, "[file]")
    .replace(
      /\b(?:password|passwd|pwd|secret|token|api[-_]?key|auth[-_]?token|credential|database[-_]?url|db[-_]?url|connection[-_]?string)\b\s*[:=]\s*["']?[^\s"',;}]+/gi,
      "[redacted]",
    )
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]")
    .replace(/\bbearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*\b/g, "[jwt]")
    .replace(/\s+/g, " ")
    .trim();
}

function clipCleanupDetail(text: string): string {
  return text.length > CLEANUP_DETAIL_MAX
    ? `${text.slice(0, CLEANUP_DETAIL_MAX)}...`
    : text;
}

type CleanupOutcome = { ok: true } | { ok: false; summary: string };

// Success is the route's contract {"success": true}, not merely a 2xx: a
// request bounced by the auth middleware ends as a 200 on /signin without
// touching any test data, and must not masquerade as a clean teardown.
async function inspectCleanupResponse(
  res: APIResponse,
): Promise<CleanupOutcome> {
  const status = `HTTP ${res.status()} ${res.statusText()}`.trim();
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  let parsed: unknown = null;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
  }
  // The route's own error shape is {"error": "..."}; anything else (a
  // dev-mode HTML error page, for example) is quoted raw-but-redacted.
  const routeError =
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as { error?: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : null;
  const detail = clipCleanupDetail(redactCleanupDetail(routeError ?? body));
  if (!res.ok()) {
    return { ok: false, summary: detail ? `${status} - ${detail}` : status };
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as { success?: unknown }).success === true
  ) {
    return { ok: true };
  }
  const location = new URL(res.url()).pathname;
  return {
    ok: false,
    summary: `${status} from ${location}, unexpected body${detail ? ` - ${detail}` : ""}`,
  };
}

function describeCleanupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `request error: ${clipCleanupDetail(redactCleanupDetail(message))}`;
}

export const test = base.extend<Fixtures>({
  // Auto-login every test and land on the dashboard.
  page: async ({ page, baseURL }, use) => {
    await useEnglishLocale(page.context(), baseURL);
    await page.goto("/signin");
    await login(page);
    await expect(page).toHaveURL(baseURL + "/dashboard", { timeout: 20000 });
    await use(page);
  },
  cleanup: async ({ page }, use) => {
    const jobIds: string[] = [];
    const resumes: string[] = [];
    const tasks: string[] = [];
    const questions: string[] = [];
    const titles: string[] = [];
    const companies: string[] = [];
    const locations: string[] = [];
    const activityTypes: string[] = [];
    const activities: string[] = [];
    const tags: string[] = [];
    const mcpTokens: string[] = [];
    const automations: string[] = [];
    const contacts: string[] = [];
    const contactRoles: string[] = [];
    await use({
      job: (id) => jobIds.push(id),
      resume: (title) => resumes.push(title),
      task: (title) => tasks.push(title),
      question: (text) => questions.push(text),
      title: (name) => titles.push(name),
      company: (name) => companies.push(name),
      location: (name) => locations.push(name),
      activityType: (name) => activityTypes.push(name),
      activity: (name) => activities.push(name),
      tag: (name) => tags.push(name),
      mcpToken: (name) => mcpTokens.push(name),
      automation: (name) => automations.push(name),
      contact: (name) => contacts.push(name),
      contactRole: (name) => contactRoles.push(name),
    });
    // page.request carries the session cookie; page is still alive here
    // because cleanup tears down before the page fixture.
    //
    // A cleanup failure must fail the test, not just warn: warning-only
    // teardown let a broken cleanup masquerade as a green run. The
    // combined request is tried first, keeping the success path
    // byte-identical; on failure every non-empty group is retried in the
    // route's own delete order, so one stuck resource cannot block
    // releasing the rest. All failures aggregate, then throw.
    const groups: [string, CleanupPayload][] = [
      ["automations", { automations }],
      ["jobs", { jobIds }],
      ["resumes", { resumes }],
      ["tasks", { tasks }],
      ["activities", { activities }],
      ["questions", { questions }],
      ["contacts", { contacts }],
      ["job titles", { titles }],
      ["companies", { companies }],
      ["locations", { locations }],
      ["activity types", { activityTypes }],
      ["contact roles", { contactRoles }],
      ["tags", { tags }],
      ["mcp tokens", { mcpTokens }],
    ];
    const failures: string[] = [];
    const attempt = async (label: string, data: CleanupPayload) => {
      try {
        const res = await page.request.post("/api/test/cleanup", { data });
        const outcome = await inspectCleanupResponse(res);
        if (!outcome.ok) {
          failures.push(`[${label}] ${outcome.summary}`);
        }
        return outcome.ok;
      } catch (error) {
        failures.push(`[${label}] ${describeCleanupError(error)}`);
        return false;
      }
    };
    if (
      await attempt(
        "all resources",
        Object.assign({}, ...groups.map(([, data]) => data)),
      )
    ) {
      return;
    }
    for (const [label, data] of groups) {
      const [registered] = Object.values(data);
      if (registered.length === 0) continue;
      await attempt(`${label} x${registered.length}`, data);
    }
    throw new Error(
      `E2E cleanup failed; test data may be left behind. ${failures.join(" | ")}`,
    );
  },
});

export { expect };
