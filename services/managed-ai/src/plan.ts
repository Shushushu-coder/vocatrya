import { ManagedError } from "../../../src/lib/ai/managed-contract";

/** Versioned, server-authoritative plan policy. Never derived from a client. */
export interface ManagedPlan {
  planKey: string;
  managedAiEnabled: boolean;
  allowedModels: string[];
  periodQuotaUnits: number;
  /** modelKey -> abstract usage units per upstream invocation. Synthetic, not pricing. */
  modelUsageUnits: Record<string, number>;
}
export interface ManagedPlanConfig {
  revision: string;
  plans: ManagedPlan[];
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Plan policy is the sole model-entitlement authority. Validation fails
 * startup on any unknown model reference, duplicate plan key, missing
 * allowed-model cost, zero/negative usage units, negative quota, or empty
 * revision. Model existence is checked against the M2 catalog keys.
 */
export function validatePlanConfig(raw: unknown, catalogModelKeys: Set<string>): ManagedPlanConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Managed plan config");
  const config = raw as ManagedPlanConfig;
  if (!nonempty(config.revision) || !Array.isArray(config.plans)) throw new Error("Invalid Managed plan config");
  const keys = new Set<string>();
  for (const plan of config.plans) {
    if (!plan || typeof plan !== "object") throw new Error("Invalid Managed plan config entry");
    if (!nonempty(plan.planKey) || !/^[a-z0-9][a-z0-9._-]*$/.test(plan.planKey) || keys.has(plan.planKey)) throw new Error("Invalid Managed plan key");
    if (typeof plan.managedAiEnabled !== "boolean") throw new Error("Invalid Managed plan enabled flag");
    if (!Array.isArray(plan.allowedModels) || plan.allowedModels.length === 0 || plan.allowedModels.some(model => !nonempty(model) || !catalogModelKeys.has(model))) throw new Error("Invalid Managed plan allowed models");
    if (new Set(plan.allowedModels).size !== plan.allowedModels.length) throw new Error("Duplicate allowed model in plan");
    if (!Number.isSafeInteger(plan.periodQuotaUnits) || plan.periodQuotaUnits < 0) throw new Error("Invalid Managed plan quota");
    const usage = plan.modelUsageUnits;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("Invalid Managed plan usage units");
    const usageKeys = Object.keys(usage);
    if (usageKeys.some(key => !catalogModelKeys.has(key)) || usageKeys.some(key => !plan.allowedModels.includes(key))) throw new Error("Unknown model reference in plan usage units");
    for (const model of plan.allowedModels) {
      const units = usage[model];
      if (!Number.isSafeInteger(units) || units <= 0) throw new Error("Missing or invalid usage units for allowed model");
    }
    keys.add(plan.planKey);
  }
  return structuredClone(config);
}

export class PlanAuthority {
  private readonly byKey: Map<string, ManagedPlan>;
  private readonly config: ManagedPlanConfig;
  constructor(config: ManagedPlanConfig) {
    this.config = structuredClone(config);
    this.byKey = new Map(this.config.plans.map(plan => [plan.planKey, plan]));
  }
  get revision(): string { return this.config.revision; }
  get plans(): ManagedPlan[] { return structuredClone(this.config.plans); }
  /** Unknown or disabled plans fail closed for entitlement. */
  plan(planKey: string): ManagedPlan | undefined {
    const plan = this.byKey.get(planKey);
    return plan && plan.managedAiEnabled ? structuredClone(plan) : undefined;
  }
  usageUnits(planKey: string, modelKey: string): number {
    const plan = this.plan(planKey);
    if (!plan) throw new ManagedError("NOT_ENTITLED");
    const units = plan.modelUsageUnits[modelKey];
    if (!Number.isSafeInteger(units) || units <= 0) throw new ManagedError("MODEL_NOT_ALLOWED");
    return units;
  }
}
