"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AiProvider,
  OpenaiModel,
  DeepseekModel,
  GeminiModel,
} from "@/models/ai.model";
import { PROVIDER_REGISTRY, AI_PROVIDERS } from "@/lib/ai/provider-registry";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Label } from "../ui/label";
import { Button } from "../ui/button";
import { Loader2 } from "lucide-react";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  getUserSettings,
  updateInterviewAiSettings,
} from "@/actions/userSettings.actions";
import { useI18n } from "@/i18n";

export default function InterviewAiSettings() {
  const { t } = useI18n();
  const [provider, setProvider] = useState<AiProvider | "">("");
  const [model, setModel] = useState<string>("");
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fallbackModels = useCallback((value: AiProvider): string[] => {
    switch (value) {
      case AiProvider.OPENAI:
        return Object.values(OpenaiModel);
      case AiProvider.DEEPSEEK:
        return Object.values(DeepseekModel);
      case AiProvider.GEMINI:
        return Object.values(GeminiModel);
      default:
        return [];
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const result = await getUserSettings();
        const interview = result?.data?.settings?.ai?.interview as
          | { provider?: AiProvider; model?: string }
          | undefined;
        if (interview?.provider) {
          setProvider(interview.provider);
          setModel(interview.model ?? "");
          setModels(fallbackModels(interview.provider));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [fallbackModels]);

  const onProvider = (value: AiProvider) => {
    setProvider(value);
    setModel("");
    setModels(fallbackModels(value));
  };

  const onSave = async () => {
    if (!provider || !model) {
      toastError("Interview provider and model are both required.");
      return;
    }
    setSaving(true);
    try {
      const result = await updateInterviewAiSettings({ provider, model });
      if (result?.success) toastSuccess(t("interview.saveInterviewAi"));
      else toastError(result?.message || t("common.save"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("settings.loadingSettings")}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="text-lg font-medium">{t("interview.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("interview.interviewAiDescription")}
        </p>
      </div>
      <div>
        <Label htmlFor="interview-provider">{t("interview.provider")}</Label>
        <Select value={provider || undefined} onValueChange={onProvider}>
          <SelectTrigger id="interview-provider" className="mt-2 w-[220px]">
            <SelectValue placeholder={t("settings.selectAiProvider")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {AI_PROVIDERS.map((id) => (
                <SelectItem key={id} value={id}>
                  {PROVIDER_REGISTRY[id].displayName}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="interview-model">{t("interview.model")}</Label>
        <Select
          value={model || undefined}
          onValueChange={setModel}
          disabled={!provider}
        >
          <SelectTrigger id="interview-model" className="mt-2 w-[220px]">
            <SelectValue placeholder={t("settings.selectAiModel")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {models.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <Button onClick={() => void onSave()} disabled={saving || !provider || !model}>
        {saving ? t("common.saving") : t("interview.saveInterviewAi")}
      </Button>
    </div>
  );
}
