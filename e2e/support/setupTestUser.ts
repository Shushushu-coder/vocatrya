import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { CONTACT_ROLES, JOB_SOURCES, JOB_STATUSES } from "../../src/lib/constants";
import { E2E_TEST_USER } from "./testUser";
import { AiProvider, OllamaModel } from "../../src/models/ai.model";
import { defaultUserSettings, type UserSettingsData } from "../../src/models/userSettings.model";

// E2E entry points only. Mirrors signup's baseline without importing server
// actions, auth, or the application's singleton Prisma client.
export async function setupTestUser(prisma: PrismaClient) {
  const existing = await prisma.user.findUnique({
    where: { email: E2E_TEST_USER.email },
  });
  const password = existing && await bcrypt.compare(E2E_TEST_USER.password, existing.password)
    ? existing.password
    : await bcrypt.hash(E2E_TEST_USER.password, 10);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: E2E_TEST_USER.email },
      update: { password },
      create: { ...E2E_TEST_USER, password },
    });
    for (const source of JOB_SOURCES) {
      await tx.jobSource.upsert({
        where: { value_createdBy: { value: source.value, createdBy: user.id } },
        update: { label: source.label },
        create: { ...source, createdBy: user.id },
      });
    }
    for (const role of CONTACT_ROLES) {
      await tx.contactRole.upsert({
        where: { value_createdBy: { value: role.value, createdBy: user.id } },
        update: { label: role.label },
        create: { ...role, createdBy: user.id },
      });
    }
    for (const status of JOB_STATUSES) {
      await tx.jobStatus.upsert({
        where: { value: status.value },
        update: {},
        create: status,
      });
    }
    // Assistant specs stub Ollama reachability and chat, but the normal
    // preflight still requires a selected model. Keep this E2E-only setting
    // deterministic, preserving other fixture preferences and stable timestamps.
    const existingSettings = await tx.userSettings.findUnique({ where: { userId: user.id } });
    const saved = existingSettings ? JSON.parse(existingSettings.settings) as Partial<UserSettingsData> : {};
    const settings = JSON.stringify({
      ...defaultUserSettings,
      ...saved,
      ai: { ...saved.ai, provider: AiProvider.OLLAMA, model: OllamaModel.LLAMA3_2 },
    });
    if (existingSettings?.settings !== settings) {
      await tx.userSettings.upsert({
        where: { userId: user.id },
        update: { settings },
        create: { userId: user.id, settings },
      });
    }
    return { userId: user.id };
  });
}
