"use client";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

// Falls back to the app mark both when the company has no logo and when the
// stored URL 404s; onerror is cleared first so a broken fallback can't loop.
export function CompanyLogo({
  logoUrl,
  className,
}: {
  logoUrl?: string | null;
  className?: string;
}) {
  const { t } = useI18n();

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={t("jobs.companyLogoAlt")}
      className={cn("rounded-md object-cover", className)}
      src={logoUrl || "/images/vocatrya-logo.svg"}
      onError={(e) => {
        e.currentTarget.onerror = null;
        e.currentTarget.src = "/images/vocatrya-logo.svg";
      }}
    />
  );
}
