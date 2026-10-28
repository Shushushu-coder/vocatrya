"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Label } from "../ui/label";
import { toastSuccess, toastError } from "@/lib/toast";
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
import { Loader2, Plus, Trash2, CheckCircle, ShieldCheck } from "lucide-react";
import {
  getUserApiKeys,
  saveApiKey,
  deleteApiKey,
} from "@/actions/apiKey.actions";
import {
  getByokCredentialStorageStatus,
  migrateByokCredentialsToOsStore,
  verifyByokCredentials,
} from "@/actions/byokCredential.actions";
import type {
  ApiKeyClientResponse,
  ApiKeyProvider,
} from "@/models/apiKey.model";
import { PROVIDER_REGISTRY, SETTINGS_BYOK_PROVIDERS } from "@/lib/ai/provider-registry";
import { useI18n } from "@/i18n";

interface ProviderConfig {
  id: ApiKeyProvider;
  name: string;
  placeholder: string;
  inputType: "password" | "text";
  description: string;
  sensitive: boolean;
}

const PROVIDERS: ProviderConfig[] = SETTINGS_BYOK_PROVIDERS.map((id) => PROVIDER_REGISTRY[id]).map((entry) => ({
  id: entry.id as ApiKeyProvider,
  name: entry.displayName,
  placeholder: entry.keyConfig.placeholder,
  inputType: entry.keyConfig.inputType,
  description: entry.keyConfig.description,
  sensitive: entry.keyConfig.sensitive,
}));

/**
 * Custom API Key / BYOK settings section. Keys save through the existing
 * encrypted ApiKey store; only last4 (or a non-sensitive URL) ever render —
 * the full key never round-trips back to the UI, logs, or toasts.
 */
interface CredentialStorageStatus {
  mode: "os-backed" | "app-cipher";
  available: boolean;
  backend: string | null;
  osProtected: number;
  appCipher: number;
  plaintext: number;
}

function ByokConnectionsCard() {
  const { t } = useI18n();
  const [keys, setKeys] = useState<ApiKeyClientResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<ApiKeyProvider | null>(
    null,
  );
  const [inputValue, setInputValue] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [storageStatus, setStorageStatus] = useState<CredentialStorageStatus | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [verifyingStorage, setVerifyingStorage] = useState(false);

  const fetchStorageStatus = async () => {
    try {
      const result = await getByokCredentialStorageStatus();
      if (result.success && result.data) setStorageStatus(result.data);
    } catch {
      // Status is informational — absence never blocks the key list.
    }
  };

  useEffect(() => {
    fetchKeys();
    fetchStorageStatus();
  }, []);

  const fetchKeys = async () => {
    setIsLoading(true);
    try {
      const result = await getUserApiKeys();
      if (result.success && result.data) {
        setKeys(result.data);
      }
    } catch (error) {
      console.error("Error fetching API keys:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const getKeyForProvider = (provider: ApiKeyProvider) =>
    keys.find((k) => k.provider === provider);

  const isBaseUrlProvider = (providerId: string) => {
    const entry = PROVIDER_REGISTRY[providerId];
    return entry?.credentialType === "base-url";
  };

  const handleVerifyAndSave = async (provider: ApiKeyProvider) => {
    if (!inputValue.trim()) return;

    setVerifying(true);
    try {
      const verifyRes = await fetch("/api/settings/api-keys/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key: inputValue }),
      });
      const verifyData = await verifyRes.json();

      if (!verifyData.success) {
        toastError(verifyData.error || t("settings.couldNotVerifyKey"), t("settings.verificationFailed"));
        return;
      }

      const providerConfig = PROVIDERS.find((p) => p.id === provider);
      const saveResult = await saveApiKey({
        provider,
        key: inputValue,
        sensitive: providerConfig?.sensitive ?? true,
      });
      if (saveResult.success) {
        toastSuccess(
          t("settings.keyVerifiedAndSaved", {
            name: PROVIDERS.find((p) => p.id === provider)?.name ?? "",
          }),
          t("settings.apiKeySaved"),
        );
        setEditingProvider(null);
        setInputValue("");
        await fetchKeys();
      } else {
        toastError(saveResult.message || t("settings.failedToSaveApiKey"), t("settings.saveFailed"));
      }
    } catch (error) {
      console.error("Error saving API key:", error);
      toastError(t("settings.unexpectedError"));
    } finally {
      setVerifying(false);
    }
  };

  // Explicit user action: upgrade legacy-format keys to the Windows
  // OS-backed envelope. Never fires implicitly — listing and reading
  // keys leave storage formats untouched.
  const handleUpgradeStorage = async () => {
    setMigrating(true);
    try {
      const result = await migrateByokCredentialsToOsStore();
      if (result.success && result.data) {
        const summary = result.data;
        if (summary.failed.length === 0) {
          toastSuccess(
            t("settings.byokUpgradeDone", { migrated: summary.migrated.length }),
            t("settings.byokStorageTitle"),
          );
        } else {
          toastError(
            t("settings.byokUpgradePartial", {
              migrated: summary.migrated.length,
              failed: summary.failed.length,
              skipped: summary.skipped.length,
            }),
            t("settings.byokStorageTitle"),
          );
        }
        await fetchKeys();
        await fetchStorageStatus();
      } else {
        toastError(result.message || t("settings.unexpectedError"));
      }
    } catch {
      toastError(t("settings.unexpectedError"));
    } finally {
      setMigrating(false);
    }
  };

  // Explicit health check: a key that provably cannot be read in this OS
  // context flips its connection to REAUTH_REQUIRED — the honest state.
  const handleVerifyStorage = async () => {
    setVerifyingStorage(true);
    try {
      const result = await verifyByokCredentials();
      if (result.success && result.data) {
        const reauth = result.data.filter((r) => r.status === "reauth_required").length;
        const unavailable = result.data.filter((r) => r.status === "unavailable").length;
        if (reauth === 0 && unavailable === 0) {
          toastSuccess(t("settings.byokVerifyOk"), t("settings.byokStorageTitle"));
        } else {
          toastError(
            t("settings.byokVerifyIssues", { reauth, unavailable }),
            t("settings.byokStorageTitle"),
          );
        }
        await fetchKeys();
        await fetchStorageStatus();
      } else {
        toastError(result.message || t("settings.unexpectedError"));
      }
    } catch {
      toastError(t("settings.unexpectedError"));
    } finally {
      setVerifyingStorage(false);
    }
  };

  const handleDelete = async (provider: ApiKeyProvider) => {
    setDeleting(provider);
    try {
      const result = await deleteApiKey(provider);
      if (result.success) {
        toastSuccess(
          t("settings.keyRemoved", {
            name: PROVIDERS.find((p) => p.id === provider)?.name ?? "",
          }),
          t("settings.apiKeyDeleted"),
        );
        await fetchKeys();
      } else {
        toastError(result.message || t("settings.failedToDeleteApiKey"));
      }
    } catch (error) {
      console.error("Error deleting API key:", error);
    } finally {
      setDeleting(null);
    }
  };

  const handleCancel = () => {
    setEditingProvider(null);
    setInputValue("");
  };

  if (isLoading) {
    return (
      <div className="space-y-4 rounded-lg border p-4">
        <div>
          <h3 className="text-lg font-medium">{t("settings.byokTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("settings.byokDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("settings.loadingKeys")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="text-lg font-medium">{t("settings.byokTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("settings.byokDescription")}
        </p>
      </div>

      <div className="grid gap-4">
        {PROVIDERS.map((provider) => {
          const existingKey = getKeyForProvider(provider.id);
          const isEditing = editingProvider === provider.id;
          const isBaseUrl = isBaseUrlProvider(provider.id);

          return (
            <Card key={provider.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{provider.name}</CardTitle>
                    <CardDescription className="text-sm">
                      {provider.description}
                      {isBaseUrl && (
                        <span className="block text-xs text-muted-foreground/70 mt-0.5">
                          {t("settings.defaultPrefix", {
                            value: provider.placeholder,
                          })}
                        </span>
                      )}
                    </CardDescription>
                  </div>
                  {existingKey ? (
                    <span className="flex items-center gap-1.5">
                      {existingKey.protection === "os" && (
                        <Badge
                          variant="outline"
                          className="text-blue-700 border-blue-300 dark:text-blue-300 dark:border-blue-800"
                        >
                          <ShieldCheck className="h-3 w-3 mr-1" />
                          {t("settings.byokOsBadge")}
                        </Badge>
                      )}
                      <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 hover:bg-green-100 dark:hover:bg-green-900">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        {provider.sensitive
                          ? `····${existingKey.last4}`
                          : existingKey.displayValue || existingKey.last4}
                      </Badge>
                    </span>
                  ) : (
                    <Badge variant="secondary">{t("settings.notConfigured")}</Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {isEditing ? (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor={`key-${provider.id}`}>
                        {isBaseUrl ? t("settings.baseUrl") : t("settings.apiKey")}
                      </Label>
                      <Input
                        id={`key-${provider.id}`}
                        type={provider.inputType}
                        placeholder={provider.placeholder}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        className="mt-1"
                        autoComplete="off"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleVerifyAndSave(provider.id)}
                        disabled={!inputValue.trim() || verifying}
                      >
                        {verifying && (
                          <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                        )}
                        {t("settings.verifyAndSave")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleCancel}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingProvider(provider.id);
                        setInputValue("");
                      }}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      {existingKey ? t("settings.updateKey") : t("settings.addKey")}
                    </Button>
                    {existingKey && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive hover:text-destructive"
                            disabled={deleting === provider.id}
                          >
                            {deleting === provider.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("settings.deleteApiKey")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("settings.deleteApiKeyDescription", {
                                name: provider.name,
                              })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDelete(provider.id)}
                            >
                              {t("common.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {storageStatus && (
        <div className="rounded-md border border-dashed p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm text-muted-foreground">
              {storageStatus.mode === "os-backed"
                ? storageStatus.available
                  ? t("settings.byokStorageWindowsOn")
                  : t("settings.byokStorageUnavailable")
                : t("settings.byokStorageApp")}
            </div>
            <div className="flex gap-2">
              {storageStatus.mode === "os-backed" &&
                storageStatus.available &&
                storageStatus.appCipher > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleUpgradeStorage}
                    disabled={migrating}
                  >
                    {migrating ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-3 w-3" />
                    )}
                    {t("settings.byokUpgradeAction", {
                      count: storageStatus.appCipher,
                    })}
                  </Button>
                )}
              {storageStatus.osProtected > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleVerifyStorage}
                  disabled={verifyingStorage}
                >
                  {verifyingStorage && (
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  )}
                  {t("settings.byokVerifyAction")}
                </Button>
              )}
            </div>
          </div>
          {storageStatus.mode === "os-backed" &&
            storageStatus.available &&
            storageStatus.appCipher > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("settings.byokUpgradeHint")}
              </p>
            )}
        </div>
      )}
    </div>
  );
}

export default ByokConnectionsCard;
