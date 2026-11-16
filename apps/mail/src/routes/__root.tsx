// Mail's root route: the app shell around every Mail page. When mail is off on this server it shows only the
// mail-off notice, without a sidebar. Otherwise anyone signed in gets the mail sidebar with their mailboxes,
// where a message dropped on a mailbox moves into it, and a signed-out visitor only the shell.

import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { useEmailById, useMailboxes, useMoveEmail } from '@workspace/lib/mail';
import { useMailEnabled } from '@workspace/lib/public';
import type { RouterAppContext } from '@workspace/lib/types/auth';
import type { Email } from '@workspace/lib/types/mail';
import { AppShell } from '@workspace/ui/components/layout/app';
import { MailOffState } from '@workspace/ui/components/mail';
import { EmailSidebar } from '../components/mail/email-sidebar';

function MailRoot() {
    const { user } = useAuth();
    const mailEnabled = useMailEnabled();
    const { data: mailboxes = [], isLoading, error } = useMailboxes();
    const moveMail = useMoveEmail();
    const getEmailById = useEmailById();

    const handleMoveByDrop = async (emailIds: string[], folderId: string) => {
        const emails = (await Promise.all(emailIds.map((id) => getEmailById(id)))).filter((e): e is Email => !!e);
        await Promise.allSettled(emails.map((email) => moveMail.mutateAsync({ email, mailbox: folderId })));
    };

    if (!mailEnabled) {
        return (
            <AppShell appName="mail" rootRoute={Route} sidebarMode="none">
                <MailOffState />
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="mail"
            rootRoute={Route}
            sidebar={
                user
                    ? ({ condensed }) => (
                          <EmailSidebar
                              condensed={condensed}
                              mailboxes={mailboxes}
                              isLoading={isLoading}
                              error={error}
                              onMoveToFolder={handleMoveByDrop}
                          />
                      )
                    : undefined
            }
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: MailRoot,
});
