"use client";
import { Check } from "lucide-react";
import { DropdownMenuItem } from "../ui/dropdown-menu";
import { JobStatus } from "@/models/job.model";

import { useI18n, getLocalizedJobStatus } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";

type JobStatusMenuItemsProps = {
  jobStatuses: JobStatus[];
  currentStatusId: string;
  onSelectStatus: (status: JobStatus) => void;
};

// Shared by the ⋮ menus and the clickable status badge so the three
// status pickers can't drift apart.
export function JobStatusMenuItems({
  jobStatuses,
  currentStatusId,
  onSelectStatus,
}: JobStatusMenuItemsProps) {
  const { t } = useI18n();
  const { jobMutationsEnabled } = useCareerSurfaces();

  return (
    <>
      {jobStatuses.map((status) => (
        <DropdownMenuItem
          className="cursor-pointer relative pl-8"
          key={status.id}
          onSelect={() => onSelectStatus(status)}
          disabled={!jobMutationsEnabled || status.id === currentStatusId}
        >
          {status.id === currentStatusId && (
            <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
              <Check className="h-4 w-4" />
            </span>
          )}
          <span>{getLocalizedJobStatus(status, t)}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}
