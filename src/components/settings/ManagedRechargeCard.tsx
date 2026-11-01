"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CheckCircle, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useI18n } from "@/i18n";
import {
  getManagedAiOverview,
  redeemManagedAiSession,
  type ManagedAiOverview,
} from "@/actions/managedAi.actions";

/**
 * Subscription & Recharge surface for Vocatrya Managed AI. The only
 * user-facing way to attach a hosted session: paste the access key that
 * customer service issued for the subscription. There is deliberately no
 * payment or checkout loop — users without a key are told to contact
 * customer service. The key is validated against the Hosted authority
 * before it is persisted under OS protection (redeemManagedAiSession);
 * entering another key while connected replaces the session.
 */
function ManagedRechargeCard() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<ManagedAiOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getManagedAiOverview();
      if (result.success && result.data) {
        setOverview(result.data);
      }
    } catch (err) {
      console.error("Error loading Managed AI overview:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const redeem = async () => {
    const token = key.trim();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await redeemManagedAiSession({ token });
      if (result.success) {
        setKey("");
        await refresh();
      } else {
        setError(result.code ?? result.message ?? "FAILED");
      }
    } finally {
      setBusy(false);
    }
  };

  const connection = overview?.connection ?? null;
  const entitlement = overview?.entitlement ?? null;
  const usage = overview?.usage ?? null;
  const errorCode = overview?.errorCode ?? null;
  const connected = connection?.status === "CONNECTED";
  const comingSoon = overview?.availability === "COMING_SOON";

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">
            {t("settings.managedRechargeTitle")}
          </h3>
          {!comingSoon && (
            <p className="text-sm text-muted-foreground">
              {t("settings.managedRechargeDescription")}
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
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-destructive">
          {t("settings.managedErrorCode", { code: error })}
        </p>
      )}

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
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            {connected ? (
              <>
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="font-medium">
                  {connection?.displayName ?? "Vocatrya Managed AI"}
                </span>
                <Badge variant="secondary">{connection?.status}</Badge>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">
                  {t("settings.managedUnavailable")}
                </span>
                {errorCode && (
                  <span className="text-destructive">
                    {t("settings.managedErrorCode", { code: errorCode })}
                  </span>
                )}
              </>
            )}
          </div>

          {connected && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {overview?.hostedUserId && (
                <>
                  <dt className="text-muted-foreground">
                    {t("settings.managedAccount")}
                  </dt>
                  <dd>{overview.hostedUserId}</dd>
                </>
              )}
              {entitlement && (
                <>
                  <dt className="text-muted-foreground">
                    {t("settings.managedSubscription")}
                  </dt>
                  <dd>
                    {entitlement.subscriptionStatus ??
                      t("settings.managedNone")}
                  </dd>
                  <dt className="text-muted-foreground">
                    {t("settings.managedPlan")}
                  </dt>
                  <dd>{entitlement.planKey ?? t("settings.managedNone")}</dd>
                </>
              )}
              {usage && (
                <dt className="text-muted-foreground">
                  {t("settings.managedQuotaUsed")}
                </dt>
              )}
              {usage && (
                <dd>
                  {usage.committedUnits}
                  {usage.quotaLimitUnits !== null
                    ? ` / ${usage.quotaLimitUnits}`
                    : ""}
                </dd>
              )}
            </dl>
          )}

          {connected && (
            <p className="text-muted-foreground text-sm">
              {t("settings.managedRechargeConnectedHint")}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={t("settings.managedRechargeKeyPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className="h-8 font-mono text-xs"
              disabled={busy}
            />
            <Button
              size="sm"
              onClick={() => void redeem()}
              disabled={busy || !key.trim()}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("settings.managedRechargeSubmit")}
            </Button>
          </div>

          <p className="text-muted-foreground text-sm">
            {t("settings.managedRechargeNoKeyHint")}
          </p>
        </div>
      )}
    </div>
  );
}

export default ManagedRechargeCard;
