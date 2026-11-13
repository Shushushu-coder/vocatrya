import { Suspense } from "react";
import { NotionExtensionClient } from "@/components/extensions/NotionExtensionClient";
import { getServerI18n } from "@/i18n/server";
import { notionT } from "@/lib/extensions/notion/copy";

export async function generateMetadata() {
  const { locale } = await getServerI18n();
  return { title: notionT(locale, "page.title") };
}

export default function NotionExtensionPage() {
  return (
    <div className="col-span-3 mx-auto w-full max-w-2xl px-4 py-6">
      <Suspense>
        <NotionExtensionClient />
      </Suspense>
    </div>
  );
}
