"use client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PlusCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/i18n";

export default function JobsAppliedCard() {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <Card className="sm:col-span-2 min-w-0 flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg text-green-600">{t("nav.dashboard")}</CardTitle>
        <CardDescription className="max-w-lg text-balance leading-relaxed">
          {t("dashboard.createNewHint")}
        </CardDescription>
      </CardHeader>
      <CardFooter className="mt-auto grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          className="justify-start min-w-0"
          onClick={() => router.push("/dashboard/myjobs?add-job=true")}
        >
          <PlusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />
          <span className="min-w-0 truncate">{t("dashboard.job")}</span>
        </Button>
        <Button
          variant="outline"
          className="justify-start min-w-0"
          onClick={() =>
            router.push("/dashboard/automations?add-automation=true")
          }
        >
          <PlusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />
          <span className="min-w-0 truncate">{t("dashboard.automation")}</span>
        </Button>
        <Button
          variant="outline"
          className="justify-start min-w-0"
          onClick={() => router.push("/dashboard/tasks?add-task=true")}
        >
          <PlusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />
          <span className="min-w-0 truncate">{t("dashboard.task")}</span>
        </Button>
        <Button
          variant="outline"
          className="justify-start min-w-0"
          onClick={() =>
            router.push("/dashboard/questions?add-question=true")
          }
        >
          <PlusCircle className="h-3.5 w-3.5 mr-1 shrink-0" />
          <span className="min-w-0 truncate">{t("dashboard.question")}</span>
        </Button>
      </CardFooter>
    </Card>
  );
}
