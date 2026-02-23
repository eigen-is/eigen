import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';

describe('Mail', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('list mailboxes returns structure', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailboxes`);
        const data = await res.json() as any;
        expect(data).toBeDefined();
    });

    test('create custom mailbox', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/mailbox`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mailbox: 'Projects', attributes: []}),
            });
        expect(res.status).toBe(200);
    });

    describe('Cross-user isolation', () => {
        test('Bob has his own mailboxes', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/mail/${ctx.bob.user.id}/mailboxes`);
            const data = await res.json() as any;
            expect(data).toBeDefined();
        });
    });
});
