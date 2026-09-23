// A mail sync broadcasts one mail:received per message, so during a burst the handler refetches the mailbox
// list (the unread counts) once, while each message list it touched still refetches at once.
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { SSEventType } from '@workspace/lib/types/sse';
import { emailKeys, mailboxKeys } from '../../../core/mail/hooks/keys';
import { handleMailSSEvent } from '../../../core/mail/sse-handlers';

// Record every queryKey passed to invalidateQueries. Recipe: the drive sse-handlers test.
function trackingClient(): { queryClient: QueryClient; touched: readonly unknown[][] } {
    const queryClient = new QueryClient();
    const touched: unknown[][] = [];
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = (filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) touched.push([...filters.queryKey]);
        return invalidate(filters as never);
    };
    return { queryClient, touched };
}

function countKey(touched: readonly unknown[][], expected: readonly unknown[]): number {
    const wanted = JSON.stringify(expected);
    return touched.filter((key) => JSON.stringify(key) === wanted).length;
}

// The debounce is a trailing timer; the mailbox refetch lands after one window, not before it.
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 400));
}

describe('handleMailSSEvent — burst', () => {
    test('50 received messages refetch the mailbox list once', async () => {
        const owner = 'owner-burst';
        const { queryClient, touched } = trackingClient();

        for (let i = 0; i < 50; i++) {
            const event = { type: SSEventType.MAIL_RECEIVED, mail: { messageId: `msg-${i}`, mailbox: '' } };
            expect(handleMailSSEvent(event, queryClient, owner)).toBe(true);
        }

        expect(countKey(touched, emailKeys.list(owner, ''))).toBe(50);
        expect(countKey(touched, mailboxKeys.lists(owner))).toBe(0);

        await settle();
        expect(countKey(touched, mailboxKeys.lists(owner))).toBe(1);
    });

    test('mixed mail events share the one debounced mailbox refetch', async () => {
        const owner = 'owner-mixed';
        const { queryClient, touched } = trackingClient();
        const types = [
            SSEventType.MAIL_RECEIVED,
            SSEventType.MAIL_MOVED,
            SSEventType.MAIL_DELETED,
            SSEventType.MAIL_READ_CHANGED,
            SSEventType.MAIL_DRAFT_UPDATED,
            SSEventType.MAIL_SENT,
        ];

        for (const [i, type] of types.entries()) {
            handleMailSSEvent({ type, mail: { messageId: `msg-${i}`, mailbox: 'Archive' } }, queryClient, owner);
        }
        expect(countKey(touched, mailboxKeys.lists(owner))).toBe(0);

        await settle();
        expect(countKey(touched, mailboxKeys.lists(owner))).toBe(1);
    });
});
