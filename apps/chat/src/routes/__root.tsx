// Chat's root route: the app shell around every Chat page. Anyone signed in gets the Chat sidebar, whose room
// list is where they pick a chat, and a signed-out visitor, such as on the login page, only the shell.

import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import type { RouterAppContext } from '@workspace/lib/types/auth';
import { AppShell } from '@workspace/ui/components/layout/app';
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
