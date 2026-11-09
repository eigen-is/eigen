import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { CommentEntry, DrivePath } from '@workspace/lib/types';
import type { FileEvent } from '@workspace/lib/types/file-history';
import type { Notification } from '@workspace/lib/types/notification';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { getHome } from '../../lib/home';
import * as homeRelay from '../../lib/home/home-relay';
import type { OutboundMail } from '../../lib/mailer/mailer';
import * as mailer from '../../lib/mailer/mailer';
import type { TestUser } from '../setup';
import {
    assertJson,
    authedRequest,
    createTestGuest,
    driveGet,
    drivePost,
    drivePut,
    eventually,
    findOrFail,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function patchAssignee(
    token: string,
    ownerId: string,
    mountId: string,
    pathId: string,
    chatName: string,
    assignee: string | null,
    title?: string,
) {
    return authedRequest(token, `/collab/${ownerId}/${mountId}/${pathId}/comments/${chatName}/assignee`, {
        method: 'PATCH',
        body: JSON.stringify(title === undefined ? { assignee } : { assignee, title }),
        headers: { 'Content-Type': 'application/json' },
    });
}

async function notificationsFor(userId: string): Promise<Notification[]> {
    const home = await getHome(userId);
    return home.notifications.list();
}

describe('Comment assignee', () => {
    let ctx: TestCtx;
    let mountId: string;
    let docId: string;
    let chatFolderId: string;
    const chatName = 'assign-flow.eigenchat';

    async function listComments(): Promise<CommentEntry[]> {
        return assertJson<CommentEntry[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${mountId}/${docId}/comments`,
            ),
        );
    }

    async function allEvents(): Promise<FileEvent[]> {
        return assertJson<FileEvent[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${docId}/history`,
            ),
        );
    }

    async function assignedEvents(): Promise<FileEvent[]> {
        return (await allEvents()).filter((e) => e.eventType === 'assigned');
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;

        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}/create/doc`,
            { fileName: 'assign-doc' },
        );
        docId = doc.id;

        const children = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${docId}`,
        );
        chatFolderId = findOrFail(children, (c: DrivePath) => c.name === 'chat').id;
        await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${chatFolderId}/create/chat`,
            { fileName: 'assign-flow' },
        );

        // Share the doc with bob (write) so he is an assignable effective member.
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docId}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });
    });

    test('assign requires write permission', async () => {
        // charlie was never granted access → canWrite is false → 403.
        const res = await patchAssignee(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ctx.charlie.user.email,
        );
        expect(res.status).toBe(403);
    });

    test('assigning a non-member email → 400', async () => {
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            'stranger@nowhere.test',
        );
        expect(res.status).toBe(400);
    });

    test('assign stores lowercased and shows up in the list', async () => {
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ctx.bob.user.email.toUpperCase(),
            'Fix header',
        );
        expect(await assertJson<{ success: boolean }>(res)).toEqual({ success: true });

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBe(ctx.bob.user.email);
        // Client-posted title is cached on the comment row.
        expect(row.title).toBe('Fix header');
    });

    test('a real assignment records an "assigned" activity event with the card title', async () => {
        const row = findOrFail(await assignedEvents(), (e: FileEvent) => {
            const d = e.details;
            return !!d && 'assignee' in d && d.chatName === chatName;
        });
        expect(row.actorEmail).toBe(ctx.alice.user.email);
        const details = row.details && 'assignee' in row.details ? row.details : null;
        expect(details?.assignee).toBe(ctx.bob.user.email);
        expect(details?.card).toBe('Fix header');
    });

    test('assignment notifies the assignee', async () => {
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${chatName}`;
        const notification = findOrFail(await notificationsFor(ctx.bob.user.id), (n: Notification) => n.tag === tag);
        expect(notification.type).toBe('assigned');
        expect(notification.title).toContain('assign-doc');
        expect(notification.actorEmail).toBe(ctx.alice.user.email);
    });

    test('re-assigning the already-selected member is a no-op: no new event, no new notification', async () => {
        // bob is still the assignee from the earlier test — re-selecting him must not re-record.
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${chatName}`;
        const eventsBefore = (await assignedEvents()).length;
        expect(eventsBefore).toBe(1);
        const notifsBefore = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length;

        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ctx.bob.user.email,
        );
        expect(res.status).toBe(200);

        // Exactly ONE 'assigned' row still — file history has no dedupe window on this path.
        expect((await assignedEvents()).length).toBe(1);
        expect((await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length).toBe(notifsBefore);
        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBe(ctx.bob.user.email);
    });

    test('self-assign does not notify', async () => {
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ctx.alice.user.email,
        );
        expect(res.status).toBe(200);
        // Alice is never assigned by anyone else, so she must have no 'assigned' rows.
        expect((await notificationsFor(ctx.alice.user.id)).some((n) => n.type === 'assigned')).toBe(false);
    });

    test('unassign clears and does not notify', async () => {
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${chatName}`;
        const before = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length;
        const eventsBefore = (await assignedEvents()).length;

        const res = await patchAssignee(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, chatName, null);
        expect(res.status).toBe(200);

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBeNull();

        const after = (await notificationsFor(ctx.bob.user.id)).filter((n) => n.tag === tag).length;
        expect(after).toBe(before);
        // Unassign stays silent in Recent Activity too — no new 'assigned' row.
        expect((await assignedEvents()).length).toBe(eventsBefore);
    });

    test('assigning an unregistered invitee succeeds and silently skips the notification', async () => {
        const ghost = 'ghost-invitee@test.eigen.is';
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docId}/acl`, {
            add: [{ id: ghost, read: true, write: false }],
        });

        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            ghost,
        );
        expect(res.status).toBe(200);

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.assignee).toBe(ghost);
    });

    test('a thread with no index row answers 404 to a status or assignee write, with no event and no notification', async () => {
        // A drive call with no user seeds no row, which is the one way a thread goes without.
        const home = await getHome(ctx.alice.user.id);
        const thread = await home.drive.create(mountId, chatFolderId, 'no-row', 'chat');
        const eventsBefore = await allEvents();

        const assign = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            thread.name,
            ctx.bob.user.email,
        );
        const status = await authedRequest(
            ctx.alice.user.sessionToken,
            `/collab/${ctx.alice.user.id}/${mountId}/${docId}/comments/${thread.name}/status`,
            {
                method: 'PATCH',
                body: JSON.stringify({ status: 'resolved' }),
                headers: { 'Content-Type': 'application/json' },
            },
        );

        expect([assign.status, status.status]).toEqual([404, 404]);
        expect((await allEvents()).length).toBe(eventsBefore.length);
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${thread.name}`;
        expect((await notificationsFor(ctx.bob.user.id)).some((n) => n.tag === tag)).toBe(false);
    });

    test("a status change on the owner's drive tells the document's open tabs", async () => {
        const home = await getHome(ctx.alice.user.id);
        const heard: SSEvent[] = [];
        const listener = (event: SSEvent) => heard.push(event);
        home.subscribeSSE(listener);
        try {
            await home.drive.setCommentStatus(mountId, docId, chatName, 'resolved', home.user);
            await home.drive.setCommentStatus(mountId, docId, chatName, 'open', home.user);
            await Bun.sleep(50);
        } finally {
            home.unsubscribeSSE(listener);
        }
        expect(heard.filter((event) => event.type === SSEventType.CHAT_COMMENT_INDEX_UPDATED).length).toBe(2);
    });

    test('the owner writing to a path that does not exist gets a 404, with no write check in the way', async () => {
        const write = (field: string, body: object) =>
            authedRequest(
                ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${mountId}/nonexistent-id/comments/${chatName}/${field}`,
                {
                    method: 'PATCH',
                    body: JSON.stringify(body),
                    headers: { 'Content-Type': 'application/json' },
                },
            );
        const status = await write('status', { status: 'resolved' });
        const assignee = await write('assignee', { assignee: null });
        expect([status.status, assignee.status]).toEqual([404, 404]);
    });

    test('assigning on a nonexistent chatName → 404, no row, no event, no notification', async () => {
        // The write must 404 rather than mint a phantom row + immutable 'assigned' event + dead-link notification.
        const ghostName = 'ghost-thread.eigenchat';
        const res = await patchAssignee(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            ghostName,
            ctx.bob.user.email,
        );
        expect(res.status).toBe(404);

        expect((await listComments()).some((r) => r.chatName === ghostName)).toBe(false);
        const ghostEvent = (await assignedEvents()).some((e: FileEvent) => {
            const d = e.details;
            return !!d && 'assignee' in d && d.chatName === ghostName;
        });
        expect(ghostEvent).toBe(false);
        const tag = `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${ghostName}`;
        expect((await notificationsFor(ctx.bob.user.id)).some((n) => n.tag === tag)).toBe(false);
    });
});

describe('Assignment email', () => {
    let ctx: TestCtx;
    let mountId: string;
    let rootId: string;
    let guest: TestUser;
    let otherGuest: TestUser;
    let mail: ReturnType<typeof catchMail>;

    function catchMail() {
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear();
        return spy;
    }

    function assignMailsTo(address: string): OutboundMail[] {
        return mail.mock.calls
            .map(([message]) => message)
            .filter(
                (message) =>
                    message.subject.includes('assigned you a comment') &&
                    message.to.some((recipient) => recipient.address === address),
            );
    }

    // A detached mail may still be on its way when the route answers.
    function oneMailTo(address: string): Promise<OutboundMail> {
        return eventually(async () => assignMailsTo(address)[0], `the mail to ${address}`);
    }

    function twoMailsTo(address: string): Promise<OutboundMail[]> {
        return eventually(async () => {
            const mails = assignMailsTo(address);
            return mails.length >= 2 ? mails : undefined;
        }, `a second mail to ${address}`);
    }

    async function expectNoMailTo(address: string): Promise<void> {
        await Bun.sleep(50);
        expect(assignMailsTo(address)).toEqual([]);
    }

    function linkIn(message: OutboundMail): URL {
        return new URL(message.text.match(/https?:\/\/\S+/)?.[0] ?? '');
    }

    function bellTag(docId: string, chatName: string): string {
        return `assigned:${ctx.alice.user.id}:${mountId}:${docId}:${chatName}`;
    }

    async function setFlags(flags: { guestOnAssign?: boolean; userOnAssign?: boolean }): Promise<void> {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notifications: { email: flags } }),
        });
        expect(res.status).toBe(200);
    }

    // The limiter has no reset, so every test gets a document of its own.
    async function freshDoc(name: string, members: string[], cardCount = 1) {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const doc = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${rootId}/create/doc`, {
            fileName: name,
        });
        const children = await driveGet<DrivePath[]>(token, ownerId, mountId, `folder/${doc.id}`);
        const chatFolder = findOrFail(children, (c: DrivePath) => c.name === 'chat');
        const chatNames: string[] = [];
        for (let i = 0; i < cardCount; i++) {
            const chat = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${chatFolder.id}/create/chat`, {
                fileName: `card-${i}`,
            });
            chatNames.push(chat.name);
        }
        await drivePut(token, ownerId, mountId, `path/${doc.id}/acl`, {
            add: members.map((id) => ({ id, read: true, write: true })),
        });
        return { docId: doc.id, chatName: chatNames[0], chatNames };
    }

    function assign(docId: string, chatName: string, assignee: string | null, title?: string, actor?: TestUser) {
        return patchAssignee(
            (actor ?? ctx.alice.user).sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            chatName,
            assignee,
            title,
        );
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = findOrFail(mounts ?? [], () => true).id;
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        guest = await createTestGuest('Assign Guest');
        otherGuest = await createTestGuest('Other Guest');
    });

    beforeEach(async () => {
        await setFlags({ guestOnAssign: true, userOnAssign: false });
        mail = catchMail();
    });

    afterEach(async () => {
        mail.mockRestore();
        await setFlags({ guestOnAssign: true, userOnAssign: false });
    });

    test('a guest with an account gets one mail that opens the card, and a bell row', async () => {
        const { docId, chatName } = await freshDoc('mail-guest', [guest.email]);

        expect((await assign(docId, chatName, guest.email, 'Fix header')).status).toBe(200);

        const message = await oneMailTo(guest.email);
        expect(assignMailsTo(guest.email)).toHaveLength(1);
        expect(message.subject).toBe(`${ctx.alice.user.name} assigned you a comment on "mail-guest"`);
        expect(message.from).toEqual({ name: ctx.alice.user.name, address: ctx.alice.user.email });
        expect(message.html).toContain('Fix header');
        expect(message.text).toContain('Fix header');

        const link = linkIn(message);
        expect(link.searchParams.get('chat')).toBe(chatName);
        expect(link.searchParams.get('email')).toBe(guest.email);
        expect(link.pathname).toContain(`/${ctx.alice.user.id}/${mountId}/${docId}`);
        // The HTML holds the same link, with its & escaped for the attribute.
        expect(message.html).toContain(`href="${link.toString().replaceAll('&', '&amp;')}"`);
        // A pill cannot carry the param, so there is none.
        expect(message.html).not.toContain('<svg');

        const tag = bellTag(docId, chatName);
        expect((await notificationsFor(guest.id)).some((n) => n.tag === tag)).toBe(true);
    });

    test('a card with no title still gets its mail and link', async () => {
        const { docId, chatName } = await freshDoc('mail-no-title', [guest.email]);

        await assign(docId, chatName, guest.email);

        expect(linkIn(await oneMailTo(guest.email)).searchParams.get('chat')).toBe(chatName);
    });

    test('an address with no account on the ACL gets a mail and no notification, and the assignment stands', async () => {
        const ghost = `ghost-${crypto.randomUUID()}@external.com`;
        const { docId, chatName } = await freshDoc('mail-ghost', [ghost]);
        const relay = spyOn(homeRelay, 'sendToHome');
        relay.mockClear();

        try {
            expect((await assign(docId, chatName, ghost, 'For the ghost')).status).toBe(200);
            await oneMailTo(ghost);
            expect(assignMailsTo(ghost)).toHaveLength(1);
            const tag = bellTag(docId, chatName);
            const told = relay.mock.calls.filter(
                ([, message]) => message.type === 'notification' && message.notification.tag === tag,
            );
            expect(told).toEqual([]);
        } finally {
            relay.mockRestore();
        }

        const rows = await assertJson<CommentEntry[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${mountId}/${docId}/comments`,
            ),
        );
        expect(findOrFail(rows, (r: CommentEntry) => r.chatName === chatName).assignee).toBe(ghost);
    });

    test('a registered user gets the bell and no mail, by default', async () => {
        const { docId, chatName } = await freshDoc('mail-user-default', [ctx.bob.user.email]);

        await assign(docId, chatName, ctx.bob.user.email);

        await expectNoMailTo(ctx.bob.user.email);
        const tag = bellTag(docId, chatName);
        expect((await notificationsFor(ctx.bob.user.id)).some((n) => n.tag === tag)).toBe(true);
    });

    test('userOnAssign mails a registered user', async () => {
        await setFlags({ userOnAssign: true });
        const { docId, chatName } = await freshDoc('mail-user-on', [ctx.bob.user.email]);

        await assign(docId, chatName, ctx.bob.user.email);

        await oneMailTo(ctx.bob.user.email);
        expect(assignMailsTo(ctx.bob.user.email)).toHaveLength(1);
    });

    test('with guestOnAssign off, neither a guest nor an address with no account gets a mail', async () => {
        await setFlags({ guestOnAssign: false, userOnAssign: true });
        const ghost = `ghost-${crypto.randomUUID()}@external.com`;
        const { docId, chatNames } = await freshDoc('mail-guest-off', [guest.email, ghost], 2);

        await assign(docId, chatNames[0], guest.email);
        await assign(docId, chatNames[1], ghost);

        await expectNoMailTo(guest.email);
        await expectNoMailTo(ghost);
    });

    test('a self-assign sends no mail', async () => {
        await setFlags({ userOnAssign: true });
        const { docId, chatName } = await freshDoc('mail-self', [guest.email]);

        await assign(docId, chatName, ctx.alice.user.email);

        await expectNoMailTo(ctx.alice.user.email);
    });

    test('a self-assign by a guest sends no mail', async () => {
        const { docId, chatName } = await freshDoc('mail-self-guest', [guest.email]);

        expect((await assign(docId, chatName, guest.email, undefined, guest)).status).toBe(200);

        await expectNoMailTo(guest.email);
    });

    test('an unassign sends no mail', async () => {
        const { docId, chatName } = await freshDoc('mail-unassign', [guest.email]);
        await assign(docId, chatName, guest.email);
        await oneMailTo(guest.email);
        mail.mockClear();

        expect((await assign(docId, chatName, null)).status).toBe(200);

        await Bun.sleep(50);
        expect(mail).not.toHaveBeenCalled();
    });

    test('picking the current assignee sends no mail, with the window free', async () => {
        const { docId, chatName } = await freshDoc('mail-current', [guest.email]);
        // The failed first mail frees the window, so only "nothing changed" can hold the second one back.
        mail.mockResolvedValueOnce(false);
        await assign(docId, chatName, guest.email);
        await oneMailTo(guest.email);
        await Bun.sleep(50);

        await assign(docId, chatName, guest.email);

        await Bun.sleep(50);
        expect(assignMailsTo(guest.email)).toHaveLength(1);
    });

    test('a second card in the same document sends no second mail, another document does', async () => {
        const first = await freshDoc('mail-window-first', [guest.email], 2);
        const other = await freshDoc('mail-window-other', [guest.email]);

        await assign(first.docId, first.chatNames[0], guest.email);
        await oneMailTo(guest.email);
        await assign(first.docId, first.chatNames[1], guest.email);
        await Bun.sleep(50);
        expect(assignMailsTo(guest.email)).toHaveLength(1);

        await assign(other.docId, other.chatName, guest.email);
        const mails = await twoMailsTo(guest.email);
        expect(mails).toHaveLength(2);
        expect(mails[1].subject).toContain('mail-window-other');
    });

    test('two people assigned in one document each get a mail', async () => {
        const { docId, chatNames } = await freshDoc('mail-two-people', [guest.email, otherGuest.email], 2);

        await assign(docId, chatNames[0], guest.email);
        await assign(docId, chatNames[1], otherGuest.email);

        await oneMailTo(guest.email);
        await oneMailTo(otherGuest.email);
    });

    test('a reassign back and forth on one card mails each person once', async () => {
        const { docId, chatName } = await freshDoc('mail-back-and-forth', [guest.email, otherGuest.email]);

        await assign(docId, chatName, guest.email);
        await assign(docId, chatName, otherGuest.email);
        await assign(docId, chatName, guest.email);
        await oneMailTo(otherGuest.email);

        await Bun.sleep(50);
        expect(assignMailsTo(guest.email)).toHaveLength(1);
        expect(assignMailsTo(otherGuest.email)).toHaveLength(1);
    });

    test('a send that returns false frees the window, so the next assignment mails', async () => {
        const { docId, chatNames } = await freshDoc('mail-failed-send', [guest.email], 2);
        mail.mockResolvedValueOnce(false);

        await assign(docId, chatNames[0], guest.email);
        await oneMailTo(guest.email);
        await Bun.sleep(50);
        await assign(docId, chatNames[1], guest.email);

        expect(await twoMailsTo(guest.email)).toHaveLength(2);
    });

    test('a guest actor mails like anyone', async () => {
        const { docId, chatName } = await freshDoc('mail-guest-actor', [guest.email, otherGuest.email]);

        expect((await assign(docId, chatName, otherGuest.email, 'From a guest', guest)).status).toBe(200);

        const message = await oneMailTo(otherGuest.email);
        expect(message.subject).toBe(`${guest.name} assigned you a comment on "mail-guest-actor"`);
        expect(message.from).toEqual({ name: guest.name, address: guest.email });
    });

    test('a card title with markup is escaped in the HTML', async () => {
        const { docId, chatName } = await freshDoc('mail-escape', [guest.email]);

        await assign(docId, chatName, guest.email, '<b>Bold</b> move');

        const message = await oneMailTo(guest.email);
        expect(message.html).toContain('&lt;b&gt;Bold&lt;/b&gt; move');
        expect(message.html).not.toContain('<b>Bold');
        expect(message.text).toContain('<b>Bold</b> move');
    });

    test('an actor with no name shows as their address, in the mail and on the bell', async () => {
        const { docId, chatName } = await freshDoc('mail-no-name', [guest.email]);
        const home = await getHome(ctx.alice.user.id);

        await home.drive.assignComment(mountId, docId, chatName, guest.email, { ...home.user, name: '' });

        const message = await oneMailTo(guest.email);
        const title = `${ctx.alice.user.email} assigned you a comment on "mail-no-name"`;
        expect(message.subject).toBe(title);
        const tag = bellTag(docId, chatName);
        expect(findOrFail(await notificationsFor(guest.id), (n: Notification) => n.tag === tag).title).toBe(title);
    });

    test('a home that cannot take the notification does not stop the mail or the assignment', async () => {
        const { docId, chatName } = await freshDoc('mail-relay-throws', [guest.email]);
        const original = homeRelay.sendToHome;
        const relay = spyOn(homeRelay, 'sendToHome').mockImplementation(async (target, message) => {
            if (message.type === 'notification' && message.notification.type === 'assigned') {
                throw new Error('home held');
            }
            await original(target, message);
        });

        try {
            expect((await assign(docId, chatName, guest.email)).status).toBe(200);
            await oneMailTo(guest.email);
        } finally {
            relay.mockRestore();
        }
    });

    test('a mail that fails does not touch the assignment or the bell', async () => {
        const { docId, chatName } = await freshDoc('mail-rejected', [guest.email]);
        mail.mockRejectedValueOnce(new Error('relay down'));

        expect((await assign(docId, chatName, guest.email)).status).toBe(200);

        await oneMailTo(guest.email);
        const tag = bellTag(docId, chatName);
        expect((await notificationsFor(guest.id)).some((n) => n.tag === tag)).toBe(true);
    });

    test('a relay that never answers does not hold the response', async () => {
        const { docId, chatName } = await freshDoc('mail-slow', [guest.email]);
        mail.mockImplementationOnce(() => new Promise(() => {}));

        expect((await assign(docId, chatName, guest.email)).status).toBe(200);

        expect(assignMailsTo(guest.email)).toHaveLength(1);
    });
});
