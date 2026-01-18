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
        case SSEventType.MAIL_RECEIVED:
            queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;

        case SSEventType.MAIL_DELETED:
            queryClient.invalidateQueries({queryKey: emailKeys.detail(mail.messageId)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
            queryClient.invalidateQueries({queryKey: emailKeys.list('trash')});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;

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

        case SSEventType.MAIL_READ_CHANGED:
            queryClient.invalidateQueries({queryKey: emailKeys.detail(mail.messageId)});
            queryClient.invalidateQueries({queryKey: emailKeys.list(mailbox)});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            return true;

        case SSEventType.MAIL_DRAFT_UPDATED:
            queryClient.invalidateQueries({queryKey: emailKeys.list('drafts')});
            queryClient.invalidateQueries({queryKey: emailKeys.detail(mail.messageId)});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;

        case SSEventType.MAIL_SENT:
            queryClient.invalidateQueries({queryKey: emailKeys.list('drafts')});
            queryClient.invalidateQueries({queryKey: emailKeys.list('sent')});
            queryClient.invalidateQueries({queryKey: emailKeys.detail(mail.messageId)});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;

        default:
            return false;
    }
}
