/**
 * Idempotent QuestionBank preset installer.
 *
 * Frozen ownership: living Question.createdBy = installing userId,
 * createdVia = PRESET:<bankKey>, shareability via QuestionBankItem.
 * Does not make createdBy nullable and does not invent a SYSTEM user.
 *
 * Identity (bankKey, version):
 *   missing → create
 *   same identity + same canonical metadata → reuse
 *   same identity + metadata conflict → fail
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { DomainError, ErrorCodes, NotFoundError } from "../persistence/interviewErrors";
import { SAMPLE_PRESET } from "./sample";
import { presetContentHash, validatePreset, type PresetManifest } from "./schema";

export const QUESTION_BANK_VERSION_CONFLICT = "QUESTION_BANK_VERSION_CONFLICT";

export interface InstallQuestionBankResult {
  bankId: string;
  created: boolean;
  contentHash: string;
  questionIds: string[];
}

export async function installQuestionBank(
  db: PrismaClient,
  userId: string,
  manifestInput: unknown = SAMPLE_PRESET,
): Promise<InstallQuestionBankResult> {
  const manifest = validatePreset(manifestInput);
  const contentHash = presetContentHash(manifest);
  const existing = await db.questionBank.findUnique({
    where: { bankKey_version: { bankKey: manifest.bankKey, version: manifest.version } },
    include: { items: { orderBy: { displayOrder: "asc" } } },
  });
  if (existing) {
    if (
      existing.title !== manifest.title ||
      existing.locale !== manifest.locale ||
      existing.kind !== manifest.kind
    ) {
      throw new DomainError(
        QUESTION_BANK_VERSION_CONFLICT,
        `QuestionBank ${manifest.bankKey}@${manifest.version} metadata conflict`,
      );
    }
    return {
      bankId: existing.id,
      created: false,
      contentHash,
      questionIds: existing.items.map((item) => item.questionId),
    };
  }

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found", ErrorCodes.USER_NOT_FOUND);
  }

  return db.$transaction(async (tx) => {
    const bank = await tx.questionBank.create({
      data: {
        id: randomUUID(),
        bankKey: manifest.bankKey,
        version: manifest.version,
        title: manifest.title,
        locale: manifest.locale,
        kind: manifest.kind,
      },
    });
    const questionIds: string[] = [];
    for (const [index, item] of manifest.items.entries()) {
      const existingQuestion = await tx.question.findFirst({
        where: { presetBankKey: manifest.bankKey, presetItemKey: item.itemKey },
      });
      const questionId = existingQuestion?.id ?? randomUUID();
      if (!existingQuestion) {
        await tx.question.create({
          data: {
            id: questionId,
            question: item.promptText,
            answer: item.referenceAnswer ?? null,
            createdBy: userId,
            createdVia: `PRESET:${manifest.bankKey}`,
            sourceKind: item.sourceKind,
            category: item.category ?? null,
            locale: item.locale,
            isActive: true,
            presetBankKey: manifest.bankKey,
            presetItemKey: item.itemKey,
          },
        });
      }
      await tx.questionBankItem.create({
        data: {
          id: randomUUID(),
          bankId: bank.id,
          questionId,
          displayOrder: index,
        },
      });
      questionIds.push(questionId);
    }
    return { bankId: bank.id, created: true, contentHash, questionIds };
  });
}

export async function ensureCanonicalPreset(
  db: PrismaClient,
  userId: string,
  manifest: PresetManifest = SAMPLE_PRESET,
): Promise<InstallQuestionBankResult> {
  return installQuestionBank(db, userId, manifest);
}
