"use client";
import { ReactNode, useMemo, type ComponentProps } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { JobResponse } from "@/models/job.model";
import { resolveAfterJobId } from "@/lib/jobs/jobOrder";
import { useJobOrderT } from "./useJobOrderT";

export const isPinnedJob = (job: JobResponse) => job.pinnedAt != null;

export function partitionJobsByPin(jobs: JobResponse[]) {
  return {
    pinnedJobs: jobs.filter(isPinnedJob),
    normalJobs: jobs.filter((job) => !isPinnedJob(job)),
  };
}

// One DndContext for the whole list. Drops are resolved per section: the
// dragged job and the drop target must sit in the same pinned/normal section
// or the drop is ignored (the item snaps back) — the only way across is the
// pin/unpin action.
export function JobOrderDndProvider({
  jobs,
  onMoveJob,
  children,
}: {
  jobs: JobResponse[];
  onMoveJob: (jobId: string, afterJobId: string | null) => void;
  children: ReactNode;
}) {
  // Small activation distance: a press on a link, badge or menu is a click,
  // not a drag — job details never open from an accidental drag gesture.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const { pinnedJobs, normalJobs } = useMemo(
    () => partitionJobsByPin(jobs),
    [jobs],
  );
  const pinnedIds = pinnedJobs.map((job) => job.id);
  const normalIds = normalJobs.map((job) => job.id);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const sectionIds = pinnedIds.includes(activeId) ? pinnedIds : normalIds;
    const afterJobId = resolveAfterJobId(sectionIds, activeId, overId);
    if (afterJobId !== undefined) onMoveJob(activeId, afterJobId);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      {children}
    </DndContext>
  );
}

// Wraps one section's items; renders no DOM so it is safe inside <tbody> and
// grids alike.
export function JobSortableSection({
  ids,
  strategy = verticalListSortingStrategy,
  children,
}: {
  ids: string[];
  strategy?: typeof verticalListSortingStrategy | typeof rectSortingStrategy;
  children: ReactNode;
}) {
  return (
    <SortableContext items={ids} strategy={strategy}>
      {children}
    </SortableContext>
  );
}

// Shared sortable wiring: setNodeRef/style go on the item root, handleProps
// go ONLY on the drag handle so the rest of the row/card never initiates a
// drag (clicks on links and menus stay clicks).
export function useJobSortable(id: string, disabled: boolean) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return {
    setNodeRef,
    isDragging,
    style: {
      transform: CSS.Transform.toString(transform),
      transition: transition ?? undefined,
    },
    handleProps: { ...attributes, ...listeners },
  };
}

export function JobDragHandle({
  handleProps,
  disabled = false,
  className = "",
}: {
  handleProps: Record<string, unknown>;
  disabled?: boolean;
  className?: string;
}) {
  const tOrder = useJobOrderT();
  return (
    <button
      type="button"
      {...(handleProps as ComponentProps<"button">)}
      disabled={disabled}
      aria-label={tOrder("jobs.dragToReorder")}
      title={tOrder("jobs.dragToReorder")}
      data-testid="job-drag-handle"
      className={`inline-flex touch-none items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30 ${
        disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"
      } ${className}`}
    >
      <GripVertical className="h-4 w-4" />
    </button>
  );
}
