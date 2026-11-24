import { Suspense } from "react";
import { FeishuExtensionClient } from "@/components/extensions/FeishuExtensionClient";
import { getServerI18n } from "@/i18n/server";
import { feishuT } from "@/lib/extensions/feishu/copy";

export async function generateMetadata() {
  const { locale } = await getServerI18n();
  return { title: feishuT(locale, "page.title") };
}

export default function FeishuExtensionPage() {
  return (
    <div className="col-span-3 mx-auto w-full max-w-2xl px-4 py-6">
      <Suspense>
        <FeishuExtensionClient />
      </Suspense>
    </div>
  );
}
