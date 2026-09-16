import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getServerI18n } from "@/i18n/server";

export default async function NotFound() {
  const { t } = await getServerI18n();

  return (
    <div className="col-span-3 flex flex-col items-center justify-center py-24 text-center">
      <FileQuestion className="h-12 w-12 text-muted-foreground mb-4" />
      <h3 className="text-lg font-medium">{t("notFound.title")}</h3>
      <p className="text-muted-foreground mt-2">
        {t("notFound.description")}
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link href="/dashboard">{t("notFound.backToDashboard")}</Link>
      </Button>
    </div>
  );
}
