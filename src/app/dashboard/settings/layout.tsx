import type { ReactNode } from "react";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.settings") };
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return children;
}
