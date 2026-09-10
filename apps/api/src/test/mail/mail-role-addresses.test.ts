import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { assertJson, authedRequest, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
let ctx: TestCtx;

beforeAll(async () => {
    ctx = await getTestContext();
});

async function deliver(to: string, subject: string): Promise<Response> {
    const eml = [`From: reporter@external.com`, `To: ${to}`, `Subject: ${subject}`, '', 'Report body.'].join('\r\n');
    return authedRequest(ctx.alice.user.sessionToken, `/mail/deliver/${to}`, {
        method: 'POST',
        body: new TextEncoder().encode(eml).buffer,
    });
}

async function inboxSubjects(user: { id: string; sessionToken: string }): Promise<string[]> {
    const res = await authedRequest(user.sessionToken, `/mail/${user.id}/mailbox/inbox`);
    const list = await assertJson<EmailSummary[]>(res);
    return list.map((m) => m.subject);
}

describe('Mail role-address delivery', () => {
    for (const local of ['postmaster', 'abuse', 'noreply']) {
        test(`${local}@ delivers to the org admin, not to a non-admin user`, async () => {
            const subject = `Role ${local} ${randomUUID()}`;
            const res = await deliver(`${local}@test.eigen.is`, subject);
            expect(res.status).toBe(200);

            expect(await inboxSubjects(ctx.alice.user)).toContain(subject);
            expect(await inboxSubjects(ctx.bob.user)).not.toContain(subject);
        });
    }

    test('an upper-cased role local part still lands with the admin', async () => {
        const subject = `Role Postmaster ${randomUUID()}`;
        const res = await deliver('Postmaster@test.eigen.is', subject);
        expect(res.status).toBe(200);
        expect(await inboxSubjects(ctx.alice.user)).toContain(subject);
    });

    test('an unknown, non-role address still 404s', async () => {
        const res = await deliver('nobody@test.eigen.is', `Unknown ${randomUUID()}`);
        expect(res.status).toBe(404);
    });

    test("an existing user's own address still delivers to that user", async () => {
        const subject = `Direct ${randomUUID()}`;
        const res = await deliver(ctx.bob.user.email, subject);
        expect(res.status).toBe(200);
        expect(await inboxSubjects(ctx.bob.user)).toContain(subject);
    });
});
