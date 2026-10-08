export const SUBSCRIPTION_STATUSES = ["ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface HostedSubscription {
  id: string;
  hostedUserId: string;
  planKey: string;
  status: SubscriptionStatus;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  source: string;
  externalSubscriptionRef: string | null;
  sourceRevision: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedAiQuotaPeriod {
  id: string;
  hostedUserId: string;
  periodStart: number;
  periodEnd: number;
  planKey: string;
  planRevision: string;
  quotaLimitUnits: number;
  reservedUnits: number;
  committedUnits: number;
  createdAt: number;
  updatedAt: number;
}

export const USAGE_STATUSES = ["RESERVED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];
export const SETTLEMENT_STATUSES = ["RESERVED", "COMMITTED", "RELEASED"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export interface ManagedAiUsageRow {
  id: string;
  hostedUserId: string;
  business: string;
  resourceKey: string;
  operationId: string;
  invocationKey: string;
  attemptIndex: number;
  requestHash: string;
  managedBindingId: string;
  modelKey: string;
  upstreamModelId: string;
  actualModel: string | null;
  status: UsageStatus;
  settlement: SettlementStatus;
  quotaPeriodId: string;
  reservedUnits: number;
  chargedUnits: number;
  inputTokens: number | null;
  outputTokens: number | null;
  gatewayRequestId: string | null;
  latencyMs: number | null;
  errorCategory: string | null;
  createdAt: number;
  completedAt: number | null;
}

/** A committed, immutable usage row as observed for idempotency replay. */
export type UsageReceipt = Pick<ManagedAiUsageRow, "id" | "invocationKey" | "status" | "settlement" | "chargedUnits" | "createdAt" | "completedAt">;
