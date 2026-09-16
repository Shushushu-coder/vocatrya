"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import {
  generateMockActivitiesAction,
  clearMockActivitiesAction,
  generateMockProfileDataAction,
  clearMockProfileDataAction,
  generateMockJobsAction,
  clearMockJobsAction,
} from "@/actions/mock.actions";
import { useI18n } from "@/i18n";

type StatusMessage = { type: "success" | "error"; text: string };

function StatusBanner({ message }: { message: StatusMessage }) {
  const { t } = useI18n();
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border p-4 ${
        message.type === "error"
          ? "border-red-200 bg-red-50 text-red-900"
          : "border-green-200 bg-green-50 text-green-900"
      }`}
    >
      {message.type === "error" ? (
        <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
      ) : (
        <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
      )}
      <div className="flex-1">
        <p className="font-semibold">
          {message.type === "error" ? t("common.error") : t("common.success")}
        </p>
        <p className="text-sm">{message.text}</p>
      </div>
    </div>
  );
}

export function MockActivitiesCard() {
  const { t } = useI18n();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setMessage(null);
    const result = await generateMockActivitiesAction();
    setMessage({
      type: result.success ? "success" : "error",
      text:
        result.message ||
        (result.success
          ? t("developer.mockActivitiesGenerated")
          : t("developer.mockActivitiesGenerateFailed")),
    });
    setIsGenerating(false);
  };

  const handleClear = async () => {
    if (!confirm(t("developer.confirmClearMockActivities")))
      return;

    setIsClearing(true);
    setMessage(null);
    const result = await clearMockActivitiesAction();
    setMessage({
      type: result.success ? "success" : "error",
      text:
        result.message ||
        (result.success
          ? t("developer.mockActivitiesCleared")
          : t("developer.mockActivitiesClearFailed")),
    });
    setIsClearing(false);
  };

  return (
    <div className="space-y-4">
      {message && <StatusBanner message={message} />}
      <Card>
        <CardHeader>
          <CardTitle>{t("developer.mockDataManagement")}</CardTitle>
          <CardDescription>
            {t("developer.mockActivitiesCardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">{t("developer.generateMockActivities")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("developer.generateMockActivitiesBody")}
            </p>
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || isClearing}
              className="w-full"
            >
              {isGenerating && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isGenerating ? t("developer.generating") : t("developer.generateMockActivities")}
            </Button>
          </div>

          <div className="border-t pt-4">
            <h3 className="font-semibold mb-2">{t("developer.clearMockActivities")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("developer.clearMockActivitiesBody")}
            </p>
            <Button
              onClick={handleClear}
              disabled={isClearing || isGenerating}
              variant="destructive"
              className="w-full"
            >
              {isClearing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isClearing ? t("developer.clearing") : t("developer.clearMockActivities")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function MockProfileCard() {
  const { t } = useI18n();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setMessage(null);
    const result = await generateMockProfileDataAction();
    setMessage({
      type: result.success ? "success" : "error",
      text:
        result.message ||
        (result.success
          ? t("developer.mockProfileGenerated")
          : t("developer.mockProfileGenerateFailed")),
    });
    setIsGenerating(false);
  };

  const handleClear = async () => {
    if (!confirm(t("developer.confirmClearMockProfile")))
      return;

    setIsClearing(true);
    setMessage(null);
    const result = await clearMockProfileDataAction();
    setMessage({
      type: result.success ? "success" : "error",
      text:
        result.message ||
        (result.success
          ? t("developer.mockProfileCleared")
          : t("developer.mockProfileClearFailed")),
    });
    setIsClearing(false);
  };

  return (
    <div className="space-y-4">
      {message && <StatusBanner message={message} />}
      <Card>
        <CardHeader>
          <CardTitle>{t("developer.mockProfileData")}</CardTitle>
          <CardDescription>
            {t("developer.mockProfileCardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">{t("developer.generateMockProfileData")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("developer.generateMockProfileBody")}
            </p>
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || isClearing}
              className="w-full"
            >
              {isGenerating && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isGenerating ? t("developer.generating") : t("developer.generateMockProfileData")}
            </Button>
          </div>

          <div className="border-t pt-4">
            <h3 className="font-semibold mb-2">{t("developer.clearMockProfileData")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("developer.clearMockProfileBody")}
            </p>
            <Button
              onClick={handleClear}
              disabled={isClearing || isGenerating}
              variant="destructive"
              className="w-full"
            >
              {isClearing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isClearing ? t("developer.clearing") : t("developer.clearMockProfileData")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function MockJobsCard() {
  const { t } = useI18n();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setMessage(null);
    const result = await generateMockJobsAction();
    setMessage({
      type: result.success ? "success" : "error",
      text:
        result.message ||
        (result.success
          ? t("developer.mockJobsGenerated")
          : t("developer.mockJobsGenerateFailed")),
    });
    setIsGenerating(false);
  };

  const handleClear = async () => {
    if (!confirm(t("developer.confirmClearMockJobs")))
      return;

    setIsClearing(true);
    setMessage(null);
    const result = await clearMockJobsAction();
    setMessage({
      type: result.success ? "success" : "error",
      text:
        result.message ||
        (result.success
          ? t("developer.mockJobsCleared")
          : t("developer.mockJobsClearFailed")),
    });
    setIsClearing(false);
  };

  return (
    <div className="space-y-4">
      {message && <StatusBanner message={message} />}
      <Card>
        <CardHeader>
          <CardTitle>{t("developer.mockJobsData")}</CardTitle>
          <CardDescription>
            {t("developer.mockJobsCardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold mb-2">{t("developer.generateMockJobs")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("developer.generateMockJobsBody")}
            </p>
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || isClearing}
              className="w-full"
            >
              {isGenerating && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isGenerating ? t("developer.generating") : t("developer.generateMockJobs")}
            </Button>
          </div>

          <div className="border-t pt-4">
            <h3 className="font-semibold mb-2">{t("developer.clearMockJobs")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("developer.clearMockJobsBody")}
            </p>
            <Button
              onClick={handleClear}
              disabled={isClearing || isGenerating}
              variant="destructive"
              className="w-full"
            >
              {isClearing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isClearing ? t("developer.clearing") : t("developer.clearMockJobs")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
