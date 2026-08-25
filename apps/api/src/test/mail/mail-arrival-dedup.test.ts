import { beforeAll, describe, expect, test } from 'bun:test';
import { authedRequest, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
let ctx: TestCtx;

beforeAll(async () => {
    ctx = await getTestContext();
});

async function deliverEmail(to: string, from: string, subject: string, body: string): Promise<void> {
    const eml = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, '', body].join('\r\n');
    const res = await ctx.app.handle(
        new Request(`http://localhost/mail/deliver/${to}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
        }),
    );
    if (res.status !== 200) throw new Error(`Delivery failed: ${res.status}`);
}

describe('Mail-arrival notification dedupe', () => {
    test('multiple new emails produce a single mail:new notification row', async () => {
        await deliverEmail(ctx.alice.user.email, 'one@external.com', 'First', 'one');
        await deliverEmail(ctx.alice.user.email, 'two@external.com', 'Second', 'two');

        // Sync inbox to trigger notification persistence.
        await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/`);

        const res = await authedRequest(ctx.alice.user.sessionToken, `/notifications/${ctx.alice.user.id}`);
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.notifications ?? data ?? []);
        const mailRows = list.filter((n: { tag: string }) => n.tag === 'mail:new');
        expect(mailRows.length).toBe(1);
    });
});
