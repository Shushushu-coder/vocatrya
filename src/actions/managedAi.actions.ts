"use server";

import db from "@/lib/db";
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import {
  AssignmentWriteError,
  assignManagedBusinessSource,
} from "@/lib/ai/assignments";
import { bootstrapManagedAiForUser } from "@/lib/ai/managed-bootstrap";
import {
  HostedManagedClient,
  type ManagedEntitlement,
  type ManagedUsageSummary,
} from "@/lib/ai/managed-client";
import { managedBusinessError } from "@/lib/ai/managed-dispatch";
import { AIBusinessError } from "@/lib/ai/connections";
import type { ManagedModelDTO } from "@/lib/ai/managed-contract";
import {
  MANAGED_NOT_LAUNCHED,
  managedAiAvailability,
  type ManagedAiAvailability,
} from "@/lib/ai/managed-availability";

export interface ManagedAiOverview {
  /**
   * COMING_SOON: this release does not offer Managed AI — no Hosted request
   * was made and every field below is empty (not an outage). ENABLED: the
   * fields are live Hosted reads and errorCode reports any failure.
   */
  availability: ManagedAiAvailability;
  /** The system-provisioned Managed connection's safe metadata. */
  connection: {
    id: string;
    displayName: string;
    status: string;
    lastVerifiedAt: string | null;
  } | null;
  /** Real Hosted authority reads — null when the service cannot be reached. */
  entitlement: ManagedEntitlement | null;
  usage: ManagedUsageSummary | null;
  /** Assignable models — catalog enabled/available/text-capable AND covered by the current entitlement. Empty when the entitlement cannot be read. */
  models: { modelKey: string; displayName: string; streaming: boolean; structuredOutput: boolean }[];
  /**
   * The MANAGED_* error code when a Hosted read failed — rendered verbatim.
   * null means every read succeeded; the UI never fabricates entitlement data.
   */
  errorCode: string | null;
}

/**
 * Loads the Managed AI settings surface: bootstrap the local connection,
 * then read live entitlement + usage + catalog from the Hosted authority.
 * A Hosted read failure is reported as a stable error code — the card
 * shows its unavailable state and never falls back to another AI route.
 */
export async function getManagedAiOverview(): Promise<{
  success: boolean;
  data?: ManagedAiOverview;
  message?: string;
}> {
  try {
    const user = await requireUser();
    if (managedAiAvailability() !== "ENABLED") {
      return {
        success: true,
        data: { availability: "COMING_SOON", connection: null, entitlement: null, usage: null, models: [], errorCode: null },
      };
    }
    const client = new HostedManagedClient();

    let connection: ManagedAiOverview["connection"] = null;
    try {
      const bootstrap = await bootstrapManagedAiForUser(user.id, client);
      connection = {
        id: bootstrap.connectionId,
        displayName: bootstrap.displayName,
        status: bootstrap.status,
        lastVerifiedAt: null,
      };
      const row = await db.aIConnection.findUnique({
        where: { id: bootstrap.connectionId },
        select: { lastVerifiedAt: true },
      });
      connection.lastVerifiedAt = row?.lastVerifiedAt?.toISOString() ?? null;
    } catch (error) {
      const mapped = error instanceof AIBusinessError ? error : managedBusinessError(error);
      return {
        success: true,
        data: { availability: "ENABLED", connection: null, entitlement: null, usage: null, models: [], errorCode: mapped.code },
      };
    }

    const read = async <T>(fn: () => Promise<T>): Promise<{ value: T | null; errorCode: string | null }> => {
      try {
        return { value: await fn(), errorCode: null };
      } catch (error) {
        return { value: null, errorCode: managedBusinessError(error).code };
      }
    };
    const [entitlement, usage, catalog] = await Promise.all([
      read(() => client.entitlement(user.id)),
      read(() => client.usage(user.id)),
      read(() => client.catalog(user.id)),
    ]);
    const errorCode = entitlement.errorCode ?? usage.errorCode ?? catalog.errorCode;
    // Assignable = catalog-enabled AND inside the plan allow-list. Without a
    // readable entitlement nothing is presented as assignable — showing
    // catalog-level models anyway would overpromise what admission enforces.
    const allowedModels = new Set(entitlement.value?.allowedModels ?? []);
    const models = (catalog.value?.models ?? [])
      .filter((model: ManagedModelDTO) => model.enabled && model.available && model.capabilities.text && allowedModels.has(model.modelKey))
      .map((model: ManagedModelDTO) => ({
        modelKey: model.modelKey,
        displayName: model.displayName,
        streaming: model.capabilities.streaming,
        structuredOutput: model.capabilities.structuredOutput,
      }));
    return {
      success: true,
      data: {
        availability: "ENABLED",
        connection,
        entitlement: entitlement.value,
        usage: usage.value,
        models,
        errorCode,
      },
    };
  } catch (error) {
    return handleError(error, "Failed to load Managed AI status") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * The Managed assignment entry point the settings UI calls: bootstrap the
 * system connection through the Hosted authority, then pin the catalog
 * modelKey for the purpose. Errors keep their stable business codes —
 * never a fallback onto another route.
 */
export async function assignManagedBusinessAiSource(input: {
  purpose: string;
  modelKey: string;
}): Promise<{
  success: boolean;
  code?: string;
  message?: string;
}> {
  try {
    const user = await requireUser();
    if (managedAiAvailability() !== "ENABLED") {
      return { success: false, code: MANAGED_NOT_LAUNCHED, message: "Managed AI is not available in this release" };
    }
    await assignManagedBusinessSource({
      userId: user.id,
      purpose: input?.purpose ?? "",
      modelKey: input?.modelKey ?? "",
    });
    return { success: true };
  } catch (error) {
    if (error instanceof AssignmentWriteError) {
      return { success: false, code: error.code, message: error.message };
    }
    if (error instanceof AIBusinessError) {
      return { success: false, code: error.code, message: error.message };
    }
    return handleError(error, "Failed to save Managed AI assignment") as {
      success: boolean;
      message: string;
    };
  }
}
