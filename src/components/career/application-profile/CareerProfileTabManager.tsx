"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n";
import {
  CAREER_PROFILE_TAB_IDS,
  type CareerProfileTabId,
  type CareerProfileTabVisibility,
} from "./careerProfileTabs";

type CareerProfileTabManagerProps = {
  visibility: CareerProfileTabVisibility;
  onToggle: (
    tabId: CareerProfileTabId,
    visible: boolean,
  ) => void | Promise<void>;
};

/**
 * 「管理 Tab」dialog: per-tab show/hide switches. Hiding only affects
 * navigation visibility — data and application-copy scope are untouched.
 * At least one tab must stay visible, so the last enabled switch is
 * disabled instead of letting the workspace go blank.
 */
export function CareerProfileTabManager({
  visibility,
  onToggle,
}: CareerProfileTabManagerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<CareerProfileTabId | null>(null);

  const visibleCount = CAREER_PROFILE_TAB_IDS.filter(
    (id) => visibility[id],
  ).length;

  async function handleToggle(tabId: CareerProfileTabId, visible: boolean) {
    setPendingId(tabId);
    try {
      await onToggle(tabId, visible);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {t("careerProfileTabs.manage")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("careerProfileTabs.manageTitle")}</DialogTitle>
          <DialogDescription>
            {t("careerProfileTabs.manageDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col divide-y">
          {CAREER_PROFILE_TAB_IDS.map((tabId) => {
            const visible = visibility[tabId];
            const isLastVisible = visible && visibleCount === 1;
            return (
              <div
                key={tabId}
                className="flex items-center justify-between gap-4 py-2"
              >
                <span className="text-sm font-medium">
                  {t(`careerProfileTabs.${tabId}`)}
                </span>
                <Switch
                  data-testid={`career-profile-tab-switch-${tabId}`}
                  checked={visible}
                  disabled={pendingId !== null || isLastVisible}
                  onCheckedChange={(checked) =>
                    void handleToggle(tabId, checked === true)
                  }
                />
              </div>
            );
          })}
        </div>
        {visibleCount === 1 && (
          <div className="text-xs text-muted-foreground">
            {t("careerProfileTabs.lastTabHint")}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
