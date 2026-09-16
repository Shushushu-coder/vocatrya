"use client";
import { useState } from "react";
import { useActivity } from "@/context/ActivityContext";
import { ActivityBanner } from "./ActivityBanner";
import { BreakModal } from "./BreakModal";
import { ActivityType } from "@/models/activity.model";
import { useI18n } from "@/i18n";

export function GlobalActivityBanner() {
  const { t } = useI18n();
  const { currentActivity, timeElapsed, stopActivity, isOnBreak } =
    useActivity();
  // The Break button only opens the modal; the break itself starts on play.
  const [breakOpen, setBreakOpen] = useState(false);

  if (!currentActivity) return null;

  const activityType = currentActivity.activityType as ActivityType;

  return (
    <>
      <div className="px-4 sm:px-6">
        <ActivityBanner
          title={currentActivity.activityName}
          typeLabel={activityType?.label || t("activities.fallbackType")}
          onStopActivity={stopActivity}
          onStartBreak={
            isOnBreak || breakOpen ? undefined : () => setBreakOpen(true)
          }
          elapsedTime={timeElapsed}
        />
      </div>
      {/* Portaled by Radix, so it locks the whole app from inside the banner
          and needs no separate mount in the dashboard layout. */}
      <BreakModal
        open={breakOpen || isOnBreak}
        onClose={() => setBreakOpen(false)}
      />
    </>
  );
}
