import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_SEND_REFERENCES } from '@workspace/lib/constants/mail';
import { MAILBOX_DRAFTS, MAILBOX_INBOX, MAILBOX_SENT, MAILBOX_TRASH } from '@workspace/lib/constants/mailboxes';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AddressObject, EmailDraft, EmailSummary } from '@workspace/lib/types/mail';
import { mailAttachmentName } from '@workspace/lib/types/mail';
import { getHome } from '../../lib/home';
import { parseMail } from '../../lib/mail/mail-parser';
import { cutDraftReferences } from '../../lib/mail/reference-links';
import { boxDir, mailRootOf, seedMaildirFile } from '../mail-test-helpers';
import type { TestUser } from '../setup';
import {
    assertJson,
    authedRequest,
    createTestUser,
    ensureServer,
    eventually,
    putDraft,
    uploadDraftAttachment,
} from '../setup';

const isWindows = process.platform === 'win32';

const to: AddressObject = { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'Bob <bob@test.eigen.is>' };
const plan: AttachmentReference = {
    type: 'reference',
    ownerId: 'owner-1',
    mountId: 'default',
    id: 'doc-1',
    name: 'Plan.eigendoc',
    driveType: 'doc',
    mimeType: 'application/eigendoc',
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const PILL = '<div><a href="https://eigen.test/doc">Open Plan →</a></div>';
const block = (data: string) => `<!--eigen-refs:${data}-->${PILL}<!--/eigen-refs-->`;

describe.skipIf(isWindows)('Mail — a draft file is the only copy of the draft', () => {
    let user: TestUser;
    let seeds = 0;

    beforeAll(async () => {
        await ensureServer();
        user = await createTestUser(`draft-file-${Date.now()}@test.eigen.is`, 'testpassword123', 'Draft File');
        expect((await authedRequest(user.sessionToken, `/home/${user.id}/size`)).status).toBe(200);
    });

    const read = async (id: string) =>
        assertJson<EmailDraft>(await authedRequest(user.sessionToken, `/mail/${user.id}/message/${id}`));
    const download = async (id: string) =>
        (await authedRequest(user.sessionToken, `/mail/${user.id}/message/${id}/download`)).text();
    const list = async (mailbox: string) =>
        assertJson<EmailSummary[]>(
            await authedRequest(user.sessionToken, `/mail/${user.id}/mailbox/${mailbox}?limit=500`),
        );
    const save = (mail: Partial<EmailDraft>, options = {}) => putDraft(user.sessionToken, user.id, mail, options);

    // As an IMAP client leaves one, or a mail filed into Drafts: an HTML body we did not write.
    async function seedMessage(html: string, mailbox: string = MAILBOX_DRAFTS, flags = 'DS'): Promise<string> {
        const id = `${Date.now()}.seed${seeds++}`;
        const eml = [
            `From: ${user.email}`,
            'To: bob@test.eigen.is',
            `Subject: Seeded ${id}`,
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: <${id}@test>`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=utf-8',
            '',
            html,
        ].join('\r\n');
        seedMaildirFile(user.id, mailbox, id, eml, { flags });
        await eventually(
            async () => ((await list(mailbox)).some((row) => row.id === id) ? true : undefined),
            'the seeded message indexed',
        );
        return id;
    }

    test('a read gives the clean html and the references, and the file shows the pills', async () => {
        const saved = await save({
            subject: 'Round trip',
            to,
            text: 'Body words',
            html: '<p>Body words</p>',
            driveReferences: [plan],
        });
        expect(saved.html).toBe('<p>Body words</p>');
        expect(saved.driveReferences).toEqual([plan]);

        const fetched = await read(saved.id);
        expect(fetched.html).toBe('<p>Body words</p>');
        expect(fetched.driveReferences).toEqual([plan]);
        expect(fetched.text?.trim()).toBe('Body words');

        const file = parseMail(Buffer.from(await download(saved.id)));
        expect(file.html).toContain('<!--eigen-refs:');
        expect(file.html).toContain('Open Plan →');
        expect(file.text?.trim()).toBe('Body words');
    });

    test('saving what a read gave, again and again, leaves one set of pills and the text as it was', async () => {
        const first = await save({
            subject: 'Again',
            to,
            text: 'Words',
            html: '<p>Words</p>',
            driveReferences: [plan],
        });
        for (let i = 0; i < 3; i++) {
            const fetched = await read(first.id);
            await save({
                id: first.id,
                subject: 'Again',
                to,
                text: fetched.text,
                html: fetched.html ?? '',
                driveReferences: fetched.driveReferences,
            });
        }

        const file = parseMail(Buffer.from(await download(first.id)));
        expect(file.html?.match(/Open Plan/g)?.length).toBe(1);
        expect(file.html?.match(/<!--eigen-refs:/g)?.length).toBe(1);
        expect(file.text?.trim()).toBe('Words');
    });

    test('a save after the references were removed leaves no pills and no block', async () => {
        const first = await save({ subject: 'Removed', to, text: 'x', html: '<p>x</p>', driveReferences: [plan] });
        await save({ id: first.id, subject: 'Removed', to, text: 'x', html: '<p>x</p>', driveReferences: [] });

        expect((await read(first.id)).driveReferences).toEqual([]);
        const file = parseMail(Buffer.from(await download(first.id)));
        expect(file.html).not.toContain('eigen-refs');
        expect(file.html).not.toContain('Open Plan');
    });

    test('a draft that is only a link has no text in its read or its row', async () => {
        const saved = await save({ subject: 'Only a link', to, text: '', html: '', driveReferences: [plan] });

        const fetched = await read(saved.id);
        expect(fetched.html).toBe('');
        expect(fetched.text?.trim()).toBe('');
        expect(fetched.driveReferences).toEqual([plan]);
        const row = (await list(MAILBOX_DRAFTS)).find((r) => r.id === saved.id);
        expect(row?.textShort.trim()).toBe('');
    });

    test('a file name that would end a comment or expand in a replace round-trips', async () => {
        const hostile = { ...plan, name: "a--b-->$&$'.eigendoc" };
        const html = '<html><body><p>Words</p></body></html>';
        const saved = await save({ subject: 'Hostile name', to, text: 'Words', html, driveReferences: [hostile] });

        const file = parseMail(Buffer.from(await download(saved.id))).html ?? '';
        const data = file.slice(file.indexOf('<!--eigen-refs:') + 15, file.indexOf('-->'));
        expect(data).not.toContain('--');
        expect(file.endsWith('<!--/eigen-refs--></body></html>')).toBe(true);
        expect(cutDraftReferences(file).html).toBe(html);

        const fetched = await read(saved.id);
        expect(fetched.driveReferences).toEqual([hostile]);
        expect(fetched.html).toBe('<p>Words</p>');
    });

    test('the Bcc and the message it answers survive in the file, and a save without them clears them', async () => {
        const bcc: AddressObject = { value: [{ address: 'hidden@x.com', name: '' }], text: 'hidden@x.com' };
        const saved = await save({
            subject: 'Hidden',
            to,
            bcc,
            text: 'x',
            html: '<p>x</p>',
            repliedToId: 'original-1',
        });
        expect(saved.repliedToId).toBe('original-1');

        const fetched = await read(saved.id);
        expect([fetched.bcc].flat().flatMap((b) => b?.value.map((v) => v.address))).toEqual(['hidden@x.com']);
        expect(fetched.repliedToId).toBe('original-1');

        await save({ id: saved.id, subject: 'Hidden', to, text: 'x', html: '<p>x</p>' });
        const cleared = await read(saved.id);
        expect(cleared.bcc).toBeUndefined();
        expect(cleared.repliedToId).toBeUndefined();
    });

    test('a value in the replied-to header cannot write a header of its own', async () => {
        const saved = await save({
            subject: 'Crafted',
            to,
            text: 'x',
            html: '<p>x</p>',
            repliedToId: 'a\r\nBcc: evil@x.com',
        });
        expect(await download(saved.id)).not.toMatch(/^Bcc:/im);
    });

    test('a rebuilt index lists what the last save wrote', async () => {
        const first = await save({ subject: 'Old subject', to, text: 'v1', html: '<p>v1</p>' });
        const carol: AddressObject = {
            value: [{ address: 'carol@x.com', name: 'Carol' }],
            text: 'Carol <carol@x.com>',
        };
        await save({ id: first.id, subject: 'New subject', to: carol, text: 'v2', html: '<p>v2</p>' });

        const db = new Database(join(mailRootOf(user.id), 'mail.db'));
        db.run('DELETE FROM emails');
        db.close();

        const row = (await list(MAILBOX_DRAFTS)).find((r) => r.id === first.id);
        expect(row?.subject).toBe('New subject');
        expect(row?.toAddress).toBe('carol@x.com');
        expect(row?.textShort.trim()).toBe('v2');
    });

    test('a block a body only quotes does not shadow the real one, which comes last', async () => {
        const other = { ...plan, id: 'doc-quoted' };
        const id = await seedMessage(`<p>quoted</p>${block(encode([other]))}<p>mine</p>${block(encode([plan]))}`);
        expect((await read(id)).driveReferences).toEqual([plan]);
    });

    test('a block at the cap reads', async () => {
        const refs = Array.from({ length: MAX_SEND_REFERENCES }, (_, i) => ({ ...plan, id: `doc-${i}` }));
        const id = await seedMessage(`<p>Words</p>${block(encode(refs))}`);
        const fetched = await read(id);
        expect(fetched.driveReferences).toEqual(refs);
        expect(fetched.html).toBe('<p>Words</p>');
    });

    // Another program writes these, so anything but a whole, valid block leaves the links as plain links.
    describe('a block that does not hold up leaves the html as it is, with no references', () => {
        const overCap = Array.from({ length: MAX_SEND_REFERENCES + 1 }, (_, i) => ({ ...plan, id: `doc-${i}` }));
        const cases: Record<string, string> = {
            'no markers': PILL,
            'not base64 of JSON': block('%%%not-it%%%'),
            'JSON that is not a list': block(encode({ refs: [plan] })),
            'a reference with a field missing': block(encode([{ ...plan, mountId: undefined }])),
            'a reference with a field of the wrong type': block(encode([{ ...plan, ownerId: 7 }])),
            'a reference to an unknown kind': block(encode([{ ...plan, driveType: 'evil' }])),
            'over the cap': block(encode(overCap)),
            'no end marker': `<!--eigen-refs:${encode([plan])}-->${PILL}`,
        };
        for (const [name, tail] of Object.entries(cases)) {
            test(name, async () => {
                const fetched = await read(await seedMessage(`<p>Words</p>${tail}`));
                expect(fetched.driveReferences).toEqual([]);
                expect(fetched.html).toContain('<p>Words</p>');
                expect(fetched.html).toContain('Open Plan');
                expect(fetched.html).not.toContain('eigen-refs');
            });
        }

        test('an unclosed comment reads without a throw', async () => {
            const fetched = await read(await seedMessage(`<p>Words</p><!--eigen-refs:${encode([plan])}`));
            expect(fetched.driveReferences).toEqual([]);
            expect(fetched.html).toContain('<p>Words</p>');
        });
    });

    test('only a draft read takes the block out', async () => {
        const id = await seedMessage(`<p>Words</p>${block(encode([plan]))}`, MAILBOX_INBOX, 'S');
        const fetched = await read(id);
        expect(fetched.driveReferences).toBeUndefined();
        expect(fetched.html).toContain('Open Plan');
        expect(fetched.html).not.toContain('eigen-refs');
    });

    test('a large body with many unmatched markers stays fast', () => {
        const start = '<!--eigen-refs:';
        for (const body of [
            start.repeat(400_000),
            `${start}${'-->'.repeat(2_000_000)}`,
            'x'.repeat(8_000_000) + start,
        ]) {
            const began = performance.now();
            const cut = cutDraftReferences(body);
            expect(performance.now() - began).toBeLessThan(500);
            expect(cut).toEqual({ html: body, driveReferences: [] });
        }
    });

    // An IMAP client that edits a draft saves a new message and removes the old, and the composer still names the old id.
    test('a save naming an id whose row is gone writes the id again beside the client’s draft', async () => {
        const home = await getHome(user.id);
        const old = await home.mail.messageHandleDraft({ subject: 'Open here', to, text: 'old', html: '<p>old</p>' });
        const cur = join(boxDir(user.id, MAILBOX_DRAFTS), 'cur');
        unlinkSync(join(cur, old.filename));
        const client = await seedMessage('<p>the client’s edit</p>');
        await eventually(async () => {
            await home.mail.mailboxGet(MAILBOX_DRAFTS);
            return home.mail.messageGetSummary(old.id) ? undefined : true;
        }, 'the old row gone');

        const saved = await home.mail.messageHandleDraft(
            { id: old.id, subject: 'Open here', to, text: 'typed since', html: '<p>typed since</p>' },
            { keepAttachments: [{ filename: 'none.txt', size: 1 }] },
        );
        expect(saved.id).toBe(old.id);

        expect((await home.mail.messageGet(old.id))?.html).toBe('<p>typed since</p>');
        expect((await home.mail.messageGet(client))?.html).toContain('the client’s edit');
        expect(readdirSync(cur).filter((name) => name.startsWith(`${old.id},`)).length).toBe(1);
    });

    describe('a save naming a message that is not a draft', () => {
        const putRaw = (mail: Partial<EmailDraft>) =>
            authedRequest(user.sessionToken, `/mail/${user.id}/message/draft`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mail }),
            });
        const filesOf = (mailbox: string, id: string) =>
            readdirSync(join(boxDir(user.id, mailbox), 'cur')).filter((name) => name.startsWith(`${id},`));

        test('answers 409 for a sent message, which stays in Sent as it was', async () => {
            const home = await getHome(user.id);
            const fields = { subject: 'Went out', to, text: 'as sent', html: '<p>as sent</p>' };
            const draft = await home.mail.messageHandleDraft(fields);
            await home.mail.messageSend({ ...fields, id: draft.id });
            const before = await download(draft.id);

            const res = await putRaw({ ...fields, id: draft.id, text: 'stale tab', html: '<p>stale tab</p>' });

            expect(res.status).toBe(409);
            expect(home.mail.messageGetSummary(draft.id)?.mailbox).toBe(MAILBOX_SENT);
            expect(filesOf(MAILBOX_SENT, draft.id).length).toBe(1);
            expect(filesOf(MAILBOX_DRAFTS, draft.id)).toEqual([]);
            expect(await download(draft.id)).toBe(before);
        });

        test('answers 409 for a message in the inbox, which stays there', async () => {
            const id = await seedMessage('<p>from someone</p>', MAILBOX_INBOX, 'S');
            const res = await putRaw({ id, subject: 'Not mine', to, text: 'x', html: '<p>x</p>' });

            expect(res.status).toBe(409);
            expect(filesOf(MAILBOX_INBOX, id).length).toBe(1);
            expect((await read(id)).html).toContain('from someone');
        });

        test('a draft moved to Trash still saves, and lands back in Drafts', async () => {
            const home = await getHome(user.id);
            const draft = await save({ subject: 'Trashed', to, text: 'x', html: '<p>x</p>' });
            await home.mail.messageMove(draft.id, MAILBOX_TRASH);

            const res = await putRaw({ id: draft.id, subject: 'Rescued', to, text: 'y', html: '<p>y</p>' });

            expect(res.status).toBe(200);
            expect(home.mail.messageGetSummary(draft.id)?.mailbox).toBe(MAILBOX_DRAFTS);
            expect(filesOf(MAILBOX_TRASH, draft.id)).toEqual([]);
            expect(filesOf(MAILBOX_DRAFTS, draft.id).length).toBe(1);
        });
    });

    // MailComposer marks a message/* part inline by default, and the parser then draws it into the body.
    describe('an attached message stays an attachment', () => {
        const inner = [
            'From: inner@b.c',
            'To: friend@b.c',
            'Bcc: secret@b.c',
            'Subject: The inner message',
            '',
            'The inner words',
            '',
        ].join('\r\n');
        const report = ['Reporting-MTA: dns; mx.b.c', '', 'Final-Recipient: rfc822; secret@b.c', ''].join('\r\n');

        test.each([
            ['message/rfc822', 'kept.eml', inner],
            ['message/delivery-status', 'status.txt', report],
        ])('a %s part survives three saves byte for byte, and the body stays clean', async (type, name, bytes) => {
            const uploaded = await uploadDraftAttachment(user.sessionToken, user.id, new File([bytes], name, { type }));
            const fields = { subject: 'Holds a message', to, text: 'Outer', html: '<p>Outer</p>' };
            const first = await save(fields, { tempAttachmentIds: [uploaded.tempId] });
            expect(first.attachments.map((a) => a.filename)).toEqual([name]);

            await save({ ...fields, id: first.id });
            const third = await save({ ...fields, id: first.id });
            expect(third.attachments.map((a) => a.filename)).toEqual([name]);

            const fetched = await read(first.id);
            expect(fetched.attachments.map((a) => a.contentType)).toEqual([type]);
            expect(fetched.bcc).toBeUndefined();
            expect(fetched.html).toBe('<p>Outer</p>');
            expect(fetched.text?.trim()).toBe('Outer');
            const part = await authedRequest(
                user.sessionToken,
                `/mail/${user.id}/message/${first.id}/attachment/0/${name}`,
            );
            expect(await part.text()).toBe(bytes);
        });
    });

    test('a nameless part in a draft another client wrote survives a save under its chip name', async () => {
        // As an IMAP client APPENDs it: an attachment part that carries no filename.
        const draftId = `${Date.now()}.nameless`;
        const eml = [
            `From: ${user.email}`,
            'To: bob@test.eigen.is',
            'Subject: Nameless part',
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: <${draftId}@test>`,
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="b1"',
            '',
            '--b1',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'body',
            '--b1',
            'Content-Type: application/octet-stream',
            'Content-Disposition: attachment',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from('nameless-bytes').toString('base64'),
            '--b1--',
            '',
        ].join('\r\n');
        seedMaildirFile(user.id, MAILBOX_DRAFTS, draftId, eml, { flags: 'DS' });
        await eventually(
            async () => ((await list(MAILBOX_DRAFTS)).some((row) => row.id === draftId) ? true : undefined),
            'the draft indexed',
        );

        const fetched = await read(draftId);
        expect(fetched.attachments.map((a) => a.filename)).toEqual([undefined]);

        const saved = await save(
            { id: draftId, subject: 'Nameless part', to, text: 'body', html: '<p>body</p>' },
            {
                keepAttachments: fetched.attachments.map((a) => ({
                    filename: mailAttachmentName(a, a.index),
                    size: a.size,
                })),
            },
        );
        expect(saved.attachments.map((a) => a.filename)).toEqual([
            mailAttachmentName(fetched.attachments[0], fetched.attachments[0].index),
        ]);
    });
});
