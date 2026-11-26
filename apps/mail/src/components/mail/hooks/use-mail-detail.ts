// What the mail page's detail column shows, a message or the composer, opened and closed with the history rule every
// detail column shares. The mail actions and the sidebar's Compose both open through it, so a compose from the list
// closes back to it with its search kept, and one over an open message replaces that message's entry.

import { useMatch, useNavigate } from '@tanstack/react-router';
import { MAILBOX_INBOX, mailboxRouteSegment } from '@workspace/lib/constants/mailboxes';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import type { NewDraft } from '@workspace/lib/types/mail';
import type { DetailHistory } from '@workspace/ui/hooks/use-detail-history';
import { useDetailHistory } from '@workspace/ui/hooks/use-detail-history';
import { Route } from '../../../routes/_auth.$filterType.$filterId';

// A message by its id, or the composer with what it opens prefilled with.
export type MailDetail = string | { prefillDraft?: NewDraft; forwardedParts?: FileSubject[] };

// The sidebar also shows outside a mailbox for a moment, such as while the app redirects, so its Compose opens Inbox.
export function useMailDetail(): DetailHistory<MailDetail> {
    const match = useMatch({ from: Route.id, shouldThrow: false });
    const navigate = useNavigate();
    const filterType = match?.params.filterType ?? 'box';
    const filterId = match?.params.filterId ?? mailboxRouteSegment(MAILBOX_INBOX);
    const isOpen = (match?.search.mailId ?? match?.search.mode) !== undefined;

    // Each entry writes its own compose state, so a prefill never rides along into a message or the list, and a fresh
    // composeSessionKey remounts any open composer.
    return useDetailHistory<MailDetail>(isOpen, (next, { replace, state }) => {
        const compose = typeof next === 'object' ? next : undefined;
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: (prev) => ({
                ...prev,
                mailId: typeof next === 'string' ? next : undefined,
                mode: compose && 'compose',
                to: undefined,
            }),
            replace,
            state: (prev) => ({
                ...(state === true ? prev : state(prev)),
                prefillDraft: compose?.prefillDraft,
                forwardedParts: compose?.forwardedParts,
                composeSessionKey: compose && crypto.randomUUID(),
            }),
        });
    });
}
