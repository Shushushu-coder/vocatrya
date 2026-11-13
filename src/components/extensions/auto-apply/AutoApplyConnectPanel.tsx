"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useI18n } from "@/i18n";
import {
  createAutoApplyPairingAction,
  listAutoApplyConnectionsAction,
  revokeAutoApplyConnectionAction,
} from "@/actions/autoApplyExtension.actions";
import { fill, getAutoApplyCopy } from "./autoApplyCopy";
import {
  AUTO_APPLY_EXPORTABLE_SECTIONS,
  type AutoApplySectionKey,
} from "@/lib/extensions/autoApply/sections";
import type { AutoApplyConnectionSummary } from "@/lib/extensions/autoApply/types";

type AutoApplyConnectPanelProps = {
  initialConnections: AutoApplyConnectionSummary[];
};

const PAIRING_TTL_MINUTES = 10;

function formatTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Paired-plugin management on the auto-apply detail page. Pairing codes
 * are generated here (shown once), connections are listed with their real
 * sync state, and revoke kills the plugin's token server-side so it can
 * never pull data again.
 */
export function AutoApplyConnectPanel({
  initialConnections,
}: AutoApplyConnectPanelProps) {
  const { locale } = useI18n();
  const autoApplyCopy = getAutoApplyCopy(locale);
  const copy = autoApplyCopy.connect;
  const sectionTitles = autoApplyCopy.sectionTitles;

  const [connections, setConnections] = useState(initialConnections);
  const [grant, setGrant] = useState<Set<AutoApplySectionKey>>(
    () => new Set(AUTO_APPLY_EXPORTABLE_SECTIONS),
  );
  const [pairingString, setPairingString] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const knownIdsRef = useRef<Set<string>>(
    new Set(initialConnections.map((row) => row.id)),
  );

  const pairingExpired = useMemo(
    () =>
      pairingExpiresAt !== null &&
      new Date(pairingExpiresAt).getTime() <= Date.now(),
    [pairingExpiresAt],
  );

  const refreshConnections = async () => {
    const result = await listAutoApplyConnectionsAction();
    if (result.success) {
      setConnections(result.data.connections);
      return result.data.connections;
    }
    return null;
  };

  // While a fresh pairing code waits, poll for the plugin's exchange so the
  // new connection appears without a manual reload. Stops on first new
  // active connection or when the code expires.
  useEffect(() => {
    if (!pairingString || !pairingExpiresAt) return undefined;
    const timer = window.setInterval(async () => {
      const rows = await refreshConnections();
      if (!rows) return;
      const fresh = rows.find(
        (row) => !row.revoked && !knownIdsRef.current.has(row.id),
      );
      if (fresh) {
        knownIdsRef.current.add(fresh.id);
        setPairingString(null);
        setPairingExpiresAt(null);
        setNotice(null);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pairingString, pairingExpiresAt]);

  const toggleGrant = (key: AutoApplySectionKey) => {
    setGrant((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onGenerate = async () => {
    setError(null);
    setNotice(null);
    setCopied(false);
    setGenerating(true);
    try {
      const sections = AUTO_APPLY_EXPORTABLE_SECTIONS.filter((key) =>
        grant.has(key),
      );
      const result = await createAutoApplyPairingAction(sections);
      if (!result.success) {
        setError(result.message ?? copy.pairFailed);
        return;
      }
      setPairingString(result.data.pairingString);
      setPairingExpiresAt(result.data.expiresAt);
      setNotice(copy.waiting);
    } finally {
      setGenerating(false);
    }
  };

  const onCopy = async () => {
    if (!pairingString) return;
    try {
      await navigator.clipboard.writeText(pairingString);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const onRevoke = async (connectionId: string) => {
    if (!window.confirm(copy.revokeConfirm)) return;
    setError(null);
    setRevokingId(connectionId);
    try {
      const result = await revokeAutoApplyConnectionAction(connectionId);
      if (!result.success) {
        setError(result.message ?? copy.revokeFailed);
        return;
      }
      await refreshConnections();
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{copy.title}</CardTitle>
        <CardDescription>{copy.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h3 className="mb-1 text-sm font-medium">{copy.pairTitle}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{copy.pairHint}</p>
          <div className="mb-2 flex flex-wrap gap-2">
            {AUTO_APPLY_EXPORTABLE_SECTIONS.map((key) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={grant.has(key)}
                  onChange={() => toggleGrant(key)}
                />
                {sectionTitles[key] ?? key}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={onGenerate}
              disabled={generating || grant.size === 0}
            >
              {generating ? copy.pairing : copy.pairButton}
            </Button>
            {error && <span className="text-sm text-destructive">{error}</span>}
          </div>
          {pairingString && !pairingExpired && (
            <div className="mt-3 space-y-2">
              <p className="text-xs font-medium">
                {fill(copy.pairReady, { minutes: PAIRING_TTL_MINUTES })}
              </p>
              <div className="flex items-start gap-2">
                <textarea
                  readOnly
                  rows={3}
                  className="w-full rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-xs"
                  value={pairingString}
                  onFocus={(event) => event.target.select()}
                />
                <Button variant="secondary" onClick={onCopy}>
                  {copied ? copy.copied : copy.copy}
                </Button>
              </div>
              {notice && (
                <p className="text-xs text-muted-foreground">{notice}</p>
              )}
            </div>
          )}
          {pairingString && pairingExpired && (
            <p className="mt-3 text-xs text-destructive">{copy.pairExpired}</p>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">{copy.connectionsTitle}</h3>
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.empty}</p>
          ) : (
            <ul className="space-y-2">
              {connections.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 p-2 text-sm"
                >
                  <span className="font-medium">
                    {row.clientName || copy.untitledClient}
                  </span>
                  <Badge variant={row.revoked ? "outline" : "secondary"}>
                    {row.revoked ? copy.revokedBadge : copy.activeBadge}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {fill(copy.pairedAt, {
                      time: formatTime(row.pairedAt, locale),
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row.lastSyncAt
                      ? fill(copy.lastSync, {
                          time: formatTime(row.lastSyncAt, locale),
                        })
                      : copy.neverSynced}
                  </span>
                  {row.lastProfileUpdatedAt && (
                    <span className="text-xs text-muted-foreground">
                      {fill(copy.lastProfileVersion, {
                        time: formatTime(row.lastProfileUpdatedAt, locale),
                      })}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {fill(copy.sectionsGranted, {
                      count: row.allowedSections.length,
                    })}
                  </span>
                  {!row.revoked && (
                    <Button
                      variant="ghost"
                      className="ml-auto h-7 px-2 text-xs text-destructive"
                      onClick={() => onRevoke(row.id)}
                      disabled={revokingId === row.id}
                    >
                      {revokingId === row.id ? copy.revoking : copy.revoke}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-medium">{copy.manualTitle}</h3>
          <p className="text-xs text-muted-foreground">{copy.manualHint}</p>
        </div>
      </CardContent>
    </Card>
  );
}
