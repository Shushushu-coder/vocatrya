"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Label } from "../ui/label";
import { toastSuccess, toastError } from "@/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Loader2, Plus, Trash2, Copy, Check } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  type PublicTokenMeta,
} from "@/actions/mcpToken.actions";
import { APP_CONSTANTS } from "@/lib/constants";
import { format } from "date-fns";
import { useI18n } from "@/i18n";

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError(t("settings.copyFailedMessage"), t("settings.copyFailed"));
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} className="shrink-0">
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function CodeSnippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground font-medium">{label}</p>
      <div className="flex gap-2 items-start">
        <pre className="flex-1 bg-muted rounded-sm p-2 text-xs overflow-x-auto whitespace-pre-wrap break-all">{code}</pre>
        <CopyButton text={code} />
      </div>
    </div>
  );
}

function TokenRevealDialog({
  token,
  tokenName,
  mcpUrl,
  onClose,
}: {
  token: string;
  tokenName: string;
  mcpUrl: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ocSnippet = JSON.stringify(
    {
      mcpServers: {
        vocatrya: {
          type: "streamable-http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );

  const isInsecureNonLocalhost = (() => {
    try {
      const { protocol, hostname } = new URL(mcpUrl);
      return protocol === "http:" && hostname !== "localhost" && hostname !== "127.0.0.1";
    } catch {
      return false;
    }
  })();

  const claudeSnippet = `npx mcp-remote ${mcpUrl} --header "Authorization: Bearer ${token}"${
    isInsecureNonLocalhost ? " --allow-http" : ""
  }`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.tokenCreatedSaveNow")}</DialogTitle>
          <DialogDescription>
            {t("settings.tokenCreatedDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs">{t("settings.yourToken")}</Label>
            <div className="flex gap-2 items-center">
              <Input readOnly value={token} className="font-mono text-xs" />
              <CopyButton text={token} />
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">{t("settings.clientConfigSnippets")}</p>
            <CodeSnippet label={t("settings.snippetOpenClaw")} code={ocSnippet} />
            <CodeSnippet label={t("settings.snippetClaudeDesktop")} code={claudeSnippet} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("settings.iSavedMyToken")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function McpAccessSettings() {
  const { t } = useI18n();
  const [tokens, setTokens] = useState<PublicTokenMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [expiryDays, setExpiryDays] = useState<30 | 90 | 365>(
    APP_CONSTANTS.MCP_TOKEN_EXPIRY_DEFAULT_DAYS as 30 | 90 | 365,
  );

  const [revealedToken, setRevealedToken] = useState<{ token: string; name: string } | null>(null);

  const mcpUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/mcp`
      : "/api/mcp";

  const fetchTokens = async () => {
    setIsLoading(true);
    const result = await listMcpTokens();
    setTokens(result);
    setIsLoading(false);
  };

  useEffect(() => { fetchTokens(); }, []);

  const handleGenerate = async () => {
    if (!tokenName.trim()) return;
    setGenerating(true);
    const result = await createMcpToken({ name: tokenName.trim(), expiryDays });
    setGenerating(false);
    if (!result.success) {
      toastError(result.message);
      return;
    }
    setRevealedToken({ token: result.token, name: result.record.name });
    setShowGenerateDialog(false);
    setTokenName("");
    setExpiryDays(APP_CONSTANTS.MCP_TOKEN_EXPIRY_DEFAULT_DAYS as 30 | 90 | 365);
    await fetchTokens();
  };

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    const result = await revokeMcpToken(id);
    setRevoking(null);
    if (!result.success) {
      toastError(result.message ?? t("settings.failedToRevoke"));
      return;
    }
    setTokens((prev) => prev.filter((token) => token.id !== id));
    toastSuccess(t("settings.tokenRevoked"));
  };

  return (
    <div className="space-y-6">
      {revealedToken && (
        <TokenRevealDialog
          token={revealedToken.token}
          tokenName={revealedToken.name}
          mcpUrl={mcpUrl}
          onClose={() => setRevealedToken(null)}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-medium">{t("settings.mcpEndpoint")}</CardTitle>
          <CardDescription>{t("settings.mcpEndpointDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t("settings.endpointUrl")}</Label>
            <div className="flex gap-2 items-center">
              <Input readOnly value={mcpUrl} className="font-mono text-sm" />
              <CopyButton text={mcpUrl} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-lg font-medium">{t("settings.personalAccessTokens")}</CardTitle>
            <CardDescription>{t("settings.tokensDescription")}</CardDescription>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => setShowGenerateDialog(true)} disabled={isLoading}>
            <Plus className="h-4 w-4 mr-1" />
            {t("settings.generate")}
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("settings.loadingTokens")}
            </div>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.noMcpTokens")}</p>
          ) : (
            <div className="space-y-3">
              {tokens.map((token) => (
                <div key={token.id} className="flex items-start justify-between border rounded-sm p-3 gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{token.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{token.tokenPrefix}…</p>
                    <div className="flex flex-wrap gap-2 mt-1 text-xs text-muted-foreground">
                      <span>{t("settings.createdAt", { date: format(new Date(token.createdAt), "PP") })}</span>
                      <span>{t("settings.expiresAtDate", { date: format(new Date(token.expiresAt), "PP") })}</span>
                      {token.lastUsedAt && (
                        <span>{t("settings.lastUsed", { date: format(new Date(token.lastUsedAt), "PP") })}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {token.scopes.map((s) => (
                        <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
                      ))}
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" disabled={revoking === token.id} title={t("settings.revokeTokenTitle")}>
                        {revoking === token.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-destructive" />}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("settings.revokeNamedToken", { name: token.name })}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("settings.revokeTokenDescription")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => handleRevoke(token.id)}>{t("settings.revoke")}</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.generateMcpToken")}</DialogTitle>
            <DialogDescription>
              {t("settings.generateMcpTokenDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("settings.tokenNameLabel")}</Label>
              <Input
                placeholder={t("settings.tokenNamePlaceholder")}
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("settings.expiresIn")}</Label>
              <Select
                value={String(expiryDays)}
                onValueChange={(v) => setExpiryDays(Number(v) as 30 | 90 | 365)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APP_CONSTANTS.MCP_TOKEN_EXPIRY_PRESETS.map((d) => (
                    <SelectItem key={d} value={String(d)}>{t("settings.daysCount", { days: d })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleGenerate} disabled={generating || !tokenName.trim()}>
              {generating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("settings.generate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
