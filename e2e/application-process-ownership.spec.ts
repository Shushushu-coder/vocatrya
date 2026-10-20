import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { type Page } from "@playwright/test";
import { expect, test, uniqueName, createNewJob } from "./fixtures";
import { resolveE2EDatabase } from "./support/database";

// Browser acceptance for explicit ApplicationAttempt ownership.
// Attempts and steps are created only through the product UI. Prisma reads
// the rows that UI just wrote. A second live attempt comes from rejecting
// the first application and then marking the job applied: that status menu
// is the product path that records a new submission.

// Database isolation contract. The Playwright harness resolves
// DATABASE_URL once (configureE2EDatabase -> webServer env -> global setup)
// and this spec resolves it through the same function, so the checks below
// compare canonical real paths, never URL substrings. The resolved file
// must live inside an explicitly designated disposable root:
//   - R3_EVIDENCE_DIR, when set: the harness's explicit synthetic run
//     directory (Integration disposable SQLite, future CI sandboxes); or
//   - this checkout's own prisma/ directory, but only when the checkout is
//     a linked git worktree (its .git is a file). The primary checkout's
//     prisma/ holds real development data and stays rejected.
// Anything else -- the root repository, another worktree's database,
// user-data directories, packaged installs, "../" escapes, junction
// redirects -- resolves outside every allowed root and fails closed.
function realDirectory(dir: string): string | null {
  const resolved = path.resolve(dir);
  return existsSync(resolved) ? realpathSync(resolved) : null;
}

function isInsideDir(child: string, root: string): boolean {
  const normalize = (p: string) =>
    process.platform === "win32" ? p.toLowerCase() : p;
  const relative = path.relative(normalize(root), normalize(child));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function isSameFile(a: string, b: string): boolean {
  try {
    const left = realpathSync(a);
    const right = realpathSync(b);
    return process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  } catch {
    return false;
  }
}

function resolveIsolatedProcessDatabase() {
  const database = resolveE2EDatabase(process.env.DATABASE_URL ?? "");
  const repoRoot = path.resolve(__dirname, "..");
  const allowedRoots: string[] = [];
  if (process.env.R3_EVIDENCE_DIR) {
    const evidenceDir = realDirectory(process.env.R3_EVIDENCE_DIR);
    if (evidenceDir) allowedRoots.push(evidenceDir);
  }
  const gitMarker = path.join(repoRoot, ".git");
  if (existsSync(gitMarker) && statSync(gitMarker).isFile()) {
    const prismaDir = realDirectory(path.join(repoRoot, "prisma"));
    if (prismaDir) allowedRoots.push(prismaDir);
  }
  if (!allowedRoots.some((root) => isInsideDir(database.path, root))) {
    throw new Error(
      `Refusing to run process E2E against ${database.path}: the database file must live inside this linked worktree's prisma/ directory or R3_EVIDENCE_DIR.`,
    );
  }
  if (process.env.E2E_REUSE_EXISTING_SERVER === "1") {
    const serverUrl = process.env.E2E_SERVER_DATABASE_URL;
    const server = serverUrl ? resolveE2EDatabase(serverUrl) : null;
    if (!server || !isSameFile(server.path, database.path)) {
      throw new Error(
        "Reused server is bound to a different database: set E2E_SERVER_DATABASE_URL to the running server's DATABASE_URL.",
      );
    }
  }
  return database;
}

const database = resolveIsolatedProcessDatabase();
const prisma = new PrismaClient({ datasourceUrl: database.url });

type VisibleAttempt = {
  id: string;
  submitted: string;
  recorded: string;
  stage: string;
  outcome: string;
  stepLabels: string[];
};

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async () => {
  // Engine-level check: the file SQLite actually opened is the resolved one.
  const attached = await prisma.$queryRawUnsafe<
    { name: string; file: string }[]
  >("PRAGMA database_list");
  const main = attached.find((row) => row.name === "main");
  if (!main || !isSameFile(main.file, database.path)) {
    throw new Error(
      `Prisma opened ${main?.file ?? "no database"}; expected the isolated database ${database.path}.`,
    );
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function stepsForJob(jobId: string) {
  return prisma.applicationProcessStep.count({
    where: { applicationAttempt: { jobOpportunityId: jobId } },
  });
}

async function openTimeline(page: Page, jobId: string) {
  await page.goto(`/dashboard/myjobs/${jobId}`);
  // Under a cold dev-server compile the click can land before hydration
  // attaches the tab handler: retry until Radix reports the trigger active.
  const timelineTab = page.getByRole("tab", { name: "Timeline" });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await timelineTab.click();
    if ((await timelineTab.getAttribute("data-state")) === "active") break;
    await page.waitForTimeout(500);
  }
  await expect(timelineTab).toHaveAttribute("data-state", "active");
  await expect(
    page
      .getByText("No application timeline yet")
      .or(page.getByTestId("application-timeline")),
  ).toBeVisible();
}

function stepDialog(page: Page) {
  return page.getByRole("dialog").filter({ hasText: "Add process step" });
}

async function readAttempts(page: Page): Promise<VisibleAttempt[]> {
  const sections = page.locator(
    '[data-testid="application-timeline"] section[data-attempt-id]',
  );
  const count = await sections.count();
  const rows: VisibleAttempt[] = [];
  for (let index = 0; index < count; index += 1) {
    const section = sections.nth(index);
    const id = (await section.getAttribute("data-attempt-id")) ?? "";
    const values = await section.locator("p.font-medium").evaluateAll((nodes) =>
      nodes.slice(0, 4).map((node) =>
        (node.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
    );
    const stepLabels = await section
      .getByTestId("application-process-step")
      .locator("p.font-medium")
      .allTextContents();
    rows.push({
      id,
      submitted: values[0] ?? "",
      recorded: values[1] ?? "",
      stage: values[2] ?? "",
      outcome: values[3] ?? "",
      stepLabels: stepLabels.map((label) => label.trim()),
    });
  }
  return rows;
}

async function chooseStatus(page: Page, status: string) {
  await page.getByTestId("job-details-actions-menu-btn").click();
  await page.getByRole("menuitem", { name: "Change Status" }).hover();
  await page.getByRole("menuitem", { name: status, exact: true }).click();
  await expect(page.getByText("Job has been updated successfully")).toBeVisible();
}

async function saveStep(page: Page, label: string, attemptId?: string) {
  const dialog = stepDialog(page);
  if (attemptId) {
    await dialog.getByRole("combobox", { name: "Application" }).selectOption(attemptId);
  }
  await dialog.getByLabel("Step name").fill(label);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(label, { exact: true })).toBeVisible();
}

function attemptByStage(rows: VisibleAttempt[], stage: string) {
  const match = rows.find((row) => row.stage === stage);
  expect(match, `visible attempt at stage ${stage}`).toBeTruthy();
  return match!;
}

test("opening and cancelling a step does not create a draft; saving does", async ({
  page,
  cleanup,
}) => {
  const jobTitle = uniqueName("process ownership empty");
  const jobId = await createNewJob(page, jobTitle, cleanup);
  await openTimeline(page, jobId);

  await expect(page.getByText("No application timeline yet")).toBeVisible();
  await page
    .getByRole("button", { name: "Create application draft and add step" })
    .click();

  const dialog = stepDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("attempt-draft-notice")).toContainText(
    "Saving will create an application draft",
  );
  await expect(dialog.getByRole("combobox", { name: "Application" })).toHaveCount(0);

  await dialog.getByLabel("Step name").fill("Cancelled before save");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("No application timeline yet")).toBeVisible();
  expect(
    await prisma.applicationAttempt.count({ where: { jobOpportunityId: jobId } }),
  ).toBe(0);
  expect(await stepsForJob(jobId)).toBe(0);

  await page
    .getByRole("button", { name: "Create application draft and add step" })
    .click();
  await expect(stepDialog(page)).toBeVisible();
  await expect(stepDialog(page).getByLabel("Step name")).toHaveValue("");
  await stepDialog(page).getByRole("button", { name: "Save" }).click();
  await expect(stepDialog(page).getByLabel("Step name")).toHaveJSProperty(
    "validity.valueMissing",
    true,
  );
  await expect(stepDialog(page)).toBeVisible();
  expect(
    await prisma.applicationAttempt.count({ where: { jobOpportunityId: jobId } }),
  ).toBe(0);

  await saveStep(page, "First recorded event");

  const visible = await readAttempts(page);
  expect(visible).toHaveLength(1);
  expect(visible[0]).toMatchObject({
    submitted: "N/A",
    stage: "Draft",
    outcome: "Active",
    stepLabels: ["First recorded event"],
  });

  const stored = await prisma.applicationAttempt.findMany({
    where: { jobOpportunityId: jobId },
    include: { processSteps: true },
  });
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    id: visible[0].id,
    currentStageCategory: "DRAFT",
    outcome: "ACTIVE",
    channelLabel: "USER",
    submittedAt: null,
    archivedAt: null,
  });
  expect(stored[0].processSteps).toEqual([
    expect.objectContaining({
      applicationAttemptId: stored[0].id,
      label: "First recorded event",
      source: "USER",
    }),
  ]);
});

test("an explicit choice binds the step, and submission facts stay put", async ({
  page,
  cleanup,
}) => {
  const jobTitle = uniqueName("process ownership choice");
  const jobId = await createNewJob(page, jobTitle, cleanup);
  await openTimeline(page, jobId);
  await page
    .getByRole("button", { name: "Create application draft and add step" })
    .click();
  await saveStep(page, "Original draft event");

  const draftOnly = await readAttempts(page);
  expect(draftOnly).toHaveLength(1);
  await page.getByRole("button", { name: "Add process step" }).click();
  const singleSelect = stepDialog(page).getByRole("combobox", {
    name: "Application",
  });
  await expect(singleSelect).toHaveValue(draftOnly[0].id);
  await stepDialog(page).getByRole("button", { name: "Cancel" }).click();
  expect(await page.getByTestId("application-process-step").count()).toBe(1);

  await chooseStatus(page, "Rejected");
  await expect
    .poll(async () => (await readAttempts(page)).map((row) => row.stage))
    .toEqual(["Closed"]);
  const rejected = attemptByStage(await readAttempts(page), "Closed");
  expect(rejected).toMatchObject({
    id: draftOnly[0].id,
    submitted: "N/A",
    outcome: "Rejected",
    stepLabels: ["Original draft event"],
  });
  const rejectedRecorded = rejected.recorded;

  await chooseStatus(page, "Applied");
  await expect
    .poll(async () =>
      (await readAttempts(page)).map((row) => row.stage).join("|"),
    )
    .toBe("Closed|Submitted");

  const before = await readAttempts(page);
  const closed = attemptByStage(before, "Closed");
  const submitted = attemptByStage(before, "Submitted");
  expect(closed.id).not.toBe(submitted.id);
  expect(closed.submitted).toBe("N/A");
  expect(closed.recorded).toBe(rejectedRecorded);
  expect(closed.stepLabels).toEqual(["Original draft event"]);
  expect(submitted.submitted).not.toBe("N/A");
  expect(submitted.outcome).toBe("Active");
  expect(submitted.stepLabels).toEqual([]);

  const storedBefore = await prisma.applicationAttempt.findMany({
    where: { jobOpportunityId: jobId },
  });
  const storedSubmitted = storedBefore.find((row) => row.id === submitted.id);
  const storedClosed = storedBefore.find((row) => row.id === closed.id);
  expect(storedSubmitted?.submittedAt).toBeTruthy();
  expect(storedSubmitted).toMatchObject({
    currentStageCategory: "SUBMITTED",
    outcome: "ACTIVE",
  });
  expect(storedClosed).toMatchObject({
    currentStageCategory: "CLOSED",
    outcome: "REJECTED",
    submittedAt: null,
  });

  await page.getByRole("button", { name: "Add process step" }).click();
  const dialog = stepDialog(page);
  const select = dialog.getByRole("combobox", { name: "Application" });
  await expect(select).toHaveValue("");
  const options = await select.locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: (node as HTMLOptionElement).value,
      label: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
      selected: (node as HTMLOptionElement).selected,
    })),
  );
  expect(options[0]).toMatchObject({ value: "", selected: true });
  expect(
    options.filter((option) => option.value).map((option) => option.value),
  ).toEqual([closed.id, submitted.id]);
  expect(options.find((option) => option.value === submitted.id)?.selected).toBe(
    false,
  );
  expect(options.find((option) => option.value === submitted.id)?.label).toContain(
    "Submitted",
  );
  expect(options.find((option) => option.value === closed.id)?.label).toContain(
    "Closed",
  );

  await dialog.getByLabel("Step name").fill("Missing application choice");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    dialog.getByText("Select which application this step belongs to."),
  ).toBeVisible();
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Step name").fill("Discarded draft text");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Add process step" }).click();
  await expect(stepDialog(page).getByLabel("Step name")).toHaveValue("");
  await expect(
    stepDialog(page).getByRole("combobox", { name: "Application" }),
  ).toHaveValue("");

  await saveStep(page, "Event on the closed application", closed.id);
  let visible = await readAttempts(page);
  expect(attemptByStage(visible, "Closed").stepLabels).toEqual([
    "Original draft event",
    "Event on the closed application",
  ]);
  expect(attemptByStage(visible, "Submitted").stepLabels).toEqual([]);
  expect(attemptByStage(visible, "Submitted").submitted).toBe(submitted.submitted);
  expect(attemptByStage(visible, "Closed").recorded).toBe(rejectedRecorded);

  await page.getByRole("button", { name: "Add process step" }).click();
  await expect(
    stepDialog(page).getByRole("combobox", { name: "Application" }),
  ).toHaveValue("");
  await saveStep(page, "Event on the submitted application", submitted.id);
  visible = await readAttempts(page);
  expect(attemptByStage(visible, "Submitted").stepLabels).toEqual([
    "Event on the submitted application",
  ]);
  expect(attemptByStage(visible, "Closed").stepLabels).toEqual([
    "Original draft event",
    "Event on the closed application",
  ]);

  await page.reload();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByTestId("application-timeline")).toBeVisible();
  visible = await readAttempts(page);
  expect(attemptByStage(visible, "Closed")).toMatchObject({
    id: closed.id,
    submitted: "N/A",
    recorded: rejectedRecorded,
    outcome: "Rejected",
    stepLabels: ["Original draft event", "Event on the closed application"],
  });
  expect(attemptByStage(visible, "Submitted")).toMatchObject({
    id: submitted.id,
    submitted: submitted.submitted,
    outcome: "Active",
    stepLabels: ["Event on the submitted application"],
  });

  const storedAfter = await prisma.applicationAttempt.findMany({
    where: { jobOpportunityId: jobId },
    include: { processSteps: { orderBy: { sortOrder: "asc" } } },
  });
  const closedAfter = storedAfter.find((row) => row.id === closed.id);
  const submittedAfter = storedAfter.find((row) => row.id === submitted.id);
  expect(closedAfter?.createdAt.getTime()).toBe(storedClosed?.createdAt.getTime());
  expect(closedAfter).toMatchObject({
    currentStageCategory: "CLOSED",
    outcome: "REJECTED",
    submittedAt: null,
  });
  expect(submittedAfter?.submittedAt?.toISOString()).toBe(
    storedSubmitted?.submittedAt?.toISOString(),
  );
  expect(submittedAfter).toMatchObject({
    currentStageCategory: "SUBMITTED",
    outcome: "ACTIVE",
  });
  expect(closedAfter?.processSteps.map((step) => step.label)).toEqual([
    "Original draft event",
    "Event on the closed application",
  ]);
  expect(submittedAfter?.processSteps.map((step) => step.label)).toEqual([
    "Event on the submitted application",
  ]);
  expect(
    storedAfter
      .flatMap((row) => row.processSteps)
      .every((step) => step.source === "USER"),
  ).toBe(true);
});
