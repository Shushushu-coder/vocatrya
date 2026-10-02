import { PrismaClient } from "@prisma/client";
import { OPPORTUNITY_STATUS } from "@/lib/career/identities";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { test, expect, uniqueName } from "./fixtures";
import { configureE2EDatabase } from "./support/database";
import { E2E_TEST_USER } from "./support/testUser";

const database = configureE2EDatabase();
const prisma = new PrismaClient({ datasourceUrl: database.url });

test("assistant keeps the active job context and restores it for a new conversation", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: E2E_TEST_USER.email },
  });
  const titleLabel = uniqueName("Context Role");
  const companyLabel = uniqueName("Context Co");
  const resolved = await resolveJobsReadFamily(prisma);
  if (resolved.family === "blocked") {
    throw new Error(
      `Assistant context e2e cannot seed while career runtime is blocked (${resolved.reason}).`,
    );
  }

  const company = await prisma.company.create({
    data: {
      label: companyLabel,
      value: companyLabel,
      createdBy: user.id,
    },
  });
  const title = await prisma.jobTitle.create({
    data: { label: titleLabel, value: titleLabel, createdBy: user.id },
  });
  let jobId = "";
  try {
    if (resolved.family === "ab") {
      const opportunity = await prisma.jobOpportunity.create({
        data: {
          userId: user.id,
          companyId: company.id,
          title: titleLabel,
          status: OPPORTUNITY_STATUS.UNKNOWN,
          createdVia: "USER",
        },
      });
      jobId = opportunity.id;
    } else {
      const status = await prisma.jobStatus.findUniqueOrThrow({
        where: { value: "draft" },
      });
      const job = await prisma.job.create({
        data: {
          userId: user.id,
          companyId: company.id,
          jobTitleId: title.id,
          statusId: status.id,
          description: "Context role description",
          jobType: "FT",
          createdAt: new Date(),
        },
      });
      jobId = job.id;
    }

    await page.route("**/api/ai/ollama/tags", (route) =>
      route.fulfill({ contentType: "application/json", body: "{}" }),
    );
    await page.goto(`/dashboard/myjobs/${jobId}`);
    await expect(page.getByText(titleLabel).first()).toBeVisible();
    await page.getByRole("button", { name: "Open assistant" }).click();
    await page.getByTestId("agent-new-conversation").click();

    const label = `${titleLabel} · ${companyLabel}`;
    const chip = page.getByTestId("agent-context-chip");
    await expect(chip).toContainText(label);
    await page.getByRole("button", { name: `Remove ${label}` }).click();
    await expect(chip).toHaveCount(0);
    await page.getByTestId("agent-new-conversation").click();
    await expect(page.getByTestId("agent-context-chip")).toContainText(label);
  } finally {
    if (jobId) {
      if (resolved.family === "ab") {
        await prisma.jobOpportunity.deleteMany({ where: { id: jobId } });
      } else {
        await prisma.job.deleteMany({ where: { id: jobId } });
      }
    }
    await prisma.jobTitle.deleteMany({ where: { id: title.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    await prisma.$disconnect();
  }
});
