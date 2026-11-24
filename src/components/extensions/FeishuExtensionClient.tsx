"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, Loader2, RefreshCw, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { FeishuStatusNotice } from "./FeishuStatusNotice";
import { feishuCopy, type FeishuCopyKey } from "@/lib/extensions/feishu/copy";
import type { FeishuExtensionState } from "@/lib/extensions/feishu/service";
import {
  connectFeishuAction,
  disconnectFeishuAction,
  getFeishuExtensionStateAction,
  verifyFeishuConnectionAction,
} from "@/actions/feishuExtension.actions";

const CAPABILITIES: Array<{ key: FeishuCopyKey; flag: keyof FeishuExtensionState["capabilities"] }> = [
  { key: "cap.searchDocs", flag: "searchDocs" },
  { key: "cap.readDoc", flag: "readDoc" },
  { key: "cap.createDoc", flag: "createDoc" },
  { key: "cap.appendContent", flag: "appendContent" },
  { key: "cap.updateContent", flag: "updateContent" },
];

export function FeishuExtensionClient() {
  const { locale, formatDateTime } = useI18n();
  const t = useMemo(() => feishuCopy(locale), [locale]);
  const [state, setState] = useState<FeishuExtensionState | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "verify" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");

  const refresh = useCallback(async () => {
    const result = await getFeishuExtensionStateAction();
    if (result.success) setState(result.data);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async () => {
    setBusy("connect");
    setActionError(null);
    try {
      const result = await connectFeishuAction({
        appId,
        appSecret: appSecret || undefined,
      });
      if (result.success) {
        setState(result.data);
        setJustConnected(true);
        // The field is a write-only credential input — clear it once sealed.
        setAppSecret("");
      } else {
        setActionError(result.code ?? "generic");
      }
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setActionError(null);
    try {
      const result = await disconnectFeishuAction();
      if (result.success) {
        setState(result.data);
        setJustConnected(false);
        setAppSecret("");
      } else setActionError(result.code ?? "generic");
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    setBusy("verify");
    try {
      const result = await verifyFeishuConnectionAction();
      if (result.success) setState(result.data);
      else setActionError(result.code ?? "generic");
    } finally {
      setBusy(null);
    }
  };

  const statusKey: FeishuCopyKey =
    state?.status === "CONNECTED"
      ? "status.connected"
      : state?.status === "REAUTH_REQUIRED"
        ? "status.reauth_required"
        : "status.disconnected";
  const connected = state?.status === "CONNECTED";
  const needsReauth = state?.status === "REAUTH_REQUIRED";
  const errorText = (code: string | null | undefined): string => {
    const key = `error.${code ?? "generic"}` as FeishuCopyKey;
    return t[key] ?? t["error.generic"];
  };
  const canSubmit = appId.trim().length > 0 && (connected || needsReauth ? true : appSecret.length > 0);

  return (
    <div className="space-y-4">
      <FeishuStatusNotice status={state?.status ?? null} />
      <Link
        href="/dashboard/extensions"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t["page.back"]}
      </Link>

      {justConnected && connected && (
        <p className="rounded-sm border border-green-600/30 bg-green-600/10 px-3 py-2 text-sm">
          {t["note.connected"]}
        </p>
      )}
      {needsReauth && (
        <p className="rounded-sm border border-amber-600/30 bg-amber-600/10 px-3 py-2 text-sm">
          {t["note.reauth"]}
        </p>
      )}
      {actionError && (
        <p className="rounded-sm border border-red-600/30 bg-red-600/10 px-3 py-2 text-sm">
          {errorText(actionError)}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>{t["page.title"]}</span>
            <Badge variant={connected ? "default" : "secondary"}>
              {t[statusKey]}
            </Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t["page.subtitle"]}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected && state?.appId && (
            <div className="text-sm">
              <span className="text-muted-foreground">
                {t["status.appId"]}:{" "}
              </span>
              <span className="font-medium">{state.appId}</span>
            </div>
          )}
          {connected && state?.lastVerifiedAt && (
            <div className="text-xs text-muted-foreground">
              {t["status.lastVerified"]}: {formatDateTime(state.lastVerifiedAt)}
            </div>
          )}

          <div className="space-y-3 rounded-sm border p-3">
            <div>
              <p className="text-sm font-medium">{t["form.title"]}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t["form.subtitle"]}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="feishu-app-id">{t["form.appId"]}</Label>
              <Input
                id="feishu-app-id"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder={t["form.appIdPlaceholder"]}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="feishu-app-secret">{t["form.appSecret"]}</Label>
              <Input
                id="feishu-app-secret"
                type="password"
                value={appSecret}
                onChange={(event) => setAppSecret(event.target.value)}
                placeholder={t["form.appSecretPlaceholder"]}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t["form.secretHint"]}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void connect()}
                disabled={busy !== null || !canSubmit}
                type="button"
              >
                {busy === "connect" && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {connected || needsReauth
                  ? t["action.reconnect"]
                  : busy === "connect"
                    ? t["action.connecting"]
                    : t["action.connect"]}
              </Button>
              {connected && (
                <>
                  <Button
                    onClick={() => void verify()}
                    disabled={busy !== null}
                    type="button"
                    variant="outline"
                  >
                    {busy === "verify" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    {t["action.verify"]}
                  </Button>
                  <Button
                    onClick={() => void disconnect()}
                    disabled={busy !== null}
                    type="button"
                    variant="destructive"
                  >
                    <Unplug className="mr-2 h-4 w-4" />
                    {t["action.disconnect"]}
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t["guide.title"]}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{t["guide.permissions"]}</p>
          <p>{t["guide.resources"]}</p>
          <p>{t["guide.scope"]}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t["capabilities.title"]}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {CAPABILITIES.map(({ key, flag }) => {
            const available = connected && state?.capabilities[flag];
            return (
              <div key={flag} className="flex items-center gap-2 text-sm">
                {available ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="flex-1">{t[key]}</span>
                <Badge variant={available ? "default" : "outline"}>
                  {available ? t["cap.available"] : t["cap.unavailable"]}
                </Badge>
              </div>
            );
          })}
          <p className="pt-2 text-xs text-muted-foreground">{t["cap.note"]}</p>
        </CardContent>
      </Card>
    </div>
  );
}
