import { createFileRoute, redirect } from '@tanstack/react-router';
import { MAILBOX_INBOX_KEY } from '@workspace/lib/constants/mailboxes';

export const Route = createFileRoute('/')({
    beforeLoad: () => {
        throw redirect({
            to: '/$filterType/$filterId',
            params: {
                filterType: 'box',
                filterId: MAILBOX_INBOX_KEY,
            },
        });
    },
});
