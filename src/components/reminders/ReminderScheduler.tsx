"use client";

import { useEffect } from "react";
import { tickReminders } from "@/actions/reminder.actions";
import type { ReminderDelivery } from "@/lib/reminders/shared";

const TICK_MS = 60_000;

// REM-V1 delivery boundary: notifications fire while the app process runs
// (dashboard open, minimized, or hidden to tray — the renderer keeps
// ticking). A fully quit app delivers nothing; on next launch the tick
// catches up: anchors overdue <24h still fire, older ones are marked EXPIRED
// server-side.
export default function ReminderScheduler() {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const deliver = (delivery: ReminderDelivery) => {
      if (
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      ) {
        // The row is already FIRED server-side — an environment without the
        // Notification API (or denied permission) drops the toast honestly
        // rather than replaying it forever.
        return;
      }
      try {
        new Notification(delivery.title, {
          body: delivery.body,
          // tag collapses duplicates if two renderers raced to the same row.
          tag: `vocatrya-reminder-${delivery.id}`,
        });
      } catch {
        // Notification construction can fail on odd runtimes; the server-side
        // state is already correct.
      }
    };

    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const result = await tickReminders();
        if (!stopped && result?.success) {
          for (const delivery of result.data?.deliveries ?? []) {
            deliver(delivery);
          }
        }
      } catch {
        // A failed tick is retried on the next interval — nothing is lost.
      } finally {
        inFlight = false;
      }
    };

    const scheduleNext = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        void tick().then(scheduleNext);
      }, TICK_MS);
    };

    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      // Electron grants by default; in a browser this prompts once.
      void Notification.requestPermission();
    }

    void tick();
    scheduleNext();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
