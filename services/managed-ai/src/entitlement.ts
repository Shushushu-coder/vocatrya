import { ManagedError } from "../../../src/lib/ai/managed-contract";
import type { PlanAuthority } from "./plan";
import type { HostedSubscription, ManagedAiQuotaPeriod } from "./types";

export interface DerivedEntitlement {
  entitled: boolean;
  subscriptionStatus: HostedSubscription["status"] | null;
  planKey: string | null;
  planRevision: string | null;
  managedAiEnabled: boolean;
  allowedModels: string[];
  periodStart: number | null;
  periodEnd: number | null;
}

export function deriveEntitlement(subscription: HostedSubscription | null, plans: PlanAuthority, now: number): DerivedEntitlement {
  if (!subscription) {
    return { entitled: false, subscriptionStatus: null, planKey: null, planRevision: null, managedAiEnabled: false, allowedModels: [], periodStart: null, periodEnd: null };
  }
  const plan = plans.plan(subscription.planKey);
  const entitled = !!plan && subscription.status === "ACTIVE" && subscription.periodStart <= now && now < subscription.periodEnd;
  return {
    entitled,
    subscriptionStatus: subscription.status,
    planKey: subscription.planKey,
    planRevision: plan ? plans.revision : null,
    managedAiEnabled: !!plan && plan.managedAiEnabled,
    allowedModels: entitled && plan ? plan.allowedModels : [],
    periodStart: subscription.periodStart,
    periodEnd: subscription.periodEnd,
  };
}

export interface EntitlementDto {
  subscriptionStatus: string | null;
  planKey: string | null;
  planRevision: string | null;
  /** Frozen accounting policy; planRevision above is current entitlement policy. */
  quotaPlanRevision: string | null;
  managedAiEnabled: boolean;
  allowedModels: string[];
  periodStart: number | null;
  periodEnd: number | null;
  quotaLimitUnits: number | null;
  reservedUnits: number;
  committedUnits: number;
  remainingUnits: number | null;
}

export function entitlementDto(entitlement: DerivedEntitlement, quotaPeriod: ManagedAiQuotaPeriod | null, planPeriodQuotaUnits: number | null): EntitlementDto {
  const quotaLimitUnits = entitlement.entitled ? (quotaPeriod ? quotaPeriod.quotaLimitUnits : planPeriodQuotaUnits) : null;
  const reservedUnits = entitlement.entitled && quotaPeriod ? quotaPeriod.reservedUnits : 0;
  const committedUnits = entitlement.entitled && quotaPeriod ? quotaPeriod.committedUnits : 0;
  const remainingUnits = entitlement.entitled && quotaLimitUnits !== null ? Math.max(0, quotaLimitUnits - committedUnits - reservedUnits) : null;
  return {
    subscriptionStatus: entitlement.subscriptionStatus,
    planKey: entitlement.planKey,
    planRevision: entitlement.planRevision,
    quotaPlanRevision: quotaPeriod?.planRevision ?? null,
    managedAiEnabled: entitlement.managedAiEnabled,
    allowedModels: entitlement.allowedModels,
    periodStart: entitlement.periodStart,
    periodEnd: entitlement.periodEnd,
    quotaLimitUnits,
    reservedUnits,
    committedUnits,
    remainingUnits,
  };
}

export function assertModelEntitled(entitlement: DerivedEntitlement, modelKey: string): void {
  if (!entitlement.entitled) throw new ManagedError("NOT_ENTITLED");
  if (!entitlement.allowedModels.includes(modelKey)) throw new ManagedError("MODEL_NOT_ALLOWED");
}
