import { test, expect } from "./fixtures";
import { configureE2EDatabase } from "./support/database";
import { E2E_TEST_USER } from "./support/testUser";

// F4-UI-001 runtime probe: with NO credential configured, the OpenRouter
// interview provider must expose a usable model control, accept a
// synthetic provider/model id, save it, and restore it after reload.
// The shared E2E user's settings row is snapshotted and restored so the
// synthetic pair cannot leak into other specs. Connections are opened per
// hook and closed immediately so the dev server's own SQLite writes never
// contend with a held client.
let priorSettings: string | null = null;
let userId: string | undefined;

async function withDb<T>(fn: (prisma: import("@prisma/client").PrismaClient) => Promise<T>) {
  const database = configureE2EDatabase();
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: database.url });
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

test.beforeAll(async () => {
  await withDb(async (prisma) => {
    const user = await prisma.user.findUnique({
      where: { email: E2E_TEST_USER.email },
    });
    userId = user?.id;
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    priorSettings = row?.settings ?? null;
    // Deterministic start: no prior interview config, so the model control
    // must begin empty and Save must begin disabled.
    if (row) {
      const parsed = JSON.parse(row.settings) as Record<string, any>;
      if (parsed?.ai?.interview !== undefined) {
        delete parsed.ai.interview;
        await prisma.userSettings.update({
          where: { userId },
          data: { settings: JSON.stringify(parsed) },
        });
      }
    }
  });
});

test.afterAll(async () => {
  if (!userId) return;
  const uid = userId;
  await withDb(async (prisma) => {
    if (priorSettings === null) {
      await prisma.userSettings.deleteMany({ where: { userId: uid } });
    } else {
      await prisma.userSettings.upsert({
        where: { userId: uid },
        update: { settings: priorSettings },
        create: { userId: uid, settings: priorSettings },
      });
    }
  });
});

// Serial: both tests mutate the same E2E user's interview settings UI state.
test.describe.configure({ mode: "serial" });

test.describe("Interview AI settings — OpenRouter model selection", () => {
  test("enter model → save → reload persists, all without a credential", async ({
    page,
  }) => {
    await page.goto("/dashboard/settings");

    await page.getByRole("combobox", { name: "Interview provider" }).click();
    await page.getByRole("option", { name: "OpenRouter" }).click();

    // OpenRouter renders a free-text model input, not the dead dropdown.
    const modelInput = page.getByLabel("Interview model");
    await expect(modelInput).toBeVisible();
    await expect(modelInput).toHaveAttribute("placeholder", /provider|gpt/i);
    const save = page.getByRole("button", { name: "Save Interview AI" });
    await expect(save).toBeDisabled();

    await modelInput.fill("synthetic/e2e-probe-model");
    await expect(save).toBeEnabled();

    const saveResponse = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        res.url().includes("/dashboard/settings"),
    );
    await save.click();
    expect((await saveResponse).status()).toBe(200);
    await expect(save).toBeEnabled();

    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Interview provider" }),
    ).toContainText("OpenRouter");
    await expect(page.getByLabel("Interview model")).toHaveValue(
      "synthetic/e2e-probe-model",
    );
  });

  test("switching providers clears the stored OpenRouter model", async ({
    page,
  }) => {
    await page.goto("/dashboard/settings");

    await page.getByRole("combobox", { name: "Interview provider" }).click();
    await page.getByRole("option", { name: "OpenAI" }).click();
    await page.getByRole("combobox", { name: "Interview model" }).click();
    await page.getByRole("option", { name: "gpt-4o", exact: true }).click();

    await page.getByRole("combobox", { name: "Interview provider" }).click();
    await page.getByRole("option", { name: "OpenRouter" }).click();

    const modelInput = page.getByLabel("Interview model");
    await expect(modelInput).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Save Interview AI" }),
    ).toBeDisabled();
  });
});
