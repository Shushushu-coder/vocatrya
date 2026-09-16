import AuthCard from "@/components/auth/AuthCard";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("auth.signin") };
}

export default function Signin() {
  return <AuthCard mode="signin" />;
}
