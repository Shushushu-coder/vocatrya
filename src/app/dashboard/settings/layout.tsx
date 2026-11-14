import type { ReactNode } from "react";
import { getServerI18n } from "@/i18n/server";
import { resolveAppVersion, resolveBuildFacts } from "@/lib/appVersion";
import { APP_CONSTANTS } from "@/lib/constants";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  const buildFacts = resolveBuildFacts();
  return {
    title: t("nav.settings"),
    // The running version reaches the client as a document meta so the About
    // page can prefer it over the build-time NEXT_PUBLIC_APP_VERSION — in a
    // packaged install the two can differ (stale bundled web build). Build
    // fact metas exist only inside a packaged install; dev/web runs emit
    // nothing so client surfaces hide the rows rather than show fake facts.
    other: {
      [APP_CONSTANTS.APP_VERSION_META_NAME]: resolveAppVersion(),
      ...(buildFacts
        ? {
            [APP_CONSTANTS.APP_BUILD_COMMIT_META_NAME]: buildFacts.commit,
            [APP_CONSTANTS.APP_BUILT_AT_META_NAME]: buildFacts.builtAt,
          }
        : {}),
    },
  };
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return children;
}
