import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Header from "@/components/Header";
import { TitleBarActions } from "@/components/desktop/TitleBarActions";
import Sidebar from "@/components/Sidebar";
import { ActivityProvider } from "@/context/ActivityContext";
import { GlobalActivityBanner } from "@/components/activities/GlobalActivityBanner";
import { SidebarProvider } from "@/context/SidebarContext";
import { clampSidebarWidth } from "@/lib/constants";
import SidebarInset from "@/components/SidebarInset";
import { SaveStatusProvider } from "@/context/SaveStatusContext";
import { RightRailProvider } from "@/context/RightRailContext";
import { AgentChatProvider } from "@/components/agent/AgentChatProvider";
import { AgentChatPanel } from "@/components/agent/AgentChatPanel";
import { loadActiveChatConversation } from "@/actions/agentChat.actions";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { canMutateJobsSurface, isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import { CareerSurfacesProvider } from "@/context/CareerSurfacesContext";
import { APP_CONSTANTS } from "@/lib/constants";
import { getCurrentUser } from "@/utils/user.utils";
import StaleSessionSignOut from "@/components/StaleSessionSignOut";
import { auth, signOut } from "@/auth";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The sign-in redirect lives here, not in middleware (see auth.config.ts):
  // `redirect()` emits a relative Location resolved against the request
  // origin, keeping the desktop runtime on 127.0.0.1:<dynamic-port>.
  const session = await auth();
  if (!session?.user) {
    redirect("/signin");
  }
  const cookieStore = await cookies();
  const sidebarCookie = cookieStore.get(APP_CONSTANTS.SIDEBAR_STORAGE_KEY);
  const initialExpanded = sidebarCookie ? sidebarCookie.value === "true" : true;
  const sidebarWidthCookie = Number(
    cookieStore.get(APP_CONSTANTS.SIDEBAR_WIDTH_STORAGE_KEY)?.value,
  );
  const initialWidth = Number.isFinite(sidebarWidthCookie)
    ? clampSidebarWidth(sidebarWidthCookie)
    : undefined;
  // Loaded here rather than in the client: avoids an empty-panel flash on
  // every load, and the race where a message sent before hydration completes
  // is merged against an empty transcript and then persisted.
  const activeId = cookieStore.get(
    APP_CONSTANTS.AGENT_CHAT_ACTIVE_CONVERSATION_KEY,
  )?.value;
  const conversation = await loadActiveChatConversation(activeId);
  const [user, runtime] = await Promise.all([
    getCurrentUser(),
    getCareerRuntimeSnapshot(),
  ]);
  const freshNativeFull = isFreshNativeFullSurface(runtime);

  const signOutAction = async () => {
    "use server";
    await signOut({ redirectTo: "/signin" });
  };

  // The session outlived the database it was minted against: middleware still
  // passes the signed cookie, but the user row is gone and every scoped query
  // would read as empty rather than unauthorized.
  if (!user) {
    return <StaleSessionSignOut signOutAction={signOutAction} />;
  }

  return (
    <ActivityProvider>
      <CareerSurfacesProvider freshNativeFull={freshNativeFull} jobMutationsEnabled={canMutateJobsSurface(runtime)}>
      <SidebarProvider initialExpanded={initialExpanded} initialWidth={initialWidth}>
        <RightRailProvider>
          <AgentChatProvider initialConversation={conversation.data ?? null}>
            <SaveStatusProvider>
            <div className="flex min-h-[calc(100vh-var(--desktop-titlebar-height,0px))] w-full bg-muted/40">
              <Sidebar user={user} signOutAction={signOutAction} />
              <SidebarInset>
                {/* Renders only portals into DesktopTitleBar's slots; kept
                    inside the provider tree so the agent-chat trigger and
                    mode-aware upload href resolve correctly. */}
                <TitleBarActions />
                <Header />
                <GlobalActivityBanner />
                {/* Container, not viewport, queries: the docked chat panel
                    shrinks this box without changing the viewport width. */}
                <main className="@container/main flex-1 p-4 sm:px-4 sm:py-0">
                  <div className="items-start gap-4 md:gap-4 @3xl/main:grid @3xl/main:grid-cols-3">
                    {children}
                  </div>
                </main>
              </SidebarInset>
              {/* Portaled, so it sits outside the 3-column grid and needs no
                  col-span-3 wrapper. */}
              <AgentChatPanel />
            </div>
            </SaveStatusProvider>
          </AgentChatProvider>
        </RightRailProvider>
      </SidebarProvider>
      </CareerSurfacesProvider>
    </ActivityProvider>
  );
}
