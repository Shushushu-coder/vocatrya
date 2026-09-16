"use client";

import { useState, useEffect } from "react";
import { toastSuccess, toastError } from "@/lib/toast";
import type { DiscoveredJob } from "@/models/automation.model";
import {
  acceptDiscoveredJob,
  dismissDiscoveredJob,
  analyzeDiscoveredJob,
} from "@/actions/automation.actions";
import { useI18n } from "@/i18n";

// Per-job analyze/accept/dismiss, serialized through a single loading id so the
// parent can also block starting a run while one is in flight.
export function useDiscoveredJobActions(
  onRefresh: () => void,
  onBusyChange?: (busy: boolean) => void,
) {
  const { t } = useI18n();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  useEffect(() => {
    onBusyChange?.(loadingAction !== null);
  }, [loadingAction, onBusyChange]);

  const handleAnalyze = async (jobId: string) => {
    setLoadingAction(jobId);
    try {
      const result = await analyzeDiscoveredJob(jobId);
      if (result.success) {
        toastSuccess(
          t("automations.matchAnalyzedDescription"),
          t("automations.matchAnalyzed"),
        );
        onRefresh();
      } else {
        toastError(result.message);
      }
    } catch {
      toastError(t("automations.failedToAnalyze"));
    } finally {
      setLoadingAction(null);
    }
  };

  const handleAccept = async (job: DiscoveredJob) => {
    setLoadingAction(job.id);
    try {
      const result = await acceptDiscoveredJob(job.id);
      if (result.success) {
        toastSuccess(
          t("automations.jobAcceptedDescription"),
          t("automations.jobAccepted"),
        );
        onRefresh();
      } else {
        toastError(result.message);
      }
    } catch {
      toastError(t("automations.failedToAccept"));
    } finally {
      setLoadingAction(null);
    }
  };

  const handleDismiss = async (jobId: string) => {
    setLoadingAction(jobId);
    try {
      const result = await dismissDiscoveredJob(jobId);
      if (result.success) {
        toastSuccess(t("automations.jobDismissed"));
        onRefresh();
      } else {
        toastError(result.message);
      }
    } catch {
      toastError(t("automations.failedToDismiss"));
    } finally {
      setLoadingAction(null);
    }
  };

  return { loadingAction, handleAnalyze, handleAccept, handleDismiss };
}
