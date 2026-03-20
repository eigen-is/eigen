import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app/app-shell.tsx";
import {ChatSidebar} from "../components/chat/chat-sidebar";
import {DEFAULT_MOUNT_ID, useRootFolder} from '@workspace/lib/drive';

type MyRouterContext = {
    auth: AuthContextType
}

function ChatRoot() {
    const {user} = useAuth();

    if (!user) {
        return (
            <AppShell appName="chat" rootRoute={Route}>
                <Outlet/>
            </AppShell>
        );
    }

    return <AuthenticatedChatRoot/>;
}

function AuthenticatedChatRoot() {
    const {user} = useAuth();
    const mountId = DEFAULT_MOUNT_ID;
    const {data: root} = useRootFolder(user?.id || '', mountId);

    return (
        <AppShell
            appName="chat"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <ChatSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    ownerId={user?.id || ''}
                    mountId={mountId}
                    rootPath={root || null}
                />
            )}
        >
            <Outlet/>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: ChatRoot,
});
