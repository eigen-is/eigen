import {createFileRoute, redirect} from '@tanstack/react-router'
import {EmailSidebar} from "../components/mail/email-sidebar";
import {useMailboxes} from '@workspace/lib/mail';
import {AppLayout} from "@workspace/ui/components/layout/app-layout";

export const Route = createFileRoute('/_auth')({
    beforeLoad: ({context, location}) => {
        if (!context.auth.isAuthenticated) {
            throw redirect({
                to: '/login',
                search: {
                    redirect: location.href,
                },
            })
        }
    },
    component: AuthLayout,
})

function AuthLayout() {
    const {data: mailboxes = [], isLoading: isMailboxesLoading, error: isMailboxesError} = useMailboxes();

    return (
        <AppLayout sidebar={({condensed, isMobile, onClose}) => (
            <EmailSidebar
                condensed={condensed}
                isMobile={isMobile}
                onClose={onClose}
                mailboxes={mailboxes}
                isLoading={isMailboxesLoading}
                error={isMailboxesError}
            />
        )}/>
    );
}
