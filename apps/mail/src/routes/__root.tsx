import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type RouterAppContext, useAuth } from '@workspace/lib/auth';
import { useEmailById, useMailboxes, useMoveEmail } from '@workspace/lib/mail';
import { useMailEnabled } from '@workspace/lib/public';
import type { Email } from '@workspace/lib/types/mail';
import { AppShell } from '@workspace/ui';
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
