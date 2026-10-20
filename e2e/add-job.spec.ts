import { addDays, format } from "date-fns";
import { test, expect, createNewJob, uniqueName } from "./fixtures";
import { PrismaClient } from "@prisma/client";
import { configureE2EDatabase } from "./support/database";
import { readE2ERuntimeContract } from "./support/runtimeContract";

const prisma = new PrismaClient({ datasourceUrl: configureE2EDatabase().url });
let runtime: Awaited<ReturnType<typeof readE2ERuntimeContract>>;
test.beforeAll(async () => { runtime = await readE2ERuntimeContract(prisma); });
test.afterAll(async () => { await prisma.$disconnect(); });

test.describe("Add New Job", () => {
  test("should allow me to add a new job", async ({ page, cleanup }) => {
    const jobText = uniqueName("developer test title");
    await createNewJob(page, jobText, cleanup);
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();
  });

  test("should edit the job created", async ({ page, cleanup }) => {
    const jobText = uniqueName("developer test title");
    await createNewJob(page, jobText, cleanup);
    await expect(page.getByText(jobText).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(
      page.getByPlaceholder("Copy and paste job link here"),
    ).toHaveValue("www.google.com");
    await expect(page.getByLabel("Job Title")).toContainText(jobText);
    await expect(page.getByLabel("Company")).toContainText(
      `company ${jobText.replace(/\s+/g, "-")}`,
    );
    await expect(page.getByLabel("Job Location")).toContainText(
      `location ${jobText.replace(/\s+/g, "-")}`,
    );
    await expect(page.getByLabel("Job Source")).toContainText("Indeed");
    await expect(page.getByLabel("Select Job Status")).toContainText(
      runtime.family === "ab" ? "Draft" : "New",
    );
    await expect(
      page.getByLabel("Job Description").getByRole("paragraph"),
    ).toContainText("test description");
    await page.getByText("test description").click();
    await page
      .getByLabel("Job Description")
      .locator("div")
      .fill("test description edited");
    await page.getByTestId("save-job-btn").click();
    // Dialog closes only on a successful save; assert that instead of the
    // toast, which auto-dismisses and can vanish before the poll under load.
    await expect(page.getByTestId("add-job-dialog-title")).not.toBeVisible();
    await page.getByRole("row", { name: jobText }).getByTestId("job-actions-menu-btn").first().click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByLabel("Job Description").getByRole("paragraph"))
      .toContainText("test description edited");
  });

  test("should delete a job", async ({ page, cleanup }) => {
    const jobText = uniqueName("developer test title delete");
    // Registered as a safety net; the test deletes the job via the UI below
    // and the cleanup API is idempotent if the row is already gone.
    const jobId = await createNewJob(page, jobText, cleanup);
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", {
      name: runtime.family === "ab" ? "Archive" : "Delete", exact: true,
    }).click();

    await expect(page.getByRole("row", { name: jobText })).not.toBeVisible();
    // The list removes the row optimistically while the archive/delete write
    // commits asynchronously afterwards. Poll the durable row with a bounded,
    // state-based wait instead of trusting the UI removal instant.
    if (runtime.family === "ab") {
      await expect(async () => {
        const archived = await prisma.jobOpportunity.findUniqueOrThrow({
          where: { id: jobId },
        });
        expect(archived.archivedAt).not.toBeNull();
        expect(archived.title).toBe(jobText);
      }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000, 2_000] });
    } else {
      await expect(async () => {
        expect(await prisma.job.findUnique({ where: { id: jobId } })).toBeNull();
      }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000, 2_000] });
    }
  });

  test("should save a job without a job url", async ({ page, cleanup }) => {
    const jobText = uniqueName("developer test title no url");
    await createNewJob(page, jobText, cleanup, { skipUrl: true });
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(
      page.getByPlaceholder("Copy and paste job link here"),
    ).toHaveValue("");
  });

  test("should persist applied status and date applied after saving", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title applied");
    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (page) => {
        await page.getByRole("switch").click();
      },
    });
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByRole("switch")).toBeChecked();
    // Applied is an irreversible historical fact — the control locks on.
    await expect(page.getByRole("switch")).toBeDisabled();
    await expect(page.getByLabel("Select Job Status")).toContainText("Applied");
    await expect(page.getByLabel("Date Applied")).toContainText(
      format(new Date(), "PP"),
    );
  });

  test("toggles applied off and on in a draft, then locks once saved", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title draft toggle");
    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (page) => {
        const appliedSwitch = page.getByRole("switch");
        const statusSelect = page.getByLabel("Select Job Status");
        const dateApplied = page.getByLabel("Date Applied");
        // An unsaved draft is reversible: undo removes only the stage and
        // date the switch itself generated.
        await appliedSwitch.click();
        await expect(appliedSwitch).toBeChecked();
        await expect(statusSelect).toContainText("Applied");
        await appliedSwitch.click();
        await expect(appliedSwitch).not.toBeChecked();
        await expect(statusSelect).toContainText("New");
        await expect(dateApplied).toContainText("Pick a date");
        await appliedSwitch.click();
      },
    });
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByRole("switch")).toBeChecked();
    await expect(page.getByRole("switch")).toBeDisabled();
    await expect(page.getByLabel("Date Applied")).toContainText(
      format(new Date(), "PP"),
    );
  });

  test("should discard the draft when cancelled", async ({ page }) => {
    // Nothing is submitted, so nothing is created and no cleanup is needed.
    await page.getByRole("button", { name: "Job", exact: true }).click();
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    await page.getByRole("switch").click();
    await expect(page.getByRole("switch")).toBeChecked();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("add-job-dialog-title")).not.toBeVisible();
  });

  test("should persist a typed salary after saving", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title salary");
    const salary = "$185k - $210k";
    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (page) => {
        // Salary is a plain optional text field — any free text is kept.
        await page.getByLabel("Salary (optional)").fill(salary);
      },
    });
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByLabel("Salary (optional)")).toHaveValue(salary);
  });

  test("should persist selected workplace type after saving", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title workplace");
    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (page) => {
        await page.getByRole("radio", { name: "Remote" }).click();
      },
    });
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByRole("radio", { name: "Remote" })).toBeChecked();
  });

  test("should persist selected due date after saving", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title due date");
    const expectedDueDate = format(addDays(new Date(), 7), "PP");
    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (page) => {
        await page.getByLabel("Due Date").click();
        await page.getByText("Select Preset").click();
        await page.getByRole("option", { name: "In a week" }).click();
      },
    });
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByLabel("Due Date")).toContainText(expectedDueDate);
  });

  test("should add and persist a note on an existing job", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title note");
    await createNewJob(page, jobText, cleanup);
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();

    await page.getByRole("button", { name: "New Note" }).click();
    const noteContainer = page
      .getByText("Add Note", { exact: true })
      .locator("..");
    await noteContainer
      .locator('[contenteditable="true"]')
      .fill("test note content");
    await noteContainer.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("test note content")).toBeVisible();
  });

  test("should show validation errors when required fields are missing", async ({
    page,
  }) => {
    // No cleanup needed: submission fails validation, so nothing is created.
    await page.getByRole("button", { name: "Job", exact: true }).click();
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();

    await page.getByTestId("save-job-btn").click();

    await expect(page.getByText("Job title is required.")).toBeVisible();
    await expect(page.getByText("Company name is required.")).toBeVisible();
    await expect(page.getByText("Location is required.")).toBeVisible();
    await expect(page.getByText("Source is required.")).toBeVisible();
  });

  test("should change job status from the jobs table actions menu", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title status menu");
    await createNewJob(page, jobText, cleanup);
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    // Radix submenus open on hover; clicking the subtrigger can toggle it
    // shut mid-open, so hover to open then wait for the item.
    await page.getByRole("menuitem", { name: "Change status" }).hover();
    const interviewItem = page.getByRole("menuitem", { name: "Interview" });
    await expect(interviewItem).toBeVisible();
    await interviewItem.click();

    // Assert on the persistent status cell rather than the toast, which
    // auto-dismisses after 5s and can vanish before the poll under load.
    await expect(
      page.getByRole("row", { name: jobText }).getByText("Interview"),
    ).toBeVisible();
  });

  test("should reuse an existing company when creating a second job", async ({
    page,
    cleanup,
  }) => {
    const firstJobText = uniqueName("developer test title reuse first");
    const secondJobText = uniqueName("developer test title reuse second");
    const sharedCompany = `company ${firstJobText.replace(/\s+/g, "-")}`;

    await createNewJob(page, firstJobText, cleanup);
    await expect(
      page.getByRole("row", { name: firstJobText }).first(),
    ).toBeVisible();

    await createNewJob(page, secondJobText, cleanup, {
      company: sharedCompany,
    });
    await expect(
      page.getByRole("row", { name: secondJobText }).first(),
    ).toBeVisible();

    await expect(
      page.getByRole("row", { name: firstJobText }).getByText(sharedCompany),
    ).toBeVisible();
    await expect(
      page.getByRole("row", { name: secondJobText }).getByText(sharedCompany),
    ).toBeVisible();
  });

  test("should find a job via the jobs search box", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title searchable");
    await createNewJob(page, jobText, cleanup);
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    const searchInput = page.getByPlaceholder("Search jobs...");
    await searchInput.fill(jobText);
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await searchInput.fill(uniqueName("no such job matches this"));
    await expect(page.getByRole("row", { name: jobText })).not.toBeVisible();
  });

  test("should filter the jobs list by status", async ({ page, cleanup }) => {
    const jobText = uniqueName("developer test title filter");
    await createNewJob(page, jobText, cleanup);
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page.getByTestId("job-filter-select").click();
    await page.getByRole("option", { name: "Rejected", exact: true }).click();
    await expect(page.getByRole("row", { name: jobText })).not.toBeVisible();

    await page.getByTestId("job-filter-select").click();
    // A fresh AB opportunity derives "draft"; "new" is only a legacy status.
    // "new" is neither a derived UI status nor an AB-hidden filter, so the AB
    // read path matches it against employmentType and returns nothing.
    const positiveStatus = runtime.family === "ab" ? "Draft" : "New";
    await page.getByRole("option", { name: positiveStatus, exact: true }).click();
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();
  });

  test("keeps the applied history when an applied job moves to interview", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title statusmove");
    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (page) => {
        await page.getByRole("switch").click();
      },
    });
    const row = page.getByRole("row", { name: jobText });
    await expect(row.first()).toBeVisible();

    await row.getByTestId("job-actions-menu-btn").first().click();
    await page.getByRole("menuitem", { name: "Change status" }).hover();
    const interviewItem = page.getByRole("menuitem", { name: "Interview" });
    await expect(interviewItem).toBeVisible();
    await interviewItem.click();
    await expect(
      row.getByText("Interview", { exact: true }),
    ).toBeVisible();

    // The status moved forward, but the job remains "ever applied" and the
    // first application date is preserved.
    await row.getByTestId("job-actions-menu-btn").first().click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByRole("switch")).toBeChecked();
    await expect(page.getByRole("switch")).toBeDisabled();
    await expect(page.getByLabel("Select Job Status")).toContainText(
      "Interview",
    );
    await expect(page.getByLabel("Date Applied")).toContainText(
      format(new Date(), "PP"),
    );
  });

  test("syncs the status filter with the URL across reload and back", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title url filter");
    await createNewJob(page, jobText, cleanup);
    // Saving closes the dialog before its effect finishes replacing
    // ?add-job=true. Let that replacement commit before pushing a filter,
    // so Back restores the saved list rather than the dialog's entry URL.
    await expect(page.getByTestId("add-job-dialog-title")).not.toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/myjobs$/);
    const row = page.getByRole("row", { name: jobText });
    await expect(row.first()).toBeVisible();

    // Selecting a status filter writes it into the URL.
    await page.getByTestId("job-filter-select").click();
    await page.getByRole("option", { name: "Rejected", exact: true }).click();
    await expect(page).toHaveURL(/[?&]filter=rejected/);
    await expect(row).not.toBeVisible();

    // Refresh restores the same filtered view from the URL.
    await page.reload();
    await expect(row).not.toBeVisible();
    await expect(page.getByTestId("job-filter-select")).toContainText(
      "Rejected",
    );

    // Back returns to the unfiltered URL and the list.
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]filter=/);
    await expect(row.first()).toBeVisible();

    // Forward re-applies the filter.
    await page.goForward();
    await expect(page).toHaveURL(/[?&]filter=rejected/);
    await expect(row).not.toBeVisible();
  });

  test("shows a no-results state when filters match nothing", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title no results");
    await createNewJob(page, jobText, cleanup);
    await expect(
      page.getByRole("row", { name: jobText }).first(),
    ).toBeVisible();

    const searchInput = page.getByPlaceholder("Search jobs...");
    await searchInput.fill(uniqueName("no-match"));
    await expect(page).toHaveURL(/[?&]search=/);
    await expect(
      page.getByText("No jobs match the current filters."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/[?&]search=/);
    await expect(
      page.getByRole("row", { name: jobText }).first(),
    ).toBeVisible();
  });

  test("should navigate to job details from the actions menu", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title view details");
    const jobId = await createNewJob(page, jobText, cleanup);
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "View Details" }).click();

    await expect(page).toHaveURL(new RegExp(`/dashboard/myjobs/${jobId}$`));
    await expect(page.getByText(jobText).first()).toBeVisible();
  });

  test("should create title, company and location with the Enter key", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title enter create");
    const suffix = jobText.replace(/\s+/g, "-");
    await createNewJob(page, jobText, cleanup, { useEnterKey: true });
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByLabel("Job Title")).toContainText(jobText);
    await expect(page.getByLabel("Company")).toContainText(`company ${suffix}`);
    await expect(page.getByLabel("Job Location")).toContainText(
      `location ${suffix}`,
    );
  });

  test("should select an existing company with the Enter key instead of duplicating it", async ({
    page,
    cleanup,
  }) => {
    const firstJobText = uniqueName("developer test title enter reuse first");
    const secondJobText = uniqueName("developer test title enter reuse second");
    const sharedCompany = `company ${firstJobText.replace(/\s+/g, "-")}`;

    await createNewJob(page, firstJobText, cleanup);
    await expect(
      page.getByRole("row", { name: firstJobText }).first(),
    ).toBeVisible();

    // The company already exists, so cmdk highlights it and Enter must select
    // rather than fall through to ComboBox's create branch.
    await createNewJob(page, secondJobText, cleanup, {
      company: sharedCompany,
      useEnterKey: true,
    });
    await expect(
      page.getByRole("row", { name: secondJobText }).first(),
    ).toBeVisible();

    await expect(
      page.getByRole("row", { name: secondJobText }).getByText(sharedCompany),
    ).toBeVisible();
  });

  test("should not create or submit when Enter is pressed on an empty combobox search", async ({
    page,
  }) => {
    // No cleanup needed: nothing should be created by this test.
    await page.getByRole("button", { name: "Job", exact: true }).click();
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();

    await expect(page.locator("div.fixed.inset-0")).toHaveCount(1);
    await expect(page.getByLabel("Job Title")).toContainText("Select Job Title");
    await page.getByLabel("Job Title").click();
    const input = page.getByPlaceholder("Create or Search Job Title");
    await input.click();
    await input.press("Enter");

    // The popover stays open and the dialog must not submit.
    await expect(input).toBeVisible();
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    await expect(page.getByText("Job title is required.")).not.toBeVisible();
  });

  test("persists legacy skill tags or saves with explicit AB field limitations", async ({
    page,
    cleanup,
  }) => {
    const jobText = uniqueName("developer test title tag");
    const tagText = uniqueName("skill tag");
    cleanup.tag(tagText);

    await createNewJob(page, jobText, cleanup, {
      beforeSave: async (page) => {
        if (runtime.family === "ab") {
          await expect(page.getByText("Resume, cover letter, and tags aren't available here yet. You can still save this job.", { exact: true })).toBeVisible();
          await expect(page.getByRole("combobox", { name: "Search or add a skill..." })).toHaveCount(0);
          await expect(page.getByLabel("Resume", { exact: true })).toHaveCount(0);
          await expect(page.getByLabel("Cover Letter", { exact: true })).toHaveCount(0);
          return;
        }
        await page
          .getByRole("combobox", { name: "Search or add a skill..." })
          .click();
        await page.getByPlaceholder("Type a skill...").fill(tagText);
        await page.getByText(`Create "${tagText}"`).click();
        // Wait for the create server action to resolve and the field to
        // update (the badge only renders once the tag id lands in form
        // state) before letting createNewJob click Save.
        await expect(page.getByText(tagText, { exact: true })).toBeVisible();
      },
    });
    await expect(page.getByRole("row", { name: jobText }).first()).toBeVisible();

    await page
      .getByRole("row", { name: jobText })
      .getByTestId("job-actions-menu-btn")
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Edit Job" }).click();
    await expect(page.getByTestId("add-job-dialog-title")).toBeVisible();
    if (runtime.family === "ab") {
      await expect(page.getByText("Resume, cover letter, and tags aren't available here yet. You can still save this job.", { exact: true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Search or add a skill..." })).toHaveCount(0);
      expect(await prisma.tag.count({ where: { label: tagText } })).toBe(0);
    } else {
      await expect(page.getByText(tagText, { exact: true })).toBeVisible();
    }
  });
});
