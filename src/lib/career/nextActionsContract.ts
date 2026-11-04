// NEXT-ACTIONS shared contract types — dependency-free so client components
// can import them without pulling the server read model (and its Prisma
// chain) into the client bundle. Rule semantics live in
// nextActionsReadModel.ts.

export const NEXT_ACTION_RULE = {
  R1: "R1",
  R2: "R2",
  R3: "R3",
  R4: "R4",
  R5: "R5",
  R6: "R6",
  R7: "R7",
} as const;

export type NextActionRuleId =
  (typeof NEXT_ACTION_RULE)[keyof typeof NEXT_ACTION_RULE];

export const NEXT_ACTION_LIMIT = 3;

export type NextActionVariant =
  | "default" // R1/R2/R4/R7 single-copy rules
  | "noJobs" // R3: zero unarchived positions
  | "unapplied" // R3 ab: positions exist, none ever applied
  | "unappliedLegacy" // R3 legacy: positions exist, none flagged applied
  | "prepare" // R5: interview inside the attention window
  | "confirmStatus"; // R5 overdue: scheduled in the past, never marked done

export type NextActionItem = {
  /** `${ruleId}:${entityKey}` — dedup key and stable React key. */
  id: string;
  ruleId: NextActionRuleId;
  /** Position or process-step id; "account" for entity-less rules. */
  entityKey: string;
  variant: NextActionVariant;
  href: string;
  jobTitle?: string;
  companyName?: string | null;
  stepLabel?: string;
  /** R5 attention instant (ISO); the client renders it in `timeZone`. */
  attentionAt?: string;
  /** R5 calendar-day fact when the deadline DateOnly supplied attentionAt. */
  dateOn?: string | null;
  overdue?: boolean;
};
