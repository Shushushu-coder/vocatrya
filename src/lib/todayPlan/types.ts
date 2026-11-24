// Client-safe shared contract for the TODAY-PLAN per-conversation checklist.
// No server-only imports — the popover, result card, server actions and
// agent tools all consume these shapes.

export const TODAY_PLAN_DATE_TARGETS = ["today", "tomorrow"] as const;
export type TodayPlanDateTarget = (typeof TODAY_PLAN_DATE_TARGETS)[number];

export type TodayPlanItemView = {
  id: string;
  taskId: string;
  title: string;
  /** Raw Task status — "complete" renders checked. */
  status: string;
  completed: boolean;
  /** YYYY-MM-DD in the account time zone. */
  plannedOn: string;
  position: number;
};

export type TodayPlanBuckets = {
  today: TodayPlanItemView[];
  tomorrow: TodayPlanItemView[];
  /** Planned beyond tomorrow — surfaced only if data arrives there. */
  later: TodayPlanItemView[];
  /** plannedOn < today and not completed — the "此前未完成" section. */
  overdue: TodayPlanItemView[];
  /** plannedOn < today and completed — kept, never auto-rolled. */
  history: TodayPlanItemView[];
};

export type TodayPlanView = {
  conversationId: string;
  conversationTitle: string | null;
  conversationTitleFallback: string | null;
  timeZone: string;
  /** YYYY-MM-DD the server computed in the account zone. */
  today: string;
  tomorrow: string;
  buckets: TodayPlanBuckets;
};

export const TODAY_PLAN_ACTIONS = [
  "add",
  "suggest",
  "rename",
  "toggle",
  "reorder",
  "move",
  "carry_over",
  "remove",
] as const;
export type TodayPlanAction = (typeof TODAY_PLAN_ACTIONS)[number];

/** Manual UI selects rows by id; the agent names items by title. */
export type TodayPlanItemSelector =
  | { itemId: string }
  | { itemTitle: string };

export type TodayPlanWriteInput =
  | { action: "add" | "suggest"; titles: string[]; target: TodayPlanDateTarget }
  | { action: "rename"; selector: TodayPlanItemSelector; newTitle: string }
  | {
      action: "toggle";
      selector: TodayPlanItemSelector;
      /** boolean = explicit state; "flip" inverts the current one. */
      completed: boolean | "flip";
    }
  | {
      action: "reorder";
      target: TodayPlanDateTarget;
      itemIds?: string[];
      itemTitles?: string[];
    }
  | { action: "move"; selector: TodayPlanItemSelector; target: TodayPlanDateTarget }
  | { action: "carry_over" }
  | { action: "remove"; selector: TodayPlanItemSelector };

export type TodayPlanAmbiguousCandidate = {
  id: string;
  taskId: string;
  title: string;
  plannedOn: string;
};

export type TodayPlanWriteResult =
  | {
      status: "ok";
      action: TodayPlanAction;
      /** A durable write receipt — the saved plan state the card renders. */
      saved: true;
      changed: TodayPlanItemView[];
      operationId: string;
      undoable: boolean;
      /** A replayed retry returns the recorded result without re-applying. */
      replayed?: boolean;
    }
  | {
      status: "ambiguous";
      action: TodayPlanAction;
      /** Title (or reorder titles) that resolved to more than one row. */
      itemTitle?: string;
      candidates: TodayPlanAmbiguousCandidate[];
    }
  | {
      status: "not_found" | "empty" | "already_planned" | "failed";
      action: TodayPlanAction;
      itemTitle?: string;
      item?: TodayPlanItemView;
      message?: string;
    };

export type TodayPlanUndoResult =
  | {
      status: "ok";
      operationId: string;
      reverted: number;
      /** Titles whose later edits made the revert unsafe — never clobbered. */
      skipped: { title: string }[];
    }
  | { status: "already_undone"; operationId: string }
  | { status: "not_found" }
  | { status: "failed"; message?: string };

/** Client↔server event name: any successful plan write fires this so the
 *  top-bar badge, an open popover and a result card stay in sync. */
export const TODAY_PLAN_CHANGED_EVENT = "vocatrya:today-plan-changed";
