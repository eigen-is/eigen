import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {emailKeys} from './hooks/use-emails';
import {mailboxKeys} from './hooks/use-mailboxes';

export function handleMailSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    switch (event.type) {
        case SSEventType.MAIL_RECEIVED:
            queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            return true;

        default:
            return false;
    }
}
