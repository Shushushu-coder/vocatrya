// UI-RC-JOB-ORDER shared ordering rules — the single contract the list read,
// the write mutations and the client-side optimistic update all implement.
//
// Persisted columns (Job / JobOpportunity):
//   sortOrder Int?      dense position inside its own section
//   pinnedAt  DateTime? non-null = pinned section
//
// Display order = pinned section (sortOrder asc)
//               + normal section: unpositioned rows (sortOrder null) first in
//               natural order (createdAt desc, id desc tie-break), then
//               positioned rows by sortOrder asc.
// "Unpositioned" is what makes new jobs land at the front of the normal
// section without any creation path having to write ordering data, and what
// makes the first-ever read identical to the pre-feature createdAt-desc list.
// The first ordering write materializes every unpositioned row into the
// displayed positions so nothing visibly jumps afterwards.

export type JobOrderRow = {
  id: string;
  createdAt: Date;
  sortOrder: number | null;
  pinnedAt: Date | null;
};

export type JobOrderChange =
  | { kind: "move"; jobId: string; afterJobId: string | null }
  | { kind: "pin"; jobId: string }
  | { kind: "unpin"; jobId: string };

export type JobOrderUpdate = {
  id: string;
  sortOrder: number | null;
  pinnedAt: Date | null;
};

export class JobOrderError extends Error {
  constructor(
    public code: "JOB_NOT_FOUND" | "CROSS_SECTION_MOVE",
    message: string,
  ) {
    super(message);
    this.name = "JobOrderError";
  }
}

const createdDesc = <T extends JobOrderRow>(a: T, b: T): number => {
  const diff = b.createdAt.getTime() - a.createdAt.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : -1;
};

export function orderRowsForDisplay<T extends JobOrderRow>(
  rows: readonly T[],
): T[] {
  const pinned = rows
    .filter((row) => row.pinnedAt != null)
    .sort(
      (a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.sortOrder ?? Number.MAX_SAFE_INTEGER) || createdDesc(a, b),
    );
  const normal = rows.filter((row) => row.pinnedAt == null);
  const unpositioned = normal
    .filter((row) => row.sortOrder == null)
    .sort(createdDesc);
  const positioned = normal
    .filter((row) => row.sortOrder != null)
    .sort((a, b) => a.sortOrder! - b.sortOrder! || createdDesc(a, b));
  return [...pinned, ...unpositioned, ...positioned];
}

// Applies one ordering mutation against the user's whole ordering universe
// and returns the rows to persist (only the ones whose stored value changed).
// Cross-section moves are rejected: the only way across is pin/unpin.
export function applyOrderChange(
  rows: readonly JobOrderRow[],
  change: JobOrderChange,
  now: Date = new Date(),
): { orderedIds: string[]; updates: JobOrderUpdate[] } {
  const ordered = orderRowsForDisplay(rows);
  const byId = new Map(ordered.map((row) => [row.id, row]));
  const job = byId.get(change.jobId);
  if (!job) {
    throw new JobOrderError("JOB_NOT_FOUND", "Job not found");
  }

  let pinnedIds = ordered
    .filter((row) => row.pinnedAt != null)
    .map((row) => row.id);
  let normalIds = ordered
    .filter((row) => row.pinnedAt == null)
    .map((row) => row.id);
  let nextPinnedAt: Date | null | undefined;

  if (change.kind === "move") {
    const jobIsPinned = job.pinnedAt != null;
    if (change.afterJobId === change.jobId) {
      return { orderedIds: ordered.map((row) => row.id), updates: [] };
    }
    if (change.afterJobId != null) {
      const after = byId.get(change.afterJobId);
      if (!after) {
        throw new JobOrderError("JOB_NOT_FOUND", "Job not found");
      }
      if ((after.pinnedAt != null) !== jobIsPinned) {
        throw new JobOrderError(
          "CROSS_SECTION_MOVE",
          "Cannot drag across the pinned boundary; pin or unpin the job instead.",
        );
      }
    }
    const list = (jobIsPinned ? pinnedIds : normalIds).filter(
      (id) => id !== change.jobId,
    );
    const insertAt =
      change.afterJobId == null
        ? 0
        : list.indexOf(change.afterJobId) + 1;
    list.splice(insertAt, 0, change.jobId);
    if (jobIsPinned) pinnedIds = list;
    else normalIds = list;
  } else if (change.kind === "pin") {
    pinnedIds = [change.jobId, ...pinnedIds.filter((id) => id !== change.jobId)];
    normalIds = normalIds.filter((id) => id !== change.jobId);
    nextPinnedAt = now;
  } else {
    normalIds = [change.jobId, ...normalIds.filter((id) => id !== change.jobId)];
    pinnedIds = pinnedIds.filter((id) => id !== change.jobId);
    nextPinnedAt = null;
  }

  const updates: JobOrderUpdate[] = [];
  const applySection = (ids: string[], pinned: boolean) => {
    ids.forEach((id, index) => {
      const row = byId.get(id)!;
      const pinnedAt = pinned
        ? id === change.jobId && nextPinnedAt !== undefined
          ? nextPinnedAt
          : row.pinnedAt ?? now
        : null;
      if (row.sortOrder !== index || row.pinnedAt !== pinnedAt) {
        updates.push({ id, sortOrder: index, pinnedAt });
      }
    });
  };
  applySection(pinnedIds, true);
  applySection(normalIds, false);

  return { orderedIds: [...pinnedIds, ...normalIds], updates };
}

// Maps a dnd-kit drag end onto the server's insert-after contract, using the
// section's own id list. Returns undefined when the drop is outside the
// section or is a no-op (same item) — the caller leaves state untouched.
export function resolveAfterJobId(
  sectionIds: readonly string[],
  activeId: string,
  overId: string,
): string | null | undefined {
  if (activeId === overId) return undefined;
  const activeIndex = sectionIds.indexOf(activeId);
  const overIndex = sectionIds.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0) return undefined;
  const remaining = sectionIds.filter((id) => id !== activeId);
  const overRemainingIndex = remaining.indexOf(overId);
  // Dropping below the dragged row lands after the target item; dropping
  // above lands before it (= after the item that now precedes it).
  return activeIndex < overIndex
    ? remaining[overRemainingIndex]
    : overRemainingIndex > 0
      ? remaining[overRemainingIndex - 1]
      : null;
}

// Client-side optimistic mirror of the server "move" change.
export function insertJobAfter<T extends { id: string }>(
  list: readonly T[],
  jobId: string,
  afterJobId: string | null,
): T[] {
  const job = list.find((item) => item.id === jobId);
  if (!job) return [...list];
  const remaining = list.filter((item) => item.id !== jobId);
  const insertAt = afterJobId == null ? 0 : remaining.findIndex((item) => item.id === afterJobId) + 1;
  const next = [...remaining];
  next.splice(Math.max(0, insertAt), 0, job);
  return next;
}

// Client-side optimistic mirror of pin/unpin: the job goes to the front of
// the target section and carries its new pinnedAt marker.
export function applyPinLocally<T extends { id: string; pinnedAt?: Date | null }>(
  jobs: readonly T[],
  jobId: string,
  pinned: boolean,
  now: Date = new Date(),
): T[] {
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return [...jobs];
  const nextJob = { ...job, pinnedAt: pinned ? now : null } as T;
  const remaining = jobs.filter((item) => item.id !== jobId);
  // Pin lands at the very front (the pinned section is first); unpin lands
  // at the front of the normal section, right after the last pinned row.
  const firstNormal = remaining.findIndex((item) => item.pinnedAt == null);
  const insertAt = pinned
    ? 0
    : firstNormal < 0
      ? remaining.length
      : firstNormal;
  const next = [...remaining];
  next.splice(insertAt, 0, nextJob);
  return next;
}
