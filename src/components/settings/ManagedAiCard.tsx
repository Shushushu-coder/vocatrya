"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CheckCircle, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useI18n } from "@/i18n";
import {
  getManagedAiOverview,
  type ManagedAiOverview,
} from "@/actions/managedAi.actions";

function formatPeriod(unix: number | null): string | null {
  if (unix === null) return null;
  const date = new Date(unix * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

/**
 * Vocatrya Managed AI settings section. Everything rendered here is a live
 * Hosted authority read — subscription status, plan, quota and usage come
 * from GET /v1/me/entitlement and /v1/me/usage verbatim; a failed read
 * shows the real MANAGED_* code, never fabricated data. While the release
 * has not launched Managed AI it shows Coming Soon instead and nothing else.
 */
function ManagedAiCard() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<ManagedAiOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getManagedAiOverview();
      if (result.success && result.data) {
        setOverview(result.data);
      }
    } catch (error) {
      console.error("Error loading Managed AI overview:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connection = overview?.connection ?? null;
  const entitlement = overview?.entitlement ?? null;
  const usage = overview?.usage ?? null;
  const errorCode = overview?.errorCode ?? null;
  const connected = connection?.status === "CONNECTED";
  const comingSoon = overview?.availability === "COMING_SOON";
  const periodStart = formatPeriod(entitlement?.periodStart ?? null);
  const periodEnd = formatPeriod(entitlement?.periodEnd ?? null);

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">{t("settings.managedTitle")}</h3>
          {!comingSoon && (
            <p className="text-sm text-muted-foreground">
              {t("settings.managedDescription")}
            </p>
          )}
        </div>
        {!comingSoon && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        )}
      </div>

      {loading && !overview ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("settings.managedLoading")}</span>
        </div>
      ) : comingSoon ? (
        <div className="rounded-md border border-dashed p-3 text-sm space-y-2">
          <Badge variant="secondary">{t("settings.managedComingSoon")}</Badge>
          <p className="text-muted-foreground">
            {t("settings.managedComingSoonHint")}
          </p>
        </div>
      ) : !connected ? (
        <div className="rounded-md border border-dashed p-3 text-sm space-y-1">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{t("settings.managedUnavailable")}</span>
          </div>
          <p className="text-muted-foreground">
            {errorCode
              ? t("settings.managedErrorCode", { code: errorCode })
              : t("settings.managedUnavailableHint")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span className="font-medium">
              {connection?.displayName ?? "Vocatrya Managed AI"}
            </span>
            <Badge variant="secondary">{connection?.status}</Badge>
          </div>

          {errorCode && (
            <p className="text-sm text-destructive">
              {t("settings.managedErrorCode", { code: errorCode })}
            </p>
          )}

          {entitlement && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">
                {t("settings.managedSubscription")}
              </dt>
              <dd>{entitlement.subscriptionStatus ?? t("settings.managedNone")}</dd>
              <dt className="text-muted-foreground">{t("settings.managedPlan")}</dt>
              <dd>{entitlement.planKey ?? t("settings.managedNone")}</dd>
              {(periodStart || periodEnd) && (
                <>
                  <dt className="text-muted-foreground">
                    {t("settings.managedPeriod")}
                  </dt>
                  <dd>
                    {periodStart ?? "?"} – {periodEnd ?? "?"}
                  </dd>
                </>
              )}
            </dl>
          )}

          {usage && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">
                {t("settings.managedQuotaUsed")}
              </dt>
              <dd>
                {usage.committedUnits}
                {usage.quotaLimitUnits !== null ? ` / ${usage.quotaLimitUnits}` : ""}
              </dd>
              {usage.remainingUnits !== null && (
                <>
                  <dt className="text-muted-foreground">
                    {t("settings.managedQuotaRemaining")}
                  </dt>
                  <dd>{usage.remainingUnits}</dd>
                </>
              )}
              {usage.reservedUnits > 0 && (
                <>
                  <dt className="text-muted-foreground">
                    {t("settings.managedQuotaReserved")}
                  </dt>
                  <dd>{usage.reservedUnits}</dd>
                </>
              )}
            </dl>
          )}

          {overview && overview.models.length > 0 && (
            <div className="text-sm">
              <p className="text-muted-foreground mb-1">
                {t("settings.managedModels")}
              </p>
              <div className="flex flex-wrap gap-1">
                {overview.models.map((model) => (
                  <Badge key={model.modelKey} variant="outline">
                    {model.displayName}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t("settings.managedAssignHint")}
          </p>
        </div>
      )}
    </div>
  );
}

export default ManagedAiCard;
