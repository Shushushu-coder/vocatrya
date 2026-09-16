"use client";
import { Loader, Sparkles } from "lucide-react";
import type { AiModel } from "@/models/ai.model";
import { ResponsiveCardHeader } from "../../ResponsiveCardHeader";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useI18n } from "@/i18n";

export function StructureWithAiCard({
  aiModel,
  ollamaConnected,
  connectionError,
  isStructuring,
  onStructure,
}: {
  aiModel: AiModel;
  ollamaConnected: boolean | null;
  connectionError: string;
  isStructuring: boolean;
  onStructure: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card className="border-dashed">
      <ResponsiveCardHeader>
        <div>
          <p className="text-sm text-muted-foreground">
            {t("profile.fileAttachedStructure")}
          </p>
          {aiModel.provider === "ollama" &&
            ollamaConnected === false &&
            connectionError && (
              <p className="text-xs text-red-600 mt-1">
                {connectionError}
              </p>
            )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            isStructuring ||
            (aiModel.provider === "ollama" && ollamaConnected === false)
          }
          onClick={onStructure}
        >
          {isStructuring ? (
            <Loader className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Sparkles className="h-4 w-4 mr-2" />
          )}
          {isStructuring
            ? t("profile.structuring")
            : t("profile.structureWithAi")}
        </Button>
      </ResponsiveCardHeader>
    </Card>
  );
}
