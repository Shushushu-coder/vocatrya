import { readFileSync } from "node:fs";
import { PlanAuthority, validatePlanConfig } from "./plan";
import { HostedStore, type SetSubscriptionInput } from "./store";
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "./types";

const database = process.env.MANAGED_AI_DATABASE_PATH;
const planPath = process.env.MANAGED_AI_PLAN_PATH;

function fail(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }
function parseTimestamp(value: string): number {
  if (/^\d+$/.test(value)) { const ms = Number(value); if (Number.isSafeInteger(ms) && ms >= 0) return ms; }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) fail(`Invalid timestamp: ${value}`);
  return parsed;
}
function readPlanAuthority(): PlanAuthority {
  if (!planPath) fail("MANAGED_AI_PLAN_PATH required");
  const raw = JSON.parse(readFileSync(planPath, "utf8"));
  // The operator CLI does not load the model catalog; derive the model
  // universe from the plan config itself so plan shape is still validated.
  // Full catalog cross-check happens at hosted startup.
  const universe = new Set<string>();
  for (const plan of (Array.isArray(raw.plans) ? raw.plans : [])) {
    for (const model of (Array.isArray(plan.allowedModels) ? plan.allowedModels : [])) universe.add(String(model));
    for (const key of Object.keys(plan.modelUsageUnits && typeof plan.modelUsageUnits === "object" ? plan.modelUsageUnits : {})) universe.add(key);
  }
  return new PlanAuthority(validatePlanConfig(raw, universe));
}

const [command, ...args] = process.argv.slice(2);
if (!command) fail("Usage: operator-cli <set-subscription|provision-subscription|revoke-subscription> ...");
if (!database) fail("MANAGED_AI_DATABASE_PATH required");

const flags = new Set(args.filter(arg => arg.startsWith("--")));
const positional = args.filter(arg => !arg.startsWith("--"));
const has = (flag: string) => flags.has(flag);
const valueOf = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };

const plans = readPlanAuthority();
const store = new HostedStore(database, { readOnly: has("--dry-run") });
try {
  if (command === "set-subscription" || command === "provision-subscription") {
    const [hostedUserId, planKey, first, second, third] = positional;
    if (command === "provision-subscription") {
      if (!hostedUserId || !planKey || !first || !second) fail("Usage: provision-subscription <hostedUserId> <planKey> <periodStart> <periodEnd> [--status ACTIVE]");
      const status = (valueOf("--status") ?? "ACTIVE") as SubscriptionStatus;
      if (!SUBSCRIPTION_STATUSES.includes(status)) fail("Invalid status");
      run({ hostedUserId, planKey, status, periodStart: parseTimestamp(first), periodEnd: parseTimestamp(second) });
    } else {
      if (!hostedUserId || !planKey || !first || !second || !third) fail("Usage: set-subscription <hostedUserId> <planKey> <status> <periodStart> <periodEnd> [--source X] [--external-ref X] [--source-revision X] [--cancel-at-period-end] [--dry-run]");
      const status = first as SubscriptionStatus;
      if (!SUBSCRIPTION_STATUSES.includes(status)) fail("Invalid status");
      run({ hostedUserId, planKey, status, periodStart: parseTimestamp(second), periodEnd: parseTimestamp(third) });
    }
  } else if (command === "revoke-subscription") {
    const [hostedUserId] = positional;
    if (!hostedUserId) fail("Usage: revoke-subscription <hostedUserId> [--dry-run]");
    const existing = store.subscription(hostedUserId);
    if (!existing) fail(`No subscription for ${hostedUserId}`);
    run({ hostedUserId, planKey: existing.planKey, status: "CANCELED", periodStart: existing.periodStart, periodEnd: existing.periodEnd });
  } else {
    fail(`Unknown command: ${command}`);
  }

  function run(input: SetSubscriptionInput & { hostedUserId: string }): void {
    // Terminal transitions must still work after the plan is retired from plan.json.
    if ((input.status === "ACTIVE" || input.status === "PAST_DUE") && !plans.plan(input.planKey)) fail(`Unknown or disabled plan: ${input.planKey}`);
    const mutation: SetSubscriptionInput = {
      planKey: input.planKey, status: input.status, periodStart: input.periodStart, periodEnd: input.periodEnd,
      cancelAtPeriodEnd: has("--cancel-at-period-end"), source: valueOf("--source") ?? "OPERATOR",
      externalSubscriptionRef: valueOf("--external-ref"), sourceRevision: valueOf("--source-revision"),
    };
    if (has("--dry-run")) {
      const preview = store.previewSubscription(input.hostedUserId, mutation);
      process.stdout.write(`${JSON.stringify({ dryRun: true, hostedUserId: input.hostedUserId, ...preview })}\n`);
      return;
    }
    const result = store.setSubscription(input.hostedUserId, mutation);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  store.close();
}
