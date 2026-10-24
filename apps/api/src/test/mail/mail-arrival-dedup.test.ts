import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { MAILBOX_INBOX } from '@workspace/lib/constants/mailboxes';
import type { EmailSummary } from '@workspace/lib/types/mail';
import type { Notification } from '@workspace/lib/types/notification';
import { evictHome } from '../../lib/home/get-home';
import { boxDir } from '../mail-test-helpers';
import type { TestUser } from '../setup';
import { assertJson, authedRequest, collectSSE, createTestUser, eventually, getTestContext } from '../setup';

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
        await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/inbox`);

        const res = await authedRequest(ctx.alice.user.sessionToken, `/notifications/${ctx.alice.user.id}`);
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.notifications ?? data ?? []);
        const mailRows = list.filter((n: { tag: string }) => n.tag === 'mail:new');
        expect(mailRows.length).toBe(1);
    });
});

describe('Mail-arrival notification read state', () => {
    let user: TestUser;

    beforeAll(async () => {
        user = await createTestUser(`mail-read-${Date.now()}@test.eigen.is`, 'testpassword123', 'Mail Read');
    });

    async function unreadInbox(): Promise<EmailSummary[]> {
        const rows = await assertJson<EmailSummary[]>(
            await authedRequest(user.sessionToken, `/mail/${user.id}/mailbox/inbox`),
        );
        return rows.filter((m) => !m.isRead);
    }

    async function mailNewIsRead(): Promise<boolean | undefined> {
        const rows = await assertJson<Notification[]>(
            await authedRequest(user.sessionToken, `/notifications/${user.id}`),
        );
        return rows.find((n) => n.tag === 'mail:new')?.read;
    }

    async function markRead(id: string): Promise<void> {
        const res = await authedRequest(user.sessionToken, `/mail/${user.id}/message/${id}/read`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: true }),
        });
        expect(res.status).toBe(200);
    }

    test('reading the last unread inbox message through the route reads the notification', async () => {
        await deliverEmail(user.email, 'one@external.com', 'First', 'one');
        const [last, ...rest] = await unreadInbox();
        expect(await mailNewIsRead()).toBe(false);

        for (const m of rest) await markRead(m.id);
        expect(await mailNewIsRead()).toBe(false);
        await markRead(last!.id);
        expect(await mailNewIsRead()).toBe(true);
    });

    test('a Seen flag set by an IMAP client on the last unread message reads the notification', async () => {
        await deliverEmail(user.email, 'two@external.com', 'Second', 'two');
        const [mail] = await unreadInbox();
        expect(await mailNewIsRead()).toBe(false);

        const cur = join(boxDir(user.id, MAILBOX_INBOX), 'cur');
        renameSync(join(cur, mail!.filename), join(cur, `${mail!.filename}S`));
        await eventually(async () => ((await unreadInbox()).length === 0 ? true : undefined), 'the Seen flag indexed');
        expect(await mailNewIsRead()).toBe(true);
    });

    test('moving or deleting the last unread inbox message unread reads the notification', async () => {
        for (const remove of [
            (id: string) =>
                authedRequest(user.sessionToken, `/mail/${user.id}/message/move-to-trash`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messageId: id }),
                }),
            (id: string) => authedRequest(user.sessionToken, `/mail/${user.id}/message/${id}`, { method: 'DELETE' }),
        ]) {
            await deliverEmail(user.email, 'three@external.com', 'Third', 'three');
            const [mail] = await unreadInbox();
            expect(await mailNewIsRead()).toBe(false);

            expect((await remove(mail!.id)).status).toBe(200);
            expect(await mailNewIsRead()).toBe(true);
        }
    });
});

describe('Mail read in another mail app while an Eigen tab is open', () => {
    test('reads the notification without anyone opening Mail', async () => {
        const user = await createTestUser(`mail-tab-${Date.now()}@test.eigen.is`, 'testpassword123', 'Mail Tab');
        // A fresh home whose mail nobody listed; the open tab is only an event stream.
        await evictHome(user.id);
        const tab = await collectSSE(user.id);
        try {
            await deliverEmail(user.email, 'phone@external.com', 'Read on the phone', 'body');
            const unread = async () =>
                (
                    await assertJson<Notification[]>(
                        await authedRequest(user.sessionToken, `/notifications/${user.id}`),
                    )
                ).find((n) => n.tag === 'mail:new')?.read === false;
            expect(await unread()).toBe(true);

            // The phone reads everything, the welcome mail included: the IMAP server gives each message the
            // Seen flag, in cur/ (moving it there from new/).
            const inbox = boxDir(user.id, MAILBOX_INBOX);
            for (const dir of ['new', 'cur']) {
                for (const name of readdirSync(join(inbox, dir))) {
                    const flags = name.split(':2,')[1];
                    if (flags?.includes('S')) continue;
                    renameSync(
                        join(inbox, dir, name),
                        join(inbox, 'cur', flags === undefined ? `${name}:2,S` : `${name}S`),
                    );
                }
            }

            await eventually(async () => ((await unread()) ? undefined : true), 'the notification read');
        } finally {
            tab.stop();
        }
    });
});
