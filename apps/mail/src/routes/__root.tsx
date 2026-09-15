import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type RouterAppContext, useAuth } from '@workspace/lib/auth';
import { useEmailById, useMailboxes, useMoveEmail } from '@workspace/lib/mail';
import { useMailEnabled } from '@workspace/lib/public';
import type { Email } from '@workspace/lib/types/mail';
import { AppShell, EmptyState } from '@workspace/ui';
import { MailX } from 'lucide-react';
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

    // Every other Mail entry point is hidden on a server without hosted mail; this catches the
    // bookmark or typed URL that still lands here.
    if (!mailEnabled) {
        return (
            <AppShell appName="mail" rootRoute={Route} sidebarMode="none">
                <EmptyState
                    icon={<MailX className="h-8 w-8" />}
                    message="Mail is turned off on this server"
                    hint="Your administrator runs Eigen without hosted mailboxes. Use your own mail app instead."
                />
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
