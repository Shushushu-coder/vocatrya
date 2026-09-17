import type { PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "./errors";
import {
  AB_MIGRATION_STATUS,
  FRESH_NATIVE_KEY,
} from "./identities";
import { checkFreshAbEligibility } from "./freshEligibility";
import {
  readInstanceMigrationState,
  writeInstanceMigrationState,
} from "./migrationState";

export type FreshActivationResult = {
  created: number;
  status: string;
  verifiedAt: Date | null;
  idempotent: boolean;
  eligibility: Awaited<ReturnType<typeof checkFreshAbEligibility>>;
};

export async function activateFreshAbNative(
  db: PrismaClient,
): Promise<FreshActivationResult> {
  const eligibility = await checkFreshAbEligibility(db);
  if (!eligibility.eligible) {
    throw new CareerRuntimeError(
      "FRESH_ACTIVATION_REJECTED",
      `Fresh A+B activation rejected: ${eligibility.blockers.join(", ")}`,
    );
  }

  const existing = await readInstanceMigrationState(db);
  if (existing.status === AB_MIGRATION_STATUS.FRESH_READY && existing.verifiedAt) {
    const reread = await readInstanceMigrationState(db);
    if (
      reread.status !== AB_MIGRATION_STATUS.FRESH_READY ||
      reread.migrationKey !== FRESH_NATIVE_KEY ||
      reread.completedAt !== null ||
      reread.verifiedAt === null
    ) {
      throw new CareerRuntimeError(
        "FRESH_ACTIVATION_VERIFY_FAILED",
        "Existing FRESH_READY row failed verification",
      );
    }
    return {
      created: 0,
      status: reread.status,
      verifiedAt: reread.verifiedAt,
      idempotent: true,
      eligibility,
    };
  }

  await db.$transaction(async (tx) => {
    const recheck = await checkFreshAbEligibility(tx);
    if (!recheck.eligible) {
      throw new CareerRuntimeError(
        "FRESH_ACTIVATION_REJECTED",
        `Fresh A+B activation rejected on re-check: ${recheck.blockers.join(", ")}`,
      );
    }
    const now = new Date();
    await writeInstanceMigrationState(tx, {
      status: AB_MIGRATION_STATUS.FRESH_READY,
      migrationKey: FRESH_NATIVE_KEY,
      completedAt: null,
      verifiedAt: now,
      errorCode: null,
    });
  });

  const persisted = await readInstanceMigrationState(db);
  if (
    persisted.status !== AB_MIGRATION_STATUS.FRESH_READY ||
    persisted.migrationKey !== FRESH_NATIVE_KEY ||
    persisted.verifiedAt == null
  ) {
    throw new CareerRuntimeError(
      "FRESH_ACTIVATION_VERIFY_FAILED",
      "FRESH_READY state did not persist",
    );
  }

  return {
    created: 1,
    status: persisted.status,
    verifiedAt: persisted.verifiedAt,
    idempotent: false,
    eligibility,
  };
}
