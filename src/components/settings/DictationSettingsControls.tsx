"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { toastError, toastSuccess } from "@/lib/toast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { controlStyles } from "../ui/control-styles";
import {
  deleteDictationKey,
  getDictationSettings,
  saveDictationKey,
  updateDictationSettings,
  type DictationCredentialStatus,
} from "@/actions/dictation.actions";
import {
  DICTATION_CREDENTIAL_MODES,
  DICTATION_DEFAULT_MODELS,
  DICTATION_MODELS,
  DICTATION_PROVIDERS,
  DICTATION_PROVIDER_LABELS,
  type DictationCredentialMode,
  type DictationProvider,
} from "@/lib/dictation/config";
import { DictationTestControls } from "./DictationTestControls";

/**
 * Dictation service config block inside the Audio settings page
 * (AWU-DICTATION / D6): provider + model + which credential the
 * transcription route resolves. Independent of the chat model. The audio
 * destination and BYOK billing are stated in the row itself.
 */
export function DictationSettingsControls() {
  const { t } = useI18n();
  const loadFailureMessage = useRef(t("dictation.saveFailed"));
  loadFailureMessage.current = t("dictation.saveFailed");
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<DictationProvider>("openai");
  const [model, setModel] = useState(DICTATION_DEFAULT_MODELS.openai);
  const [credentialMode, setCredentialMode] =
    useState<DictationCredentialMode>("shared");
  const [credentials, setCredentials] =
    useState<DictationCredentialStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [deletingKey, setDeletingKey] = useState(false);
  const [savedConfig, setSavedConfig] = useState<string | null>(null);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const configKey = JSON.stringify({ provider, model: model.trim(), credentialMode });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getDictationSettings();
      if (result.success && result.data) {
        setCredentials(result.data.credentials);
        const config = result.data.config;
        if (config) {
          setProvider(config.provider);
          setModel(config.model);
          setCredentialMode(config.credentialMode);
          setSavedConfig(JSON.stringify(config));
        }
      } else toastError(result.message || loadFailureMessage.current);
    } catch {
      toastError(loadFailureMessage.current);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCredential = credentials?.[provider]?.[credentialMode] ?? null;

  const onProviderChange = (value: string) => {
    if (!(DICTATION_PROVIDERS as readonly string[]).includes(value)) return;
    const next = value as DictationProvider;
    setProvider(next);
    setModel(DICTATION_DEFAULT_MODELS[next]);
    setKeyInput("");
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const result = await updateDictationSettings({
        provider,
        model: model.trim(),
        credentialMode,
      });
      if (result.success) {
        setSavedConfig(configKey);
        toastSuccess(t("dictation.saved"));
      } else {
        toastError(result.message || t("dictation.saveFailed"));
      }
    } catch {
      toastError(t("dictation.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const onSaveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    try {
      const result = await saveDictationKey({ provider, credentialMode, key });
      if (result.success && result.data) {
        toastSuccess(t("dictation.keySaved"));
        setKeyInput("");
        setCredentials(current => ({
          openai: current?.openai ?? { shared: null, dedicated: null },
          gemini: current?.gemini ?? { shared: null, dedicated: null },
          [provider]: { ...current?.[provider], shared: current?.[provider].shared ?? null,
            dedicated: current?.[provider].dedicated ?? null, [credentialMode]: result.data },
        }));
        setCredentialRevision(current => current + 1);
      } else {
        toastError(result.message || t("dictation.saveFailed"));
      }
    } catch {
      toastError(t("dictation.saveFailed"));
    } finally {
      setSavingKey(false);
    }
  };

  const onDeleteKey = async () => {
    setDeletingKey(true);
    try {
      const result = await deleteDictationKey({ provider, credentialMode });
      if (result.success) {
        toastSuccess(t("dictation.keyDeleted"));
        setCredentials(current => current ? { ...current, [provider]: { ...current[provider], dedicated: null } } : current);
        setCredentialRevision(current => current + 1);
      } else {
        toastError(result.message || t("dictation.saveFailed"));
      }
    } catch {
      toastError(t("dictation.saveFailed"));
    } finally {
      setDeletingKey(false);
    }
  };

  return (
    <div
      className="space-y-4 rounded-lg border p-4"
      data-testid="dictation-settings"
    >
      <div>
        <h4 className="text-base font-medium">{t("dictation.title")}</h4>
        <p className="mt-1 text-sm text-muted-foreground break-words">
          {t("dictation.description")}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("settings.loadingSettings")}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="dictation-provider">
                {t("dictation.provider")}
              </Label>
              <select
                id="dictation-provider"
                className={cn(controlStyles, "mt-1 h-9 w-full px-2")}
                value={provider}
                onChange={(event) => onProviderChange(event.target.value)}
                data-testid="dictation-provider"
                disabled={saving || savingKey || deletingKey}
              >
                {DICTATION_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {DICTATION_PROVIDER_LABELS[id]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="dictation-model">{t("dictation.model")}</Label>
              <Input
                id="dictation-model"
                className="mt-1 h-9"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={DICTATION_DEFAULT_MODELS[provider]}
                data-testid="dictation-model"
                list={`dictation-models-${provider}`}
                disabled={saving || savingKey || deletingKey}
              />
              <datalist id={`dictation-models-${provider}`}>
                {DICTATION_MODELS[provider].map(id => <option key={id} value={id} />)}
              </datalist>
            </div>
            <div>
              <Label htmlFor="dictation-credential">
                {t("dictation.credential")}
              </Label>
              <select
                id="dictation-credential"
                className={cn(controlStyles, "mt-1 h-9 w-full px-2")}
                value={credentialMode}
                onChange={(event) => {
                  if (
                    (DICTATION_CREDENTIAL_MODES as readonly string[]).includes(
                      event.target.value,
                    )
                  ) {
                    setCredentialMode(
                      event.target.value as DictationCredentialMode,
                    );
                    setKeyInput("");
                  }
                }}
                data-testid="dictation-credential-mode"
                disabled={saving || savingKey || deletingKey}
              >
                <option value="shared">{t("dictation.credentialShared")}</option>
                <option value="dedicated">
                  {t("dictation.credentialDedicated")}
                </option>
              </select>
            </div>
            <div className="flex flex-col justify-end">
              <div className="flex items-center gap-2">
                {activeCredential ? (
                  <Badge
                    variant="secondary"
                    data-testid="dictation-key-badge"
                  >
                    {`····${activeCredential.last4}`}
                    <span className="ml-1">{t("dictation.keyConfigured")}</span>
                  </Badge>
                ) : (
                  <Badge
                    variant="secondary"
                    data-testid="dictation-key-badge"
                  >
                    {t("dictation.keyMissing")}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dictation-key">
              {credentialMode === "shared"
                ? t("dictation.sharedKeyLabel")
                : t("dictation.dedicatedKeyLabel")}
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="dictation-key"
                type="password"
                className="h-9 w-72"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                placeholder={
                  credentialMode === "shared"
                    ? t("dictation.sharedKeyPlaceholder")
                    : t("dictation.dedicatedKeyPlaceholder")
                }
                autoComplete="off"
                data-testid="dictation-key-input"
                disabled={saving || savingKey || deletingKey}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onSaveKey()}
                disabled={!keyInput.trim() || savingKey || saving || deletingKey}
                data-testid="dictation-key-save"
              >
                {savingKey ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  t("dictation.saveKey")
                )}
              </Button>
              {credentialMode === "dedicated" && activeCredential ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => void onDeleteKey()}
                  disabled={deletingKey || saving || savingKey}
                  data-testid="dictation-key-delete"
                >
                  {deletingKey ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    t("dictation.deleteKey")
                  )}
                </Button>
              ) : null}
            </div>
            {credentialMode === "shared" ? (
              <p className="text-xs text-muted-foreground">
                {t("dictation.sharedKeyHint")}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => void onSave()}
              disabled={saving || savingKey || deletingKey || !model.trim()}
              data-testid="dictation-save"
            >
              {saving ? t("common.saving") : t("dictation.save")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("dictation.disclosure")}
            </p>
          </div>
          <DictationTestControls
            key={`${configKey}:${credentialRevision}:${savingKey}:${deletingKey}`}
            ownershipKey={configKey}
            enabled={savedConfig === configKey && !!activeCredential && !saving && !savingKey && !deletingKey}
          />
        </>
      )}
    </div>
  );
}
