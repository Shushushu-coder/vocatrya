"use server";

import db from "@/lib/db";
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import {
  AssignmentWriteError,
  assignManagedBusinessSource,
} from "@/lib/ai/assignments";
import { bootstrapManagedAiForUser } from "@/lib/ai/managed-bootstrap";
import { managedSessionLifecycle, withManagedSessionLock } from "@/lib/ai/managed-session-lifecycle";
import {
  DesktopHostedSessionProvider,
  HostedManagedClient,
  type ManagedEntitlement,
  type ManagedUsageSummary,
} from "@/lib/ai/managed-client";
import { managedBusinessError } from "@/lib/ai/managed-dispatch";
import { AIBusinessError } from "@/lib/ai/connections";
import { ManagedError, type ManagedModelDTO } from "@/lib/ai/managed-contract";
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
   * The hosted account identity the stored session authenticates as —
   * transient, never persisted locally. Null when no live session exists.
   */
  hostedUserId: string | null;
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
        data: { availability: "COMING_SOON", connection: null, entitlement: null, usage: null, models: [], hostedUserId: null, errorCode: null },
      };
    }
    const client = new HostedManagedClient();
    let sessionRevision = managedSessionLifecycle(user.id).revision;

    // An authoritative 401 means the stored credential is dead (expired or
    // revoked) — the connection row stops claiming CONNECTED so the
    // resolver reports re-auth instead of a runnable managed source.
    // Fail-soft: a local write hiccup never masks the authoritative 401.
    const markReauthRequired = () => withManagedSessionLock(user.id, async (state) => {
      // A rejection from an older overview must not downgrade a session
      // redeemed (or disconnected) while its Hosted reads were in flight.
      if (state.revision !== sessionRevision) return;
      await db.aIConnection.updateMany({
        where: {
          userId: user.id,
          provider: "VOCATRYA",
          backendKind: "MANAGED_GATEWAY",
          authType: "MANAGED",
          archivedAt: null,
          status: "CONNECTED",
        },
        data: { status: "REAUTH_REQUIRED" },
      }).catch(() => undefined);
    });

    let connection: ManagedAiOverview["connection"] = null;
    let hostedUserId: string | null = null;
    try {
      const bootstrap = await withManagedSessionLock(user.id, async (state) => {
        sessionRevision = state.revision;
        return bootstrapManagedAiForUser(user.id, client);
      });
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
      hostedUserId = await client.identity(user.id).catch(() => null);
    } catch (error) {
      const mapped = error instanceof AIBusinessError ? error : managedBusinessError(error);
      if (mapped.code === "MANAGED_AUTH_REQUIRED") await markReauthRequired();
      return {
        success: true,
        data: { availability: "ENABLED", connection: null, entitlement: null, usage: null, models: [], hostedUserId: null, errorCode: mapped.code },
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
    const errors = [entitlement.errorCode, usage.errorCode, catalog.errorCode];
    const errorCode = errors.includes("MANAGED_AUTH_REQUIRED")
      ? "MANAGED_AUTH_REQUIRED"
      : errors.find((code) => code !== null) ?? null;
    if (errorCode === "MANAGED_AUTH_REQUIRED") {
      // The session died mid-read — the client dropped the stored credential,
      // so the row must not keep claiming CONNECTED. Report the same re-auth
      // surface the bootstrap-failure path produces.
      await markReauthRequired();
      return {
        success: true,
        data: {
          availability: "ENABLED",
          connection: null,
          entitlement: entitlement.value,
          usage: usage.value,
          models: [],
          hostedUserId: null,
          errorCode,
        },
      };
    }
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
        hostedUserId,
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

/**
 * User-facing session acquisition: the user pastes the hosted session
 * credential that was issued with their subscription (operator-provisioned;
 * never an operator token and never an upstream credential). The credential
 * is validated against the Hosted authority BEFORE it is persisted — only a
 * live session is written to the OS-backed store, then the system Managed
 * connection is bootstrapped. Errors keep stable MANAGED_* codes.
 */
export async function redeemManagedAiSession(input: {
  token: string;
}): Promise<{
  success: boolean;
  code?: string;
  message?: string;
  data?: { hostedUserId: string };
}> {
  try {
    const user = await requireUser();
    if (managedAiAvailability() !== "ENABLED") {
      return { success: false, code: MANAGED_NOT_LAUNCHED, message: "Managed AI is not available in this release" };
    }
    const token = typeof input?.token === "string" ? input.token.trim() : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return { success: false, code: "MANAGED_AUTH_REQUIRED" };
    }
    // Probe the candidate credential against the Hosted authority without
    // touching the stored session — a rejected paste drops nothing.
    const probe = new HostedManagedClient({ tokenForLocalUser: async () => token });
    let hostedUserId: string;
    try {
      hostedUserId = await probe.identity(user.id);
    } catch (error) {
      return { success: false, code: managedBusinessError(error).code };
    }
    await withManagedSessionLock(user.id, async (state) => {
      await new DesktopHostedSessionProvider().saveSession(user.id, token);
      state.revision += 1;
      await bootstrapManagedAiForUser(user.id);
    });
    return { success: true, data: { hostedUserId } };
  } catch (error) {
    if (error instanceof AIBusinessError || error instanceof ManagedError) {
      const mapped = managedBusinessError(error);
      return { success: false, code: mapped.code, message: mapped.message };
    }
    return handleError(error, "Failed to connect Managed AI") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * Drops the stored hosted session and marks the system connection
 * DISCONNECTED. Clearing is allowed even while the release gate is closed —
 * discarding a stale credential is always safe and never a fallback.
 */
export async function disconnectManagedAiSession(): Promise<{
  success: boolean;
  code?: string;
  message?: string;
}> {
  try {
    const user = await requireUser();
    await withManagedSessionLock(user.id, async (state) => {
      await new DesktopHostedSessionProvider().clearSession(user.id);
      state.revision += 1;
      await db.aIConnection.updateMany({
        where: {
          userId: user.id,
          provider: "VOCATRYA",
          backendKind: "MANAGED_GATEWAY",
          authType: "MANAGED",
          archivedAt: null,
        },
        data: { status: "DISCONNECTED" },
      });
    });
    return { success: true };
  } catch (error) {
    if (error instanceof AIBusinessError || error instanceof ManagedError) {
      const mapped = managedBusinessError(error);
      return { success: false, code: mapped.code, message: mapped.message };
    }
    return handleError(error, "Failed to disconnect Managed AI") as {
      success: boolean;
      message: string;
    };
  }
}
