"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, Circle, Loader2, RefreshCw, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { NotionStatusNotice } from "./NotionStatusNotice";
import { notionCopy, type NotionCopyKey } from "@/lib/extensions/notion/copy";
import type { NotionExtensionState } from "@/lib/extensions/notion/service";
import {
  disconnectNotionAction,
  getNotionExtensionStateAction,
  startNotionConnectAction,
  verifyNotionConnectionAction,
} from "@/actions/notionExtension.actions";

const CAPABILITIES: Array<{ key: NotionCopyKey; flag: keyof NotionExtensionState["capabilities"] }> = [
  { key: "cap.search", flag: "search" },
  { key: "cap.read", flag: "read" },
  { key: "cap.createPage", flag: "createPage" },
  { key: "cap.appendContent", flag: "appendContent" },
  { key: "cap.updateRecord", flag: "updateRecord" },
  { key: "cap.updateContent", flag: "updateContent" },
  { key: "cap.deletePages", flag: "deletePages" },
];

export function NotionExtensionClient() {
  const { locale, formatDateTime } = useI18n();
  const t = useMemo(() => notionCopy(locale), [locale]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<NotionExtensionState | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "verify" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await getNotionExtensionStateAction();
    if (result.success) setState(result.data);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Electron opens consent in the system browser. Its loopback callback
  // updates the connection independently of this still-open desktop page.
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    const timer = state?.status === "CONNECTING"
      ? window.setInterval(onFocus, 2000)
      : undefined;
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [refresh, state?.status]);

  // A redirect back from the OAuth listener carries the outcome as a query
  // flag; surface it, then scrub the URL.
  useEffect(() => {
    const flag = searchParams.get("notion");
    if (!flag) return;
    if (flag === "connected") void verifyNotionConnectionAction().then((r) => {
      if (r.success) setState(r.data);
    });
    else void refresh();
    router.replace("/dashboard/extensions/notion");
  }, [searchParams, refresh, router]);

  const flash = searchParams.get("notion");
  const flashCode = searchParams.get("code");

  const connect = async () => {
    setBusy("connect");
    setActionError(null);
    try {
      const result = await startNotionConnectAction();
      if (!result.success) {
        setActionError(result.code ?? "generic");
        return;
      }
      // Keep a clickable link for browsers that block async popups.
      setAuthorizationUrl(result.data.authorizationUrl);
      await refresh();
      window.open(result.data.authorizationUrl, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setActionError(null);
    try {
      const result = await disconnectNotionAction();
      if (result.success) { setState(result.data); setAuthorizationUrl(null); }
      else setActionError(result.code ?? "generic");
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    setBusy("verify");
    try {
      const result = await verifyNotionConnectionAction();
      if (result.success) setState(result.data);
      else setActionError(result.code ?? "generic");
    } finally {
      setBusy(null);
    }
  };

  const statusKey: NotionCopyKey =
    state?.status === "CONNECTED"
      ? "status.connected"
      : state?.status === "REAUTH_REQUIRED"
        ? "status.reauth_required"
        : state?.status === "CONNECTING"
          ? "status.connecting"
          : "status.disconnected";
  const connected = state?.status === "CONNECTED";
  const connecting = state?.status === "CONNECTING";
  const needsReauth = state?.status === "REAUTH_REQUIRED";
  const errorText = (code: string | null | undefined): string => {
    const key = `error.${code ?? "generic"}` as NotionCopyKey;
    return t[key] ?? t["error.generic"];
  };

  return (
    <div className="space-y-4">
      <NotionStatusNotice status={state?.status ?? null} />
      <Link
        href="/dashboard/extensions"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t["page.back"]}
      </Link>

      {flash === "connected" && (
        <p className="rounded-sm border border-green-600/30 bg-green-600/10 px-3 py-2 text-sm">
          {t["note.connected"]}
        </p>
      )}
      {flash === "error" && (
        <p className="rounded-sm border border-red-600/30 bg-red-600/10 px-3 py-2 text-sm">
          {t["note.error"]}: {errorText(flashCode)}
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
          {connected && state?.workspaceName && (
            <div className="text-sm">
              <span className="text-muted-foreground">
                {t["status.workspace"]}:{" "}
              </span>
              {state.workspaceIcon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={state.workspaceIcon}
                  alt=""
                  className="mr-1 inline h-4 w-4 align-[-2px]"
                />
              )}
              <span className="font-medium">{state.workspaceName}</span>
            </div>
          )}
          {connected && state?.lastVerifiedAt && (
            <div className="text-xs text-muted-foreground">
              {t["status.lastVerified"]}:{" "}
              {formatDateTime(state.lastVerifiedAt)}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {authorizationUrl && !connected && (
              <Button asChild variant="outline">
                <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">
                  {t["action.openAuthorize"]}
                </a>
              </Button>
            )}
            {!connected ? (
              <Button
                onClick={() => void connect()}
                disabled={busy !== null}
                type="button"
              >
                {busy === "connect" && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {connecting
                  ? t["action.connecting"]
                  : needsReauth
                    ? t["action.reconnect"]
                    : t["action.connect"]}
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => void connect()}
                  disabled={busy !== null}
                  type="button"
                  variant="outline"
                >
                  {busy === "connect" && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t["action.reconnect"]}
                </Button>
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
