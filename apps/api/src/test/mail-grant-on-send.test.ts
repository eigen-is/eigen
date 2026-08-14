import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AddressObject, EmailDraft } from '@workspace/lib/types/mail';
import type { Notification } from '@workspace/lib/types/notification';
import { updateServerSettings } from '../lib/config/server-settings';
import { ApiError } from '../lib/core/errors';
import * as mailer from '../lib/core/mailer';
import Drive from '../lib/drive/drive';
import { getEntriesForTarget } from '../lib/share/registry';
import { assertJson, authedRequest, driveGet, drivePost, drivePut, getTestContext } from './setup';

const isWindows = process.platform === 'win32';

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let aliceMountId: string;
let aliceRootId: string;

let sent: mailer.OutboundMail[] = [];
let spy: ReturnType<typeof spyOn> | undefined;
let daclSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(async () => {
    ctx = await getTestContext();
    const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
    aliceMountId = mounts![0].id;
    aliceRootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root')).id;
});

const startCapture = () => {
    sent = [];
    spy = spyOn(mailer, 'sendMail').mockImplementation(async (m) => {
        sent.push(m);
        return true;
    });
};

afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
    daclSpy?.mockRestore();
    daclSpy = undefined;
    delete process.env['EIGEN_DEMO'];
});

function addr(list: string): AddressObject {
    const value = list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((address) => ({ address, name: '' }));
    return { value, html: '', text: list };
}

async function createDoc(name: string): Promise<string> {
    const doc = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        aliceMountId,
        `folder/${aliceRootId}/create/doc`,
        { fileName: name },
    );
    return doc.id;
}

async function createChat(name: string): Promise<string> {
    const chat = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        aliceMountId,
        `folder/${aliceRootId}/create/chat`,
        { fileName: name },
    );
    return chat.id;
}

async function setAcl(
    pathId: string,
    body: { add?: Array<{ id: string; read: boolean; write: boolean }>; visibility?: string },
): Promise<void> {
    await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${pathId}/acl`, body);
}

async function getAcl(pathId: string): Promise<DrivePath['acl']> {
    const path = await driveGet<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        aliceMountId,
        `path/${pathId}`,
    );
    return path.acl;
}

function ref(id: string, overrides: Partial<AttachmentReference> = {}): AttachmentReference {
    return {
        type: 'reference',
        ownerId: ctx.alice.user.id,
        mountId: aliceMountId,
        id,
        name: 'Grantable.eigendoc',
        driveType: 'doc',
        mimeType: 'application/eigendoc',
        ...overrides,
    };
}

// PUT a draft carrying the references, then POST send with the same body plus grantAccessRefIds.
// to/cc/bcc/refs are re-applied on the send body from the known inputs so assertions never depend
// on the EML round-trip's field order (mirrors mail-send-copies.test.ts).
async function sendWithGrant(opts: {
    token?: string;
    ownerId?: string;
    to: string;
    cc?: string;
    bcc?: string;
    refs: AttachmentReference[];
    grant?: string[];
    subject?: string;
}): Promise<{ draftId: string; res: Response; subject: string }> {
    const token = opts.token ?? ctx.alice.user.sessionToken;
    const ownerId = opts.ownerId ?? ctx.alice.user.id;
    const subject = opts.subject ?? 'Grant send';
    const fields: { to: AddressObject; cc?: AddressObject; bcc?: AddressObject } = { to: addr(opts.to) };
    if (opts.cc) fields.cc = addr(opts.cc);
    if (opts.bcc) fields.bcc = addr(opts.bcc);

    const mail = { subject, text: 'see attached', html: '<p>see attached</p>', driveReferences: opts.refs, ...fields };
    const putRes = await authedRequest(token, `/mail/${ownerId}/message/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mail }),
    });
    const draft = await assertJson<EmailDraft>(putRes);

    const sendBody = { ...draft, ...fields, driveReferences: opts.refs };
    const res = await authedRequest(token, `/mail/${ownerId}/message/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mail: sendBody, grantAccessRefIds: opts.grant }),
    });
    return { draftId: draft.id, res, subject };
}

describe.skipIf(isWindows)('Mail — grant access to references at send', () => {
    // 1. External To + Cc both gain a read ACL; only send copies go out (no share email leaks).
    test('grants read to external To and Cc recipients; no share emails; registry for unknown', async () => {
        startCapture();
        const docId = await createDoc(`grant-tocc-${randomUUID()}`);
        const toEmail = `grant-to-${randomUUID()}@external.example`;
        const ccEmail = `grant-cc-${randomUUID()}@external.example`;

        const { res, subject } = await sendWithGrant({ to: toEmail, cc: ccEmail, refs: [ref(docId)], grant: [docId] });
        expect(res.status).toBe(200);

        const acl = await getAcl(docId);
        expect(acl).toContainEqual({ id: toEmail, read: true, write: false });
        expect(acl).toContainEqual({ id: ccEmail, read: true, write: false });

        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((m) => m.subject === subject)).toBe(true);

        expect(await getEntriesForTarget(toEmail)).toContain(ctx.alice.user.id);
    });

    // 2. A bcc'd address is never granted (it is excluded from the grant email set by construction).
    test('a bcc identity is never written to the ACL', async () => {
        startCapture();
        const docId = await createDoc(`grant-bcc-${randomUUID()}`);
        const toEmail = `grant-to2-${randomUUID()}@external.example`;
        const bccEmail = `grant-bcc-${randomUUID()}@external.example`;

        const { res } = await sendWithGrant({ to: toEmail, bcc: bccEmail, refs: [ref(docId)], grant: [docId] });
        expect(res.status).toBe(200);

        const acl = await getAcl(docId);
        expect(acl?.some((a) => a.id === bccEmail)).toBe(false);
        expect(acl).toContainEqual({ id: toEmail, read: true, write: false });
    });

    // 3. A recipient who already reads the doc gets no additional ACL entry.
    test('a recipient who already has read gets no new ACL entry', async () => {
        startCapture();
        const docId = await createDoc(`grant-hasread-${randomUUID()}`);
        const email = `grant-existing-${randomUUID()}@external.example`;
        await setAcl(docId, { add: [{ id: email, read: true, write: false }] });

        const { res } = await sendWithGrant({ to: email, refs: [ref(docId)], grant: [docId] });
        expect(res.status).toBe(200);

        const entries = (await getAcl(docId))?.filter((a) => a.id === email) ?? [];
        expect(entries).toEqual([{ id: email, read: true, write: false }]);
    });

    // 4. A public-read doc grants read to everyone already, so no ACL delta — but a closed-signup
    //    unknown still gets a registry entry so it can be admitted as a guest.
    test('public doc: no ACL delta, but a registry entry is created for a closed-signup unknown', async () => {
        await updateServerSettings({ guests: { openSignup: false } });
        try {
            startCapture();
            const docId = await createDoc(`grant-public-${randomUUID()}`);
            await setAcl(docId, { visibility: 'public-read' });
            const before = await getAcl(docId);
            const email = `grant-public-ext-${randomUUID()}@example.com`;

            const { res } = await sendWithGrant({ to: email, refs: [ref(docId)], grant: [docId] });
            expect(res.status).toBe(200);

            expect(await getAcl(docId)).toEqual(before);
            expect((await getAcl(docId))?.some((a) => a.id === email) ?? false).toBe(false);
            expect(await getEntriesForTarget(email)).toContain(ctx.alice.user.id);
        } finally {
            await updateServerSettings({ guests: { openSignup: true } });
        }
    });

    // 5. Chat exclusion keys off the RESOLVED path type, not the client-authored driveType.
    test('a chat referenced with a lied driveType:doc is rejected by resolved type; nothing sent', async () => {
        startCapture();
        const chatId = await createChat(`grant-chat-${randomUUID()}`);
        const before = await getAcl(chatId);
        const email = `grant-chat-ext-${randomUUID()}@external.example`;

        const { res } = await sendWithGrant({
            to: email,
            refs: [ref(chatId, { driveType: 'doc', name: 'Not really a doc.eigendoc' })],
            grant: [chatId],
        });
        expect(res.status).toBe(400);
        expect(sent.length).toBe(0);
        expect(await getAcl(chatId)).toEqual(before);
    });

    // 5b. An existing write-only entry keeps its write bit when upgraded to read.
    test('write bit is preserved when upgrading a write-only entry to read', async () => {
        startCapture();
        const docId = await createDoc(`grant-writebit-${randomUUID()}`);
        const bobEmail = ctx.bob.user.email;
        await setAcl(docId, { add: [{ id: bobEmail, read: false, write: true }] });

        const { res } = await sendWithGrant({ to: bobEmail, refs: [ref(docId)], grant: [docId] });
        expect(res.status).toBe(200);

        expect(await getAcl(docId)).toContainEqual({ id: bobEmail.toLowerCase(), read: true, write: true });
    });

    // 6. A read-only sharer cannot grant onward: 403, draft kept, ACL untouched, nothing sent.
    test('a read-only sharer cannot grant: 403, draft kept, ACL unchanged, nothing sent', async () => {
        startCapture();
        const docId = await createDoc(`grant-readonly-${randomUUID()}`);
        await setAcl(docId, { add: [{ id: ctx.bob.user.email, read: true, write: false }] });
        const before = await getAcl(docId);
        const email = `grant-ro-ext-${randomUUID()}@external.example`;

        const { draftId, res } = await sendWithGrant({
            token: ctx.bob.user.sessionToken,
            ownerId: ctx.bob.user.id,
            to: email,
            refs: [ref(docId)],
            grant: [docId],
        });
        expect(res.status).toBe(403);
        expect(sent.length).toBe(0);
        expect(await getAcl(docId)).toEqual(before);

        const draft = await assertJson<EmailDraft>(
            await authedRequest(ctx.bob.user.sessionToken, `/mail/${ctx.bob.user.id}/message/${draftId}`),
        );
        expect(draft.isDraft).toBe(true);
    });

    // 7. Preflight-all: every ref is checked before any is mutated, so an unshareable second ref
    //    aborts the whole grant — the first doc must NOT gain a grant.
    test('preflight-all: an unshareable second ref aborts with no grant on the first', async () => {
        startCapture();
        const docA = await createDoc(`grant-pf-a-${randomUUID()}`);
        const docB = await createDoc(`grant-pf-b-${randomUUID()}`);
        await setAcl(docA, { add: [{ id: ctx.bob.user.email, read: true, write: true }] });
        await setAcl(docB, { add: [{ id: ctx.bob.user.email, read: true, write: false }] });
        const beforeA = await getAcl(docA);
        const email = `grant-pf-ext-${randomUUID()}@external.example`;

        const { res } = await sendWithGrant({
            token: ctx.bob.user.sessionToken,
            ownerId: ctx.bob.user.id,
            to: email,
            refs: [ref(docA), ref(docB)],
            grant: [docA, docB],
        });
        expect(res.status).toBe(403);
        expect(sent.length).toBe(0);
        expect(await getAcl(docA)).toEqual(beforeA);
        expect((await getAcl(docA))?.some((a) => a.id === email) ?? false).toBe(false);
    });

    // 7b. A mid-loop runtime failure never rolls back grants that already persisted.
    test('a mid-loop mutation failure never rolls back earlier grants', async () => {
        startCapture();
        const docA = await createDoc(`grant-midfail-a-${randomUUID()}`);
        const docB = await createDoc(`grant-midfail-b-${randomUUID()}`);

        const originalUpdate = Drive.prototype.updateACLDelta;
        daclSpy = spyOn(Drive.prototype, 'updateACLDelta').mockImplementation(function (
            this: Drive,
            ...args: Parameters<typeof originalUpdate>
        ) {
            if (args[1] === docB) throw new ApiError(500, 'boom');
            return originalUpdate.apply(this, args);
        });

        const email = `grant-midfail-ext-${randomUUID()}@external.example`;
        const { draftId, res } = await sendWithGrant({
            to: email,
            refs: [ref(docA), ref(docB)],
            grant: [docA, docB],
        });
        expect(res.status).toBe(500);
        expect(sent.length).toBe(0);

        // docA's grant persisted (never rolled back); docB's did not.
        expect(await getAcl(docA)).toContainEqual({ id: email, read: true, write: false });

        const draft = await assertJson<EmailDraft>(
            await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/${draftId}`),
        );
        expect(draft.isDraft).toBe(true);
    });

    // 8. suppressShareEmail 'all' stops the email but the in-app share notification still fires.
    test('an in-app share notification is still persisted for a registered recipient', async () => {
        startCapture();
        const docId = await createDoc(`grant-notify-${randomUUID()}`);

        const { res } = await sendWithGrant({ to: ctx.bob.user.email, refs: [ref(docId)], grant: [docId] });
        expect(res.status).toBe(200);

        const list = await assertJson<Notification[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`),
        );
        expect(list.some((n) => n.tag === `share:${ctx.alice.user.id}:${aliceMountId}:${docId}`)).toBe(true);
    });

    // 9. Demo mode short-circuits before grants: 403 and the ACL is untouched.
    test('demo mode: send with grants is 403 and the ACL is untouched', async () => {
        startCapture();
        const docId = await createDoc(`grant-demo-${randomUUID()}`);
        const before = await getAcl(docId);
        const email = `grant-demo-ext-${randomUUID()}@external.example`;

        process.env['EIGEN_DEMO'] = '1';
        const { res } = await sendWithGrant({ to: email, refs: [ref(docId)], grant: [docId] });
        expect(res.status).toBe(403);
        expect(sent.length).toBe(0);
        expect(await getAcl(docId)).toEqual(before);
    });

    // 10. Without grantAccessRefIds nothing is granted (today's behaviour: refs are just links).
    test('without grantAccessRefIds the ACL is unchanged', async () => {
        startCapture();
        const docId = await createDoc(`grant-absent-${randomUUID()}`);
        const before = await getAcl(docId);
        const email = `grant-absent-ext-${randomUUID()}@external.example`;

        const { res } = await sendWithGrant({ to: email, refs: [ref(docId)] });
        expect(res.status).toBe(200);
        expect(await getAcl(docId)).toEqual(before);
        expect((await getAcl(docId))?.some((a) => a.id === email) ?? false).toBe(false);
    });

    // 11. Duplicated ref ids are deduped: one grant, one propagation — not one per copy.
    test('duplicated grant ref ids produce a single grant and a single propagation', async () => {
        startCapture();
        daclSpy = spyOn(Drive.prototype, 'updateACLDelta');
        const docId = await createDoc(`grant-dupe-${randomUUID()}`);
        const email = `grant-dupe-ext-${randomUUID()}@external.example`;

        const { res } = await sendWithGrant({ to: email, refs: [ref(docId)], grant: [docId, docId, docId] });
        expect(res.status).toBe(200);

        expect((await getAcl(docId))?.filter((a) => a.id === email)).toEqual([{ id: email, read: true, write: false }]);
        expect(daclSpy.mock.calls.filter((c: unknown[]) => c[1] === docId).length).toBe(1);
    });

    // 12. More than MAX_SEND_REFERENCES distinct grant ids is rejected before any side effect.
    test('over the reference cap is rejected with 400 before any grant', async () => {
        startCapture();
        daclSpy = spyOn(Drive.prototype, 'updateACLDelta');
        const docId = await createDoc(`grant-cap-${randomUUID()}`);
        const before = await getAcl(docId);
        const grant = Array.from({ length: 21 }, () => randomUUID());

        const { res } = await sendWithGrant({
            to: `grant-cap-ext-${randomUUID()}@external.example`,
            refs: [ref(docId)],
            grant,
        });
        expect(res.status).toBe(400);
        expect(sent.length).toBe(0);
        expect(daclSpy.mock.calls.length).toBe(0);
        expect(await getAcl(docId)).toEqual(before);
    });
});
