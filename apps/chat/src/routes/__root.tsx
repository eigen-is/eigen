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
            sidebar={user ? ({ condensed }) => <ChatSidebar condensed={condensed} /> : undefined}
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: ChatRoot,
});
