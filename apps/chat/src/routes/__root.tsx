import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type AuthContextType, useAuth } from '@workspace/lib/auth';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell.tsx';
import { ChatSidebar } from '../components/chat/chat-sidebar';

type MyRouterContext = {
    auth: AuthContextType;
};

function ChatRoot() {
    const { user } = useAuth();

    return (
        <AppShell
            appName="chat"
            rootRoute={Route}
            sidebar={
                user
                    ? ({ condensed, isMobile, onClose }) => (
                          <ChatSidebar condensed={condensed} isMobile={isMobile} onClose={onClose} />
                      )
                    : undefined
            }
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: ChatRoot,
});
