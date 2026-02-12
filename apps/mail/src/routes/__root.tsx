import {createRootRouteWithContext} from '@tanstack/react-router'
import {Outlet} from '@tanstack/react-router'
import {AuthContextType} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";
import {EmailSidebar} from "../components/mail/email-sidebar";
import {useMailboxes} from '@workspace/lib/mail';

interface MyRouterContext {
    auth: AuthContextType
}

function MailRoot() {
    const {data: mailboxes = [], isLoading, error} = useMailboxes();

    return (
        <AppShell
            appName="mail"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <EmailSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    mailboxes={mailboxes}
                    isLoading={isLoading}
                    error={error}
                />
            )}
        >
            <Outlet/>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: MailRoot,
});
