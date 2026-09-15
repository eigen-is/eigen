import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertJson, authedRequest, getTestContext, putDraft, uploadDraftAttachment } from '../setup';

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('Mail — Draft Attachments', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('upload returns tempId, filename, size, contentType', async () => {
        const file = new File(['hello-upload'], 'hello.txt', { type: 'text/plain' });
        const result = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);
        expect(result.tempId).toBeString();
        expect(result.tempId.length).toBeGreaterThan(8);
        expect(result.filename).toBe('hello.txt');
        expect(result.size).toBe('hello-upload'.length);
        expect(result.contentType).toStartWith('text/plain');
    });

    test('upload rejects empty request with 400', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/draft/attachment`,
            {
                method: 'POST',
                body: new FormData(),
            },
        );
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('saving a draft with tempAttachmentIds embeds the attachment into the EML', async () => {
        const file = new File(['pdf-bytes-stub'], 'invoice.pdf', { type: 'application/pdf' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const draft = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'With attachment',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'see attached',
                html: '<p>see attached</p>',
                isDraft: true,
                mailbox: 'Drafts',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );

        expect(draft.mailbox).toBe('Drafts');
        expect(draft.attachments).toBeArray();
        expect(draft.attachments.length).toBe(1);
        const att = draft.attachments[0];
        expect(att.filename).toBe('invoice.pdf');
        expect(att.contentType).toStartWith('application/pdf');
    });

    test('re-saving a draft without tempIds preserves existing attachments', async () => {
        const file = new File(['keep-me'], 'keep.txt', { type: 'text/plain' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Will re-save',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'first',
                html: '<p>first</p>',
                isDraft: true,
                mailbox: 'Drafts',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );
        expect(first.attachments.length).toBe(1);

        const second = await putDraft(ctx.alice.user.sessionToken, ctx.alice.user.id, {
            ...first,
            subject: 'Will re-save',
            text: 'second body',
            html: '<p>second body</p>',
            isDraft: true,
            mailbox: 'Drafts',
        });
        expect(second.id).toBe(first.id);
        expect(second.attachments.length).toBe(1);
        expect(second.attachments[0].filename).toBe('keep.txt');
        expect(second.text?.trim()).toBe('second body');
    });

    test('sending a draft preserves attachments into the Sent mailbox', async () => {
        // In test env (localhost domain, non-production), sendMail() in ../lib/core/mailer
        // short-circuits to a console.log and returns true — no SMTP mock needed.
        const file = new File(['sent-bytes'], 'report.csv', { type: 'text/csv' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const draft = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Please review',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'csv attached',
                html: '<p>csv attached</p>',
                isDraft: true,
                mailbox: 'Drafts',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );
        expect(draft.attachments.length).toBe(1);

        const sendRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mail: draft }),
        });
        expect(sendRes.status).toBe(200);

        const sentList = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/Sent`);
        const sent = await assertJson<Array<{ id: string; hasAttachments: boolean }>>(sentList);
        const found = sent.find((m) => m.id === draft.id);
        expect(found).toBeTruthy();
        expect(found?.hasAttachments).toBe(true);
    });

    test('simulates client: attach → save → edit body → save again keeps attachment', async () => {
        // Reproduces the bug where the client (post-keepAttachmentIndexes fix) lost the attachment
        // on the second save because state.attachments[0].index was never populated from the
        // server response. The fix: server's returned EmailDraft is used to rebuild client state
        // with fresh indexes. This test simulates that flow end-to-end over HTTP.
        const file = new File(['keep-bytes'], 'keep.txt', { type: 'text/plain' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Edit me',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'v1',
                html: '<p>v1</p>',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );
        expect(first.attachments.length).toBe(1);

        // Client would now map server attachments[0] to { index: 0 }. Next save sends [0].
        const second = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: first.id,
                subject: 'Edit me',
                to: first.to,
                text: 'v2 edited',
                html: '<p>v2 edited</p>',
            },
            { keepAttachmentIndexes: [0] },
        );
        expect(second.attachments.length).toBe(1);
        expect(second.attachments[0].filename).toBe('keep.txt');
        expect(second.text?.trim()).toBe('v2 edited');
    });

    test('empty tempAttachmentIds array is equivalent to undefined', async () => {
        const file = new File(['temp-eq'], 'temp-eq.txt', { type: 'text/plain' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const withExplicitEmpty = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Explicit empty',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'v1',
                html: '<p>v1</p>',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );
        expect(withExplicitEmpty.attachments.length).toBe(1);

        const reSaveEmptyArray = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: withExplicitEmpty.id,
                subject: 'Explicit empty',
                to: withExplicitEmpty.to,
                text: 'v2',
                html: '<p>v2</p>',
            },
            { tempAttachmentIds: [] },
        );
        expect(reSaveEmptyArray.attachments.length).toBe(1);

        const reSaveUndefined = await putDraft(ctx.alice.user.sessionToken, ctx.alice.user.id, {
            id: reSaveEmptyArray.id,
            subject: 'Explicit empty',
            to: reSaveEmptyArray.to,
            text: 'v3',
            html: '<p>v3</p>',
        });
        expect(reSaveUndefined.attachments.length).toBe(1);
    });

    test('concurrent uploads on same draft, single save with both tempIds', async () => {
        const [uploadA, uploadB] = await Promise.all([
            uploadDraftAttachment(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                new File(['concurrent-a'], 'concurrent-a.txt', { type: 'text/plain' }),
            ),
            uploadDraftAttachment(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                new File(['concurrent-b'], 'concurrent-b.txt', { type: 'text/plain' }),
            ),
        ]);

        const draft = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Concurrent uploads',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'both',
                html: '<p>both</p>',
            },
            { tempAttachmentIds: [uploadA.tempId, uploadB.tempId] },
        );

        expect(draft.attachments.length).toBe(2);
        const names = draft.attachments.map((a) => a.filename).sort();
        expect(names).toEqual(['concurrent-a.txt', 'concurrent-b.txt']);
    });

    test('file with no explicit MIME type defaults to application/octet-stream', async () => {
        const blob = new Blob(['binary-data']);
        const file = new File([blob], 'unknown.bin');
        const result = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);
        expect(result.contentType).toBe('application/octet-stream');
    });

    test('body-only re-save uses fast path and preserves attachments', async () => {
        const file = new File(['fast-path-bytes'], 'fastpath.txt', { type: 'text/plain' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Fast path test',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'v1',
                html: '<p>v1</p>',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );
        expect(first.attachments.length).toBe(1);

        // Body-only save with all attachments kept — should use fast path
        const second = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: first.id,
                subject: 'Fast path test updated',
                to: first.to,
                text: 'v2',
                html: '<p>v2</p>',
            },
            { keepAttachmentIndexes: [0] },
        );
        expect(second.attachments.length).toBe(1);
        expect(second.attachments[0].filename).toBe('fastpath.txt');
        expect(second.subject).toBe('Fast path test updated');

        // Reading the draft should return the latest content
        const getRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${first.id}`,
        );
        const fetched = await assertJson<{ subject: string; html: string; attachments: unknown[] }>(getRes);
        expect(fetched.html).toContain('v2');
        expect(fetched.attachments.length).toBe(1);
    });

    test("a keep list that is not the sidecar's set takes the full save", async () => {
        const alpha = new File(['alpha-bytes'], 'alpha.txt', { type: 'text/plain' });
        const beta = new File(['beta-bytes'], 'beta.txt', { type: 'text/plain' });
        const upAlpha = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, alpha);
        const upBeta = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, beta);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Stale sidecar',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'v1',
                html: '<p>v1</p>',
            },
            { tempAttachmentIds: [upAlpha.tempId, upBeta.tempId] },
        );
        expect(first.attachments.length).toBe(2);

        // The sidecar lists the parts at 0 and 1. Keeping [1, 2] is as long as that list but is a
        // different set, so it drops alpha and needs the EML rebuilt.
        const second = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            { id: first.id, subject: 'Stale sidecar', to: first.to, text: 'v2', html: '<p>v2</p>' },
            { keepAttachmentIndexes: [1, 2] },
        );
        expect(second.attachments.map((a) => a.filename)).toEqual(['beta.txt']);
    });

    test('a draft carrying an invite still takes the fast path', async () => {
        const invite = new File(['BEGIN:VCALENDAR\r\nEND:VCALENDAR'], 'invite.ics', { type: 'text/calendar' });
        const doc = new File(['agenda-bytes'], 'agenda.txt', { type: 'text/plain' });
        const uploadedInvite = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, invite);
        const uploadedDoc = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, doc);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Invite draft',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'v1',
                html: '<p>v1</p>',
            },
            { tempAttachmentIds: [uploadedInvite.tempId, uploadedDoc.tempId] },
        );
        expect(first.attachments.length).toBe(2);

        // The composer hides the invite, so its keep list names the raw index of the one chip it shows.
        await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            { id: first.id, subject: 'Invite draft updated', to: first.to, text: 'v2', html: '<p>v2</p>' },
            { keepAttachmentIndexes: [1] },
        );

        // A full save would have rebuilt the EML without the calendar part; the fast path leaves it alone.
        const getRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${first.id}`,
        );
        const fetched = await assertJson<{ html: string; attachments: Array<{ contentType: string }> }>(getRes);
        expect(fetched.html).toContain('v2');
        expect(fetched.attachments.map((a) => a.contentType.split(';')[0])).toEqual(['text/calendar', 'text/plain']);
    });

    test('a user-attached invite survives a full save and the send', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const to = { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'Bob <bob@test.eigen.is>' };
        const stage = async (name: string, type: string, body: string) =>
            (await uploadDraftAttachment(token, ownerId, new File([body], name, { type }))).tempId;
        const invite = await stage('meeting.ics', 'text/calendar', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
        const doc = await stage('notes.txt', 'text/plain', 'notes-bytes');

        const first = await putDraft(
            token,
            ownerId,
            { subject: 'Invite ride-along', to, text: 'v1', html: '<p>v1</p>' },
            { tempAttachmentIds: [invite, doc] },
        );
        expect(first.attachments.map((a) => a.filename)).toEqual(['meeting.ics', 'notes.txt']);

        // Body-only save: the composer chips the named part only, so the invite is never in a keep list.
        await putDraft(
            token,
            ownerId,
            { id: first.id, subject: 'Invite ride-along', to: first.to, text: 'v2', html: '<p>v2</p>' },
            { keepAttachmentIndexes: [1] },
        );

        const forceRes = await authedRequest(token, `/mail/${ownerId}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mail: { id: first.id, subject: 'Invite ride-along', to: first.to, text: 'v3', html: '<p>v3</p>' },
                keepAttachmentIndexes: [1],
                forceFullSave: true,
            }),
        });
        const rebuilt = await assertJson<{ attachments: Array<{ filename?: string }> }>(forceRes);
        expect(rebuilt.attachments.map((a) => a.filename)).toEqual(['meeting.ics', 'notes.txt']);

        // The send rebuilds with no keep list at all.
        const sendRes = await authedRequest(token, `/mail/${ownerId}/message/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mail: { id: first.id, subject: 'Invite ride-along', to: first.to, text: 'v3', html: '<p>v3</p>' },
            }),
        });
        expect(sendRes.status).toBe(200);

        const sent = await assertJson<{ attachments: Array<{ filename?: string }> }>(
            await authedRequest(token, `/mail/${ownerId}/message/${first.id}`),
        );
        expect(sent.attachments.map((a) => a.filename)).toEqual(['meeting.ics', 'notes.txt']);
    });

    test('a fast save hands every kept part back with its raw index', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const stage = async (name: string, type: string) =>
            (await uploadDraftAttachment(token, ownerId, new File([`${name}-bytes`], name, { type }))).tempId;
        const doc = await stage('doc.txt', 'text/plain');
        const invite = await stage('invite.ics', 'text/calendar');
        const report = await stage('report.pdf', 'application/pdf');
        const to = { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'Bob <bob@test.eigen.is>' };

        const first = await putDraft(
            token,
            ownerId,
            { subject: 'Index drift', to, text: 'v1', html: '<p>v1</p>' },
            { tempAttachmentIds: [doc, invite, report] },
        );
        expect(first.attachments.map((a) => a.index)).toEqual([0, 1, 2]);

        // Body-only save: the composer's two chips are the named parts at 0 and 2, so the fast path
        // has to hand them back under those numbers rather than under their position in its answer.
        const second = await putDraft(
            token,
            ownerId,
            { id: first.id, subject: 'Index drift', to: first.to, text: 'v2', html: '<p>v2</p>' },
            { keepAttachmentIndexes: [0, 2] },
        );
        expect(second.attachments.map((a) => [a.filename, a.index])).toEqual([
            ['doc.txt', 0],
            ['report.pdf', 2],
        ]);

        // The user removes doc.txt, so the keep list is the surviving chip's own index. The invite,
        // which has no chip to remove, rides the rebuild.
        const third = await putDraft(
            token,
            ownerId,
            { id: first.id, subject: 'Index drift', to: first.to, text: 'v3', html: '<p>v3</p>' },
            { keepAttachmentIndexes: [2] },
        );
        expect(third.attachments.map((a) => a.filename)).toEqual(['invite.ics', 'report.pdf']);

        const fetched = await assertJson<{ attachments: Array<{ filename?: string }> }>(
            await authedRequest(token, `/mail/${ownerId}/message/${first.id}`),
        );
        expect(fetched.attachments.map((a) => a.filename)).toEqual(['invite.ics', 'report.pdf']);
    });

    test('a sidecar whose parts carry no index takes the full save', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const uploaded = await uploadDraftAttachment(
            token,
            ownerId,
            new File(['legacy-bytes'], 'legacy.txt', { type: 'text/plain' }),
        );
        const first = await putDraft(
            token,
            ownerId,
            {
                subject: 'Legacy sidecar',
                to: { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'Bob <bob@test.eigen.is>' },
                text: 'v1',
                html: '<p>v1</p>',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );

        // Rewrite the sidecar in the shape it had before parts carried an index. The store names the
        // file after the sanitized draft id.
        const metaPath = join(
            process.env['EIGEN_DATA_ROOT']!,
            'home',
            ownerId,
            'eigen.mail',
            'draft-meta',
            `${first.id.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`,
        );
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { attachments: Array<{ index?: number }> };
        for (const a of meta.attachments) delete a.index;
        writeFileSync(metaPath, JSON.stringify(meta));

        const second = await putDraft(
            token,
            ownerId,
            { id: first.id, subject: 'Legacy sidecar', to: first.to, text: 'v2', html: '<p>v2</p>' },
            { keepAttachmentIndexes: [0] },
        );
        expect(second.attachments.map((a) => a.filename)).toEqual(['legacy.txt']);
        // A fast save leaves the EML stale, so the new body on disk is what proves the full path ran.
        const raw = await (await authedRequest(token, `/mail/${ownerId}/message/${first.id}/download`)).text();
        expect(raw).toContain('v2');
    });

    test('a sidecar whose parts carry a non-numeric index takes the full save', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const uploaded = await uploadDraftAttachment(
            token,
            ownerId,
            new File(['broken-bytes'], 'broken.txt', { type: 'text/plain' }),
        );
        const first = await putDraft(
            token,
            ownerId,
            {
                subject: 'Broken sidecar',
                to: { value: [{ address: 'bob@test.eigen.is', name: 'Bob' }], text: 'Bob <bob@test.eigen.is>' },
                text: 'v1',
                html: '<p>v1</p>',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );

        // The sidecar is plain JSON on disk, so a hand-edited or truncated one can name a part with
        // anything at all. Nothing but a number can be matched against a keep list.
        const metaPath = join(
            process.env['EIGEN_DATA_ROOT']!,
            'home',
            ownerId,
            'eigen.mail',
            'draft-meta',
            `${first.id.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`,
        );
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { attachments: Array<{ index: number | null }> };
        for (const a of meta.attachments) a.index = null;
        writeFileSync(metaPath, JSON.stringify(meta));

        // No keep list: the fast path would accept the sidecar wholesale and hand the null back.
        const second = await putDraft(token, ownerId, {
            id: first.id,
            subject: 'Broken sidecar',
            to: first.to,
            text: 'v2',
            html: '<p>v2</p>',
        });
        expect(second.attachments.map((a) => [a.filename, a.index])).toEqual([['broken.txt', 0]]);
        const raw = await (await authedRequest(token, `/mail/${ownerId}/message/${first.id}/download`)).text();
        expect(raw).toContain('v2');
    });

    test('send after fast-path saves includes attachments', async () => {
        const file = new File(['send-after-fast'], 'send-after-fast.txt', { type: 'text/plain' });
        const uploaded = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, file);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Send after fast path',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'v1',
                html: '<p>v1</p>',
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );

        // Fast-path save (body-only update)
        await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: first.id,
                subject: 'Send after fast path - updated',
                to: first.to,
                text: 'final body',
                html: '<p>final body</p>',
            },
            { keepAttachmentIndexes: [0] },
        );

        // Send — should compose full EML with latest body + attachment
        const sendRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mail: {
                    id: first.id,
                    subject: 'Send after fast path - updated',
                    text: 'final body',
                    html: '<p>final body</p>',
                    to: first.to,
                },
            }),
        });
        expect(sendRes.status).toBe(200);

        const sentList = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/Sent`);
        const sent = await assertJson<Array<{ id: string; hasAttachments: boolean; subject: string }>>(sentList);
        const found = sent.find((m) => m.id === first.id);
        expect(found).toBeTruthy();
        expect(found?.hasAttachments).toBe(true);
    });

    test('keepAttachmentIndexes drops attachments the user removed', async () => {
        const a = new File(['a-bytes'], 'a.txt', { type: 'text/plain' });
        const b = new File(['b-bytes'], 'b.txt', { type: 'text/plain' });
        const uploadA = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, a);
        const uploadB = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, b);

        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Two attachments',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'both',
                html: '<p>both</p>',
            },
            { tempAttachmentIds: [uploadA.tempId, uploadB.tempId] },
        );
        expect(first.attachments.length).toBe(2);

        // User removes the second attachment in the UI, then auto-save fires with only index 0 kept.
        const second = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: first.id,
                subject: 'Two attachments',
                to: first.to,
                text: 'both',
                html: '<p>both</p>',
            },
            { keepAttachmentIndexes: [0] },
        );
        expect(second.attachments.length).toBe(1);
        expect(second.attachments[0].filename).toBe('a.txt');

        // Removing all attachments (empty keep list) must also be respected.
        const third = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: second.id,
                subject: 'Two attachments',
                to: second.to,
                text: 'none',
                html: '<p>none</p>',
            },
            { keepAttachmentIndexes: [] },
        );
        expect(third.attachments.length).toBe(0);
    });

    test('cleanupStaleDraftTemps removes old files and keeps fresh ones', async () => {
        // Upload two temp files via the API to ensure the temp dir structure exists
        const freshFile = new File(['fresh'], 'fresh.txt', { type: 'text/plain' });
        const freshResult = await uploadDraftAttachment(ctx.alice.user.sessionToken, ctx.alice.user.id, freshFile);
        expect(freshResult.tempId).toBeString();

        // Manually create a stale temp file by writing directly to the temp dir.
        // The temp dir is inside the user's home at <home>/eigen.mail/draft-attachments/.
        const homeDir = join(
            process.env['EIGEN_DATA_ROOT']!,
            'home',
            ctx.alice.user.id,
            'eigen.mail',
            'draft-attachments',
        );
        const staleId = 'stale-temp-id';
        writeFileSync(join(homeDir, staleId), 'old-data');
        writeFileSync(join(homeDir, `${staleId}.json`), JSON.stringify({ filename: 'stale.txt' }));

        // Backdate the stale file's mtime (by renaming trick: not reliable, so use utimes)
        const { utimesSync } = await import('node:fs');
        const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
        utimesSync(join(homeDir, staleId), oldTime, oldTime);
        utimesSync(join(homeDir, `${staleId}.json`), oldTime, oldTime);

        // The file is 48h old, past the 24h stale age.
        const { getHome } = await import('../../lib/home');
        const home = await getHome(ctx.alice.user.id);
        const maildir = home.mail as unknown as {
            store: { cleanupStaleDraftTemps: () => Promise<void> };
        };
        await maildir.store.cleanupStaleDraftTemps();

        // Fresh file should still exist (uploaded moments ago)
        const { existsSync } = await import('node:fs');
        expect(existsSync(join(homeDir, freshResult.tempId))).toBe(true);

        // Stale file should be gone
        expect(existsSync(join(homeDir, staleId))).toBe(false);
        expect(existsSync(join(homeDir, `${staleId}.json`))).toBe(false);
    });

    test('threading headers survive a fast-save then a sidecar-driven full save', async () => {
        const uploaded = await uploadDraftAttachment(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            new File(['thread-bytes'], 'thread.txt', { type: 'text/plain' }),
        );

        // Full save #1: seeds the EML + sidecar with the threading headers and one attachment.
        const first = await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                subject: 'Threaded reply',
                to: {
                    value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                    text: 'Bob <bob@test.eigen.is>',
                },
                text: 'v1',
                html: '<p>v1</p>',
                inReplyTo: '<parent@x.com>',
                references: ['<r1@x.com>'],
            },
            { tempAttachmentIds: [uploaded.tempId] },
        );
        expect(first.attachments.length).toBe(1);

        // Fast save: body-only edit, attachment kept — rewrites the sidecar from the request body.
        await putDraft(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            {
                id: first.id,
                subject: 'Threaded reply',
                to: first.to,
                text: 'v2',
                html: '<p>v2</p>',
                inReplyTo: '<parent@x.com>',
                references: ['<r1@x.com>'],
            },
            { keepAttachmentIndexes: [0] },
        );

        // Staleness-style full save that rebuilds from the sidecar: the request omits the threading
        // headers, so they can only reach the EML if the sidecar preserved them.
        const forceRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/message/draft`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mail: { id: first.id, subject: 'Threaded reply', to: first.to, text: 'v3', html: '<p>v3</p>' },
                keepAttachmentIndexes: [0],
                forceFullSave: true,
            }),
        });
        expect(forceRes.status).toBe(200);

        const rawRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${first.id}/download`,
        );
        const raw = await rawRes.text();
        expect(raw).toMatch(/In-Reply-To:\s*<parent@x\.com>/i);
        expect(raw).toContain('<r1@x.com>');
    });
});
