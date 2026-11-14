import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import type { RouterAppContext } from '@workspace/lib/types/auth';
import { AppShell } from '@workspace/ui';
import { ChatSidebar } from '../components/chat/chat-sidebar';

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

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: ChatRoot,
});
