import AdminTabsContainer from "@/components/admin/AdminTabsContainer";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.library") };
}

async function AdminPage() {
  const { t } = await getServerI18n();
  return (
    <div className="flex flex-col col-span-3">
      <h3 className="text-2xl font-semibold leading-none tracking-tight mb-4">
        {t("nav.library")}
      </h3>
      <AdminTabsContainer />
    </div>
  );
}

export default AdminPage;
