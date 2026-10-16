import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <main className="relative flex min-h-[calc(100vh-var(--desktop-titlebar-height,0px))] items-center justify-center bg-muted/40">
      <div className="absolute top-4 right-4 z-10">
        <LanguageSwitcher />
      </div>
      {children}
    </main>
  );
}
