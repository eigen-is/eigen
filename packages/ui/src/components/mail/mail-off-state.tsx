import { MailX } from 'lucide-react';
import { EmptyState } from '../layout/app/empty-state';

// Every Mail entry point is hidden on a server without hosted mail; this catches the bookmark or typed URL.
export function MailOffState() {
    return (
        <EmptyState
            icon={<MailX className="h-8 w-8" />}
            message="Mail is turned off on this server"
            hint="Your administrator runs Eigen without hosted mailboxes. Use your own mail app instead."
        />
    );
}
