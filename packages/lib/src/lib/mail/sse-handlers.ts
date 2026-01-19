import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {emailKeys} from './hooks/use-emails';
import {mailboxKeys} from './hooks/use-mailboxes';
import {invalidateHomeSize} from '../home';

const normalizeMailbox = (mailbox: string) => mailbox === '' ? 'inbox' : mailbox;

export function handleMailSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event.type.startsWith('mail:')) return false;
    if (!('mail' in event)) return false;

    const {mail} = event;
    const mailbox = normalizeMailbox(mail.mailbox);

    switch (event.type) {
        // API: New email delivered to inbox → invalidate inbox list, mailbox counts, home size
        case SSEventType.MAIL_RECEIVED:
            queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;

        // API: Email permanently deleted from trash → remove detail cache, invalidate trash list, mailbox counts, home size
        case SSEventType.MAIL_DELETED:
            queryClient.removeQueries({queryKey: emailKeys.detail(mail.messageId)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;

        // API: Email moved from source to target mailbox → invalidate detail, source list, target list, mailbox counts
        case SSEventType.MAIL_MOVED: {
            const toMailbox = mail.toMailbox != null ? normalizeMailbox(mail.toMailbox) : null;
            queryClient.invalidateQueries({queryKey: emailKeys.detail(mail.messageId)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
            if (toMailbox != null) {
                queryClient.invalidateQueries({queryKey: emailKeys.list(toMailbox)});
            }
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            return true;
        }

        // API: Email read status toggled → invalidate detail, mailbox list (shows read indicator), mailbox counts
        case SSEventType.MAIL_READ_CHANGED:
            queryClient.invalidateQueries({queryKey: emailKeys.detail(mail.messageId)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            return true;

        // API: Draft created or updated → invalidate drafts list, detail, mailbox counts, home size
        case SSEventType.MAIL_DRAFT_UPDATED:
            queryClient.invalidateQueries({queryKey: emailKeys.list('drafts')});
            queryClient.invalidateQueries({queryKey: emailKeys.detail(mail.messageId)});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;

        // API: Email sent (also emits MAIL_DRAFT_UPDATED + MAIL_MOVED) → no invalidation needed, toast only
        case SSEventType.MAIL_SENT:
            return true;

        default:
            return false;
    }
}
