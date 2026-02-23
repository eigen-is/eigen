import {createRootRouteWithContext} from '@tanstack/react-router'
import {Outlet} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app-shell";
import {EmailSidebar} from "../components/mail/email-sidebar";
import {useMailboxes, useMoveEmail, useEmailById} from '@workspace/lib/mail';

interface MyRouterContext {
    auth: AuthContextType
}

function MailRoot() {
    const {user} = useAuth();

    if (!user) {
        return (
            <AppShell appName="mail" rootRoute={Route}>
                <Outlet/>
            </AppShell>
        );
    }

    return <AuthenticatedMailRoot/>;
}

function AuthenticatedMailRoot() {
    const {data: mailboxes = [], isLoading, error} = useMailboxes();
    const moveMail = useMoveEmail();
    const getEmailById = useEmailById();

    const handleMoveByDrop = async (emailIds: string[], folderId: string) => {
        for (const id of emailIds) {
            const email = await getEmailById(id);
            if (email) await moveMail.mutateAsync({email, mailbox: folderId});
        }
    };

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
                    onMoveToFolder={handleMoveByDrop}
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
