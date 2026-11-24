import "server-only";
import { randomUUID } from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import {
  addDaysToDateOnly,
  compareDateOnly,
  todayDateOnly,
} from "@/lib/datetime";
import {
  listAwaitingReflectionInterviews,
  listUpcomingApplicationEvents,
  UPCOMING_EVENT_KIND,
} from "@/lib/career/upcomingReadModel";
import type {
  TodayPlanAmbiguousCandidate,
  TodayPlanBuckets,
  TodayPlanItemView,
  TodayPlanUndoResult,
  TodayPlanView,
  TodayPlanWriteInput,
  TodayPlanWriteResult,
} from "./types";

type Db = PrismaClient | Prisma.TransactionClient;

const OPEN_TASK_STATUSES = ["in-progress", "needs-attention"] as const;
const MAX_TITLE_LENGTH = 200;
const MAX_ADD_TITLES = 20;
const AMBIGUOUS_CANDIDATE_LIMIT = 5;

export type TodayPlanContext = {
  userId: string;
  conversationId: string;
  /** Resolved account zone — actions/tools read it once at their entry. */
  timeZone: string;
  /** Injectable clock for deterministic tests. */
  now?: Date;
};

const ITEM_SELECT = {
  id: true,
  taskId: true,
  plannedOn: true,
  position: true,
  createdAt: true,
  updatedAt: true,
  task: {
    select: { id: true, title: true, status: true, updatedAt: true },
  },
} satisfies Prisma.TodayPlanItemSelect;

type PlanItemRow = Prisma.TodayPlanItemGetPayload<{ select: typeof ITEM_SELECT }>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function viewOf(row: PlanItemRow): TodayPlanItemView {
  return {
    id: row.id,
    taskId: row.taskId,
    title: row.task.title,
    status: row.task.status,
    completed: row.task.status === "complete",
    plannedOn: row.plannedOn,
    position: row.position,
  };
}

function emptyBuckets(): TodayPlanBuckets {
  return { today: [], tomorrow: [], later: [], overdue: [], history: [] };
}

function bucketOf(
  rows: PlanItemRow[],
  today: string,
  tomorrow: string,
): TodayPlanBuckets {
  const buckets = emptyBuckets();
  for (const row of rows) {
    const item = viewOf(row);
    if (compareDateOnly(row.plannedOn, today) < 0) {
      (item.completed ? buckets.history : buckets.overdue).push(item);
    } else if (row.plannedOn === today) {
      buckets.today.push(item);
    } else if (row.plannedOn === tomorrow) {
      buckets.tomorrow.push(item);
    } else {
      buckets.later.push(item);
    }
  }
  return buckets;
}

async function ownedConversation(
  db: Db,
  userId: string,
  conversationId: string,
) {
  // Archived conversations are read-only for AI and read-nothing for the
  // plan surface — the popover only ever follows the active conversation,
  // which can never be archived, so both paths share the null gate.
  return db.chatConversation.findFirst({
    where: { id: conversationId, userId, archivedAt: null },
    select: { id: true, title: true },
  });
}

async function loadItems(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<PlanItemRow[]> {
  return db.todayPlanItem.findMany({
    where: { userId, conversationId },
    orderBy: [
      { plannedOn: "asc" },
      { position: "asc" },
      { createdAt: "asc" },
    ],
    select: ITEM_SELECT,
  });
}

/**
 * Read the active conversation's checklist. Returns null when the
 * conversation is missing, archived or not owned — the caller maps that to
 * its own not-found/empty surface. Every bucket is recomputed from the
 * account zone on each call, so a day rollover can never serve stale dates.
 */
export async function readTodayPlan(
  ctx: TodayPlanContext,
  db: Db = prisma,
): Promise<TodayPlanView | null> {
  const conversation = await ownedConversation(
    db,
    ctx.userId,
    ctx.conversationId,
  );
  if (!conversation) return null;
  const today = todayDateOnly(ctx.timeZone, ctx.now);
  const tomorrow = addDaysToDateOnly(today, 1);
  const rows = await loadItems(db, ctx.userId, ctx.conversationId);
  return {
    conversationId: ctx.conversationId,
    conversationTitle: conversation.title,
    // The store derives titleFallback from message history; the panel keeps
    // this null and lets the client fall back to a generic label — decoding
    // the transcript here would be the wrong cost for a badge refresh.
    conversationTitleFallback: null,
    timeZone: ctx.timeZone,
    today,
    tomorrow,
    buckets: bucketOf(rows, today, tomorrow),
  };
}

// ---------------------------------------------------------------------------
// Suggestion snapshot — real data only, each source degrading independently
// ---------------------------------------------------------------------------

export type TodayPlanSuggestionSnapshot = {
  /** Open tasks not already linked to any conversation's checklist. */
  openTasks: { taskId: string; title: string }[];
  /** Next upcoming application deadlines / process steps, sorted by attention. */
  upcoming: {
    kind: string;
    label: string;
    date: string | null;
    roleTitle: string | null;
    companyName: string | null;
  }[];
  /** Completed interviews still awaiting a reflection. */
  awaitingReflection: { count: number; items: { label: string }[] };
  /** Sources that failed — the model must say honestly what it could not read. */
  degraded: string[];
};

export async function listTodayPlanSuggestions(
  ctx: TodayPlanContext,
  db: Db = prisma,
): Promise<TodayPlanSuggestionSnapshot> {
  const degraded: string[] = [];
  const [openTasks, upcoming, awaiting] = await Promise.all([
    db.task
      .findMany({
        where: {
          userId: ctx.userId,
          status: { in: [...OPEN_TASK_STATUSES] },
          // A task already placed on ANY conversation's checklist is not a
          // suggestion — surfacing it again would read as a duplicate.
          todayPlanItems: { none: {} },
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { id: true, title: true },
      })
      .catch(() => {
        degraded.push("openTasks");
        return [] as { id: string; title: string }[];
      }),
    listUpcomingApplicationEvents(prisma, ctx.userId, ctx.timeZone)
      .then((envelope) => envelope.events.slice(0, 8))
      .catch(() => {
        degraded.push("upcoming");
        return [] as Awaited<
          ReturnType<typeof listUpcomingApplicationEvents>
        >["events"];
      }),
    listAwaitingReflectionInterviews(prisma, ctx.userId, { limit: 5 }).catch(
      () => {
        degraded.push("awaitingReflection");
        return { items: [], totalCount: 0, overdueUnclosedCount: 0 };
      },
    ),
  ]);

  return {
    openTasks: openTasks.map((task) => ({ taskId: task.id, title: task.title })),
    upcoming: upcoming.map((event) => ({
      kind: event.kind,
      label:
        event.kind === UPCOMING_EVENT_KIND.APPLICATION_DEADLINE
          ? `${event.roleTitle} 投递截止`
          : event.label || event.roleTitle,
      date: event.deadlineOn ?? event.scheduledAt ?? event.deadlineAt,
      roleTitle: event.roleTitle,
      companyName: event.companyName,
    })),
    awaitingReflection: {
      count: awaiting.totalCount,
      items: awaiting.items.map((item) => ({
        label: `${item.jobTitle} 面试复盘`,
      })),
    },
    degraded,
  };
}

// ---------------------------------------------------------------------------
// Selector resolution — title matching never guesses across ambiguity
// ---------------------------------------------------------------------------

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

type SelectorResolution =
  | { kind: "item"; row: PlanItemRow }
  | { kind: "ambiguous"; candidates: TodayPlanAmbiguousCandidate[] }
  | { kind: "not_found" };

function candidateOf(row: PlanItemRow): TodayPlanAmbiguousCandidate {
  return {
    id: row.id,
    taskId: row.taskId,
    title: row.task.title,
    plannedOn: row.plannedOn,
  };
}

function resolveSelector(
  rows: PlanItemRow[],
  selector: { itemId: string } | { itemTitle: string },
): SelectorResolution {
  if ("itemId" in selector) {
    const row = rows.find((candidate) => candidate.id === selector.itemId);
    return row
      ? { kind: "item", row }
      : { kind: "not_found" };
  }
  const wanted = normalizeTitle(selector.itemTitle);
  const exact = rows.filter((row) => normalizeTitle(row.task.title) === wanted);
  if (exact.length === 1) return { kind: "item", row: exact[0] };
  if (exact.length > 1) {
    return {
      kind: "ambiguous",
      candidates: exact.slice(0, AMBIGUOUS_CANDIDATE_LIMIT).map(candidateOf),
    };
  }
  const partial = rows.filter((row) =>
    normalizeTitle(row.task.title).includes(wanted),
  );
  if (partial.length === 1) return { kind: "item", row: partial[0] };
  if (partial.length > 1) {
    return {
      kind: "ambiguous",
      candidates: partial.slice(0, AMBIGUOUS_CANDIDATE_LIMIT).map(candidateOf),
    };
  }
  return { kind: "not_found" };
}

// ---------------------------------------------------------------------------
// Undo image — before/after states the conditional revert CASes against
// ---------------------------------------------------------------------------

type PlanItemState = {
  plannedOn: string;
  position: number;
  /** ISO updatedAt — the CAS token proving nothing touched the row since. */
  updatedAt: string;
};

type TaskState = {
  title: string;
  status: string;
  updatedAt: string;
};

type UndoEntry = {
  taskId: string;
  /** null = the plan row did not exist before this operation. */
  planItemId: string | null;
  /** null = the plan row is absent after the operation (a remove). */
  before: PlanItemState | null;
  after: PlanItemState | null;
  /** null = the operation created the task itself; undo deletes it. */
  taskBefore: TaskState | null;
  taskAfter: TaskState | null;
};

function itemStateOf(row: PlanItemRow): PlanItemState {
  return {
    plannedOn: row.plannedOn,
    position: row.position,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function taskStateOf(task: {
  title: string;
  status: string;
  updatedAt: Date;
}): TaskState {
  return {
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt.toISOString(),
  };
}

function parseUndoEntries(raw: string | null): UndoEntry[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as UndoEntry[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Write engine — dedupe ledger + transactional apply + undo image
// ---------------------------------------------------------------------------

const WRITE_KINDS = new Set([
  "add",
  "suggest",
  "rename",
  "toggle",
  "reorder",
  "move",
  "carry_over",
  "remove",
]);

function failResult(
  action: TodayPlanWriteInput["action"],
  status: "failed" | "empty" | "not_found" | "already_planned",
  extra?: { itemTitle?: string; item?: TodayPlanItemView; message?: string },
): TodayPlanWriteResult {
  return { status, action, ...extra };
}

function nextPosition(rows: PlanItemRow[], plannedOn: string): number {
  let max = -1;
  for (const row of rows) {
    if (row.plannedOn === plannedOn && row.position > max) max = row.position;
  }
  return max + 1;
}

type ApplyOutcome = {
  result: TodayPlanWriteResult;
  undo: UndoEntry[];
};

async function applyAdd(
  db: Db,
  ctx: TodayPlanContext,
  rows: PlanItemRow[],
  input: Extract<TodayPlanWriteInput, { action: "add" | "suggest" }>,
  plannedOn: string,
): Promise<ApplyOutcome> {
  // Dedupe on the normalized form while keeping the first spelling the
  // caller sent — " 简历 " and "简历" must not fork into two rows.
  const seen = new Map<string, string>();
  for (const raw of input.titles) {
    const title = raw.trim();
    if (!title) continue;
    if (title.length > MAX_TITLE_LENGTH) {
      return {
        result: failResult(input.action, "failed", {
          message: `title must be at most ${MAX_TITLE_LENGTH} chars`,
        }),
        undo: [],
      };
    }
    const normalized = normalizeTitle(title);
    if (!seen.has(normalized)) seen.set(normalized, title);
  }
  const titles = [...seen.values()];
  if (titles.length === 0) {
    return { result: failResult(input.action, "empty"), undo: [] };
  }
  if (titles.length > MAX_ADD_TITLES) {
    return {
      result: failResult(input.action, "failed", {
        message: `too many items (max ${MAX_ADD_TITLES})`,
      }),
      undo: [],
    };
  }

  // Resolve everything first — an ambiguous title aborts the whole batch
  // before a single row is written (the transaction would roll back anyway,
  // but resolving early returns a precise candidate list instead).
  const resolved: {
    title: string;
    task: { id: string; title: string } | null;
  }[] = [];
  for (const title of titles) {
    // Titles never implicitly link another conversation's (or standalone) Task.
    const local = rows.filter(row => normalizeTitle(row.task.title) === normalizeTitle(title));
    const match = local.length === 1
      ? { kind: "task" as const, task: local[0].task }
      : local.length > 1
        ? { kind: "ambiguous" as const, candidates: local.map(row => row.task) }
        : { kind: "create" as const };
    if (match.kind === "ambiguous") {
      return {
        result: {
          status: "ambiguous",
          action: input.action,
          itemTitle: title,
          candidates: match.candidates.map((candidate) => ({
            id: candidate.id,
            taskId: candidate.id,
            title: candidate.title,
            plannedOn,
          })),
        },
        undo: [],
      };
    }
    resolved.push({
      title,
      task: match.kind === "task" ? match.task : null,
    });
  }

  // A resolved task already on this conversation's checklist is reported,
  // not duplicated — one plan row per (conversation, task) by design.
  const planned: PlanItemRow[] = [];
  const pending: typeof resolved = [];
  for (const entry of resolved) {
    if (!entry.task) {
      pending.push(entry);
      continue;
    }
    const existing = rows.find(
      (row) => row.taskId === entry.task!.id,
    );
    if (existing) planned.push(existing);
    else pending.push(entry);
  }
  if (pending.length === 0 && planned.length > 0) {
    return {
      result: failResult(input.action, "already_planned", {
        item: viewOf(planned[0]),
      }),
      undo: [],
    };
  }

  const undo: UndoEntry[] = [];
  const changed: TodayPlanItemView[] = [];
  let position = nextPosition(rows, plannedOn);
  for (const entry of pending) {
    let taskId = entry.task?.id ?? null;
    let taskBefore: TaskState | null = null;
    let taskAfter: TaskState | null = null;
    if (taskId === null) {
      const task = await db.task.create({
        data: { userId: ctx.userId, title: entry.title },
        select: { id: true, title: true, status: true, updatedAt: true },
      });
      taskId = task.id;
      taskAfter = taskStateOf(task);
    } else {
      const task = await db.task.findFirst({
        where: { id: taskId, userId: ctx.userId },
        select: { title: true, status: true, updatedAt: true },
      });
      if (!task) continue; // task vanished mid-tx — skip, do not invent it
      taskBefore = taskStateOf(task);
      taskAfter = taskBefore;
    }
    const row = await db.todayPlanItem.create({
      data: {
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        taskId,
        plannedOn,
        position: position++,
      },
      select: ITEM_SELECT,
    });
    undo.push({
      taskId,
      planItemId: row.id,
      before: null,
      after: itemStateOf(row),
      taskBefore,
      taskAfter,
    });
    changed.push(viewOf(row));
  }
  // Rows resolved to an already-planned task report alongside the new rows.
  for (const existing of planned) changed.push(viewOf(existing));
  return {
    result: { status: "ok", action: input.action, saved: true, changed, operationId: "", undoable: true },
    undo,
  };
}

export type TodayPlanWriteOptions = {
  /** Client- or tool-generated dedupe key; a retry returns the recorded result. */
  operationKey: string;
  input: TodayPlanWriteInput;
};

/**
 * Apply one checklist write inside a caller-owned transaction. Replays an
 * already-recorded operationKey instead of re-applying; records the undo
 * image + result on the same transaction so a batch failure rolls back
 * completely — no half-written plan, no half-written ledger.
 */
export async function applyTodayPlanWriteInTx(
  db: Prisma.TransactionClient,
  ctx: TodayPlanContext,
  options: TodayPlanWriteOptions,
): Promise<TodayPlanWriteResult> {
  const { input } = options;
  const action = input.action;
  if (!WRITE_KINDS.has(action) || typeof options.operationKey !== "string" || !options.operationKey) {
    return failResult(action, "failed", { message: "invalid operation" });
  }

  const conversation = await ownedConversation(
    db,
    ctx.userId,
    ctx.conversationId,
  );
  if (!conversation) return failResult(action, "not_found");

  const existing = await db.todayPlanOperation.findUnique({
    where: { operationKey: options.operationKey },
    select: { resultJson: true, userId: true, conversationId: true },
  });
  if (existing?.resultJson) {
    if (existing.userId !== ctx.userId || existing.conversationId !== ctx.conversationId) {
      return failResult(action, "failed", { message: "operation key belongs to another scope" });
    }
    return {
      ...(JSON.parse(existing.resultJson) as TodayPlanWriteResult & { status: "ok" }),
      replayed: true,
    };
  }

  const today = todayDateOnly(ctx.timeZone, ctx.now);
  const tomorrow = addDaysToDateOnly(today, 1);
  const plannedOnFor = (target: "today" | "tomorrow") =>
    target === "tomorrow" ? tomorrow : today;

  const rows = await loadItems(db, ctx.userId, ctx.conversationId);
  let outcome: ApplyOutcome;

  switch (input.action) {
    case "add":
    case "suggest":
      outcome = await applyAdd(
        db,
        ctx,
        rows,
        input,
        plannedOnFor(input.target),
      );
      break;

    case "rename": {
      const resolution = resolveSelector(rows, input.selector);
      if (resolution.kind === "not_found") {
        outcome = {
          result: failResult(action, "not_found", {
            itemTitle:
              "itemTitle" in input.selector ? input.selector.itemTitle : undefined,
          }),
          undo: [],
        };
        break;
      }
      if (resolution.kind === "ambiguous") {
        outcome = {
          result: { status: "ambiguous", action, candidates: resolution.candidates },
          undo: [],
        };
        break;
      }
      const newTitle = input.newTitle.trim();
      if (!newTitle || newTitle.length > MAX_TITLE_LENGTH) {
        outcome = {
          result: failResult(action, "failed", { message: "title must be 1-200 chars" }),
          undo: [],
        };
        break;
      }
      const row = resolution.row;
      const taskBefore = taskStateOf(row.task);
      const task = await db.task.update({
        where: { id: row.taskId, userId: ctx.userId },
        data: { title: newTitle },
        select: { title: true, status: true, updatedAt: true },
      });
      const fresh = { ...row, task: { ...row.task, title: task.title } };
      outcome = {
        result: {
          status: "ok",
          action,
          saved: true,
          changed: [viewOf(fresh)],
          operationId: "",
          undoable: true,
        },
        undo: [
          {
            taskId: row.taskId,
            planItemId: row.id,
            before: itemStateOf(row),
            after: itemStateOf(row),
            taskBefore,
            taskAfter: taskStateOf(task),
          },
        ],
      };
      break;
    }

    case "toggle": {
      const resolution = resolveSelector(rows, input.selector);
      if (resolution.kind !== "item") {
        outcome = {
          result:
            resolution.kind === "ambiguous"
              ? { status: "ambiguous", action, candidates: resolution.candidates }
              : failResult(action, "not_found", {
                  itemTitle:
                    "itemTitle" in input.selector
                      ? input.selector.itemTitle
                      : undefined,
                }),
          undo: [],
        };
        break;
      }
      const row = resolution.row;
      const completed =
        input.completed === "flip"
          ? row.task.status !== "complete"
          : input.completed;
      const nextStatus = completed ? "complete" : "in-progress";
      if (row.task.status === nextStatus) {
        outcome = {
          result: failResult(action, "empty", { item: viewOf(row) }),
          undo: [],
        };
        break;
      }
      const taskBefore = taskStateOf(row.task);
      // Only the Task status moves — never percentComplete, application,
      // interview, or AgentTask execution state.
      const task = await db.task.update({
        where: { id: row.taskId, userId: ctx.userId },
        data: { status: nextStatus },
        select: { title: true, status: true, updatedAt: true },
      });
      const fresh = { ...row, task: { ...row.task, status: task.status } };
      outcome = {
        result: {
          status: "ok",
          action,
          saved: true,
          changed: [viewOf(fresh)],
          operationId: "",
          undoable: true,
        },
        undo: [
          {
            taskId: row.taskId,
            planItemId: row.id,
            before: itemStateOf(row),
            after: itemStateOf(row),
            taskBefore,
            taskAfter: taskStateOf(task),
          },
        ],
      };
      break;
    }

    case "reorder": {
      const date = plannedOnFor(input.target);
      const dateRows = rows
        .filter((row) => row.plannedOn === date)
        .sort((a, b) => a.position - b.position);
      // The reorder contract is a full permutation of that date's rows —
      // anything less would silently redate or drop the ones not named.
      const ordered: PlanItemRow[] = [];
      let reorderFailure: "shape" | "ambiguous" | null = null;
      let ambiguousTitle: string | undefined;
      let ambiguousCandidates: TodayPlanAmbiguousCandidate[] = [];
      if (input.itemIds) {
        const byId = new Map(dateRows.map((row) => [row.id, row]));
        if (
          input.itemIds.length !== dateRows.length ||
          new Set(input.itemIds).size !== input.itemIds.length ||
          input.itemIds.some((id) => !byId.has(id))
        ) {
          reorderFailure = "shape";
        } else {
          for (const id of input.itemIds) ordered.push(byId.get(id)!);
        }
      } else if (input.itemTitles) {
        if (input.itemTitles.length !== dateRows.length) {
          reorderFailure = "shape";
        } else {
          const pool = [...dateRows];
          for (const title of input.itemTitles) {
            const resolution = resolveSelector(pool, { itemTitle: title });
            if (resolution.kind === "ambiguous") {
              reorderFailure = "ambiguous";
              ambiguousTitle = title;
              ambiguousCandidates = resolution.candidates;
              break;
            }
            if (resolution.kind !== "item") {
              reorderFailure = "shape";
              break;
            }
            ordered.push(resolution.row);
            pool.splice(pool.indexOf(resolution.row), 1);
          }
        }
      } else {
        reorderFailure = "shape";
      }
      if (reorderFailure === "ambiguous") {
        outcome = {
          result: {
            status: "ambiguous",
            action,
            itemTitle: ambiguousTitle,
            candidates: ambiguousCandidates,
          },
          undo: [],
        };
        break;
      }
      if (reorderFailure === "shape") {
        outcome = {
          result: failResult(action, "failed", {
            message: "reorder needs every item on that date exactly once",
          }),
          undo: [],
        };
        break;
      }
      const undo: UndoEntry[] = [];
      const changed: TodayPlanItemView[] = [];
      for (let index = 0; index < ordered.length; index++) {
        const row = ordered[index];
        if (row.position === index) {
          changed.push(viewOf(row));
          continue;
        }
        const before = itemStateOf(row);
        const updated = await db.todayPlanItem.update({
          where: { id: row.id },
          data: { position: index },
          select: ITEM_SELECT,
        });
        undo.push({
          taskId: row.taskId,
          planItemId: row.id,
          before,
          after: itemStateOf(updated),
          taskBefore: taskStateOf(row.task),
          taskAfter: taskStateOf(row.task),
        });
        changed.push(viewOf(updated));
      }
      outcome = {
        result: {
          status: "ok",
          action,
          saved: true,
          changed,
          operationId: "",
          undoable: true,
        },
        undo,
      };
      break;
    }

    case "move": {
      const resolution = resolveSelector(rows, input.selector);
      if (resolution.kind !== "item") {
        outcome = {
          result:
            resolution.kind === "ambiguous"
              ? { status: "ambiguous", action, candidates: resolution.candidates }
              : failResult(action, "not_found", {
                  itemTitle:
                    "itemTitle" in input.selector
                      ? input.selector.itemTitle
                      : undefined,
                }),
          undo: [],
        };
        break;
      }
      const row = resolution.row;
      const date = plannedOnFor(input.target);
      if (row.plannedOn === date) {
        outcome = {
          result: failResult(action, "empty", { item: viewOf(row) }),
          undo: [],
        };
        break;
      }
      const before = itemStateOf(row);
      const updated = await db.todayPlanItem.update({
        where: { id: row.id },
        data: { plannedOn: date, position: nextPosition(rows, date) },
        select: ITEM_SELECT,
      });
      outcome = {
        result: {
          status: "ok",
          action,
          saved: true,
          changed: [viewOf(updated)],
          operationId: "",
          undoable: true,
        },
        undo: [
          {
            taskId: row.taskId,
            planItemId: row.id,
            before,
            after: itemStateOf(updated),
            taskBefore: taskStateOf(row.task),
            taskAfter: taskStateOf(row.task),
          },
        ],
      };
      break;
    }

    case "carry_over": {
      const movable = rows
        .filter(
          (row) =>
            compareDateOnly(row.plannedOn, today) < 0 &&
            row.task.status !== "complete",
        )
        .sort(
          (a, b) =>
            compareDateOnly(a.plannedOn, b.plannedOn) ||
            a.position - b.position,
        );
      if (movable.length === 0) {
        outcome = { result: failResult(action, "empty"), undo: [] };
        break;
      }
      const undo: UndoEntry[] = [];
      const changed: TodayPlanItemView[] = [];
      let position = nextPosition(rows, today);
      for (const row of movable) {
        const before = itemStateOf(row);
        const updated = await db.todayPlanItem.update({
          where: { id: row.id },
          data: { plannedOn: today, position: position++ },
          select: ITEM_SELECT,
        });
        undo.push({
          taskId: row.taskId,
          planItemId: row.id,
          before,
          after: itemStateOf(updated),
          taskBefore: taskStateOf(row.task),
          taskAfter: taskStateOf(row.task),
        });
        changed.push(viewOf(updated));
      }
      outcome = {
        result: {
          status: "ok",
          action,
          saved: true,
          changed,
          operationId: "",
          undoable: true,
        },
        undo,
      };
      break;
    }

    case "remove": {
      const resolution = resolveSelector(rows, input.selector);
      if (resolution.kind !== "item") {
        outcome = {
          result:
            resolution.kind === "ambiguous"
              ? { status: "ambiguous", action, candidates: resolution.candidates }
              : failResult(action, "not_found", {
                  itemTitle:
                    "itemTitle" in input.selector
                      ? input.selector.itemTitle
                      : undefined,
                }),
          undo: [],
        };
        break;
      }
      const row = resolution.row;
      await db.todayPlanItem.delete({ where: { id: row.id } });
      outcome = {
        result: {
          status: "ok",
          action,
          saved: true,
          changed: [viewOf(row)],
          operationId: "",
          undoable: true,
        },
        undo: [
          {
            taskId: row.taskId,
            planItemId: row.id,
            before: itemStateOf(row),
            after: null,
            taskBefore: taskStateOf(row.task),
            taskAfter: taskStateOf(row.task),
          },
        ],
      };
      break;
    }

    default:
      return failResult(action, "failed", { message: "unknown action" });
  }

  if (outcome.result.status !== "ok") return outcome.result;

  const operationId = randomUUID();
  const result: TodayPlanWriteResult = { ...outcome.result, operationId };
  try {
    await db.todayPlanOperation.create({
      data: {
        id: operationId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        operationKey: options.operationKey,
        kind: action,
        undoJson: JSON.stringify(outcome.undo),
        resultJson: JSON.stringify(result),
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      // The unique key raced us: a concurrent same-key write committed first.
      // Re-read its recorded result — our own writes roll back with the tx.
      const winner = await db.todayPlanOperation.findUnique({
        where: { operationKey: options.operationKey },
        select: { resultJson: true },
      });
      // Throw so all business writes roll back; returning here would commit them.
      void winner;
    }
    throw error;
  }
  return result;
}

/** Standalone wrapper for server actions — the agent tool instead runs the
 *  tx variant inside checkpointConversationTool's admission transaction. */
export async function applyTodayPlanWrite(
  ctx: TodayPlanContext,
  options: TodayPlanWriteOptions,
  db: PrismaClient = prisma,
): Promise<TodayPlanWriteResult> {
  return db.$transaction((tx) => applyTodayPlanWriteInTx(tx, ctx, options));
}

// ---------------------------------------------------------------------------
// Conditional undo — reverts only rows still at the recorded after-state
// ---------------------------------------------------------------------------

export async function undoTodayPlanOperationInTx(
  db: Prisma.TransactionClient,
  ctx: { userId: string; conversationId: string },
  operationId: string,
): Promise<TodayPlanUndoResult> {
  const operation = await db.todayPlanOperation.findFirst({
    where: { id: operationId, userId: ctx.userId, conversationId: ctx.conversationId },
  });
  if (!operation) return { status: "not_found" };
  // CAS claims the single undo: a double-click/concurrent retry sees count 0
  // and reports already-undone instead of reverting twice.
  const claimed = await db.todayPlanOperation.updateMany({
    where: { id: operation.id, undoneAt: null },
    data: { undoneAt: new Date() },
  });
  if (claimed.count === 0) {
    return { status: "already_undone", operationId: operation.id };
  }

  const entries = parseUndoEntries(operation.undoJson);
  const skipped: { title: string }[] = [];
  let reverted = 0;

  for (const entry of entries) {
    const task = await db.task.findFirst({
      where: { id: entry.taskId, userId: ctx.userId },
      select: { id: true, title: true, status: true, updatedAt: true },
    });
    const planRow = entry.planItemId
      ? await db.todayPlanItem.findUnique({
          where: { id: entry.planItemId, userId: ctx.userId, conversationId: ctx.conversationId, taskId: entry.taskId },
          select: ITEM_SELECT,
        })
      : null;
    const title = task?.title ?? entry.taskId;

    // Case 1 — the operation removed the plan row: restore it only while no
    // link for this task exists now (a newer one is the user's later intent).
    if (entry.after === null) {
      if (!task || !entry.before) {
        skipped.push({ title });
        continue;
      }
      const occupied = await db.todayPlanItem.findFirst({
        where: { conversationId: ctx.conversationId, taskId: entry.taskId },
        select: { id: true },
      });
      if (occupied) {
        skipped.push({ title });
        continue;
      }
      try {
        await db.todayPlanItem.create({
          data: {
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            taskId: entry.taskId,
            plannedOn: entry.before.plannedOn,
            position: entry.before.position,
          },
        });
        reverted += 1;
      } catch {
        skipped.push({ title });
      }
      continue;
    }

    // Case 2 — the plan row must still sit at the recorded after-state.
    if (
      !planRow ||
      planRow.updatedAt.toISOString() !== entry.after.updatedAt
    ) {
      skipped.push({ title });
      continue;
    }

    if (entry.before === null) {
      if (!task || !entry.taskAfter || task.updatedAt.toISOString() !== entry.taskAfter.updatedAt) {
        skipped.push({ title });
        continue;
      }
      // Created by this operation: delete the plan row, and the task too when
      // the operation minted it and it stayed untouched.
      await db.todayPlanItem.deleteMany({
        where: { id: planRow.id, updatedAt: new Date(entry.after.updatedAt) },
      });
      if (entry.taskBefore === null && task && entry.taskAfter) {
        await db.task.deleteMany({
          where: {
            id: task.id,
            updatedAt: new Date(entry.taskAfter.updatedAt),
            todayPlanItems: { none: {} },
          },
        });
      }
      reverted += 1;
      continue;
    }

    // Case 3 — in-place revert: plan fields then task fields, each CASed on
    // the recorded after-state so a later edit is never overwritten.
    const planReverted = await db.todayPlanItem.updateMany({
      where: { id: planRow.id, updatedAt: new Date(entry.after.updatedAt) },
      data: {
        plannedOn: entry.before.plannedOn,
        position: entry.before.position,
      },
    });
    let taskReverted = true;
    if (
      entry.taskBefore &&
      entry.taskAfter &&
      (entry.taskBefore.title !== entry.taskAfter.title ||
        entry.taskBefore.status !== entry.taskAfter.status)
    ) {
      if (!task) {
        taskReverted = false;
      } else {
        const result = await db.task.updateMany({
          where: {
            id: task.id,
            updatedAt: new Date(entry.taskAfter.updatedAt),
          },
          data: {
            title: entry.taskBefore.title,
            status: entry.taskBefore.status,
          },
        });
        taskReverted = result.count === 1;
      }
    }
    if (planReverted.count === 1 && taskReverted) reverted += 1;
    else skipped.push({ title });
  }

  return { status: "ok", operationId: operation.id, reverted, skipped };
}

export async function undoTodayPlanOperation(
  ctx: { userId: string; conversationId: string },
  operationId: string,
  db: PrismaClient = prisma,
): Promise<TodayPlanUndoResult> {
  return db.$transaction((tx) => undoTodayPlanOperationInTx(tx, ctx, operationId));
}
