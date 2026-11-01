"use client";
import { Building2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  companyAvatarPaletteClass,
  companyAvatarText,
} from "@/lib/company-avatar";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

// One accessible name on the root covers every render state — loaded logo,
// letter avatar and neutral icon — so nothing inside announces a second time.
// Radix Avatar owns the image load/error state machine: the fallback shows
// while the image is pending and whenever it fails.
export function CompanyLogo({
  logoUrl,
  name,
  className,
}: {
  logoUrl?: string | null;
  name?: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  const letters = companyAvatarText(name);
  const trimmedName = name?.trim();

  return (
    <Avatar
      role="img"
      aria-label={trimmedName || t("jobs.companyLogoAlt")}
      className={cn("rounded-md", className)}
    >
      {logoUrl ? (
        <AvatarImage src={logoUrl} alt="" className="object-cover" />
      ) : null}
      <AvatarFallback
        className={cn(
          "rounded-md text-sm font-semibold",
          letters
            ? companyAvatarPaletteClass(name)
            : "bg-muted text-muted-foreground",
        )}
      >
        {letters || <Building2 className="h-1/2 w-1/2" />}
      </AvatarFallback>
    </Avatar>
  );
}
