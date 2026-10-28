"use server";

import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import {
  claimDueReminders,
  expireStaleReminders,
  reconcileReminders,
} from "@/lib/reminders/reminderService";
import type { ReminderDelivery } from "@/lib/reminders/shared";
import { requireUser } from "./shared";

/**
 * REM-V1 renderer tick. Reconciles persisted reminder state first (covers
 * write paths with no direct hook), expires overdue anchors, then atomically
 * claims what is due. The master switch mutes delivery only — reconcile +
 * expiry still run so re-enabling sees an honest table instead of a stale
 * backlog. Delivery itself happens in the renderer via the HTML5
 * Notification API; the server never raises a toast.
 */
export async function tickReminders(): Promise<
  { success: boolean; data?: { deliveries: ReminderDelivery[] }; message?: string } | undefined
> {
  try {
    const user = await requireUser();
    const prefs = await reconcileReminders(prisma, user.id);
    if (!prefs.enabled) {
      // Delivery muted: keep tombstoning stale anchors so a later unmute is
      // not ambushed by a backlog of long-past events.
      await expireStaleReminders(prisma, user.id);
      return { success: true, data: { deliveries: [] } };
    }
    const claimed = await claimDueReminders(prisma, user.id);
    return {
      success: true,
      data: {
        deliveries: claimed.map(({ id, title, body, deepLink }) => ({
          id,
          title,
          body,
          deepLink,
        })),
      },
    };
  } catch (error) {
    return handleError(error, "Failed to process reminders.");
  }
}
