import AdminTabsContainer from "@/components/admin/AdminTabsContainer";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.library") };
}

async function AdminPage() {
  const { t } = await getServerI18n();
  return (
    <div className="col-span-3 flex min-w-0 flex-col">
      <h3 className="text-2xl font-semibold leading-none tracking-tight mb-4">
        {t("nav.library")}
      </h3>
      <AdminTabsContainer />
    </div>
  );
}

export default AdminPage;
