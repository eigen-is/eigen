import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types';
import type { EmailDraft } from '@workspace/lib/types/mail';
import {
    assertJson,
    authedRequest,
    driveGet,
    driveGetList,
    driveUpload,
    getTestContext,
    setMaxUploadSizeMB,
} from '../setup';

const isWindows = process.platform === 'win32';

async function attachFromDrive(
    sessionToken: string,
    ownerId: string,
    body: { sourceOwnerId: string; sourceMountId: string; sourcePathId: string },
): Promise<Response> {
    return authedRequest(sessionToken, `/mail/${ownerId}/message/draft/attachment-from-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function saveAttachmentsToDrive(
    sessionToken: string,
    ownerId: string,
    messageId: string,
    body: { indexes: number[]; targetOwnerId: string; targetMountId: string; targetParentId: string },
): Promise<Response> {
    return authedRequest(sessionToken, `/mail/${ownerId}/message/${messageId}/attachments/save-to-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function deliverEml(ctx: Awaited<ReturnType<typeof getTestContext>>, recipientEmail: string, eml: string) {
    return ctx.app.handle(
        new Request(`http://localhost/mail/deliver/${recipientEmail}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer,
        }),
    );
}

function buildEmlWithAttachment(to: string, subject: string, attachmentContent: string, filename = 'test-file.bin') {
    const base64 = Buffer.from(attachmentContent).toString('base64');
    return [
        'From: sender@example.com',
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="test-boundary"',
        '',
        '--test-boundary',
        'Content-Type: text/plain',
        '',
        'See attached.',
        '--test-boundary',
        'Content-Type: application/octet-stream',
        `Content-Disposition: attachment; filename="${filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64,
        '--test-boundary--',
    ].join('\r\n');
}

function buildEmlWithTwoAttachments(
    to: string,
    subject: string,
    first: { content: string; filename: string },
    second: { content: string; filename: string },
) {
    const part = (att: { content: string; filename: string }) => [
        '--test-boundary',
        'Content-Type: application/octet-stream',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(att.content).toString('base64'),
    ];
    return [
        'From: sender@example.com',
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="test-boundary"',
        '',
        '--test-boundary',
        'Content-Type: text/plain',
        '',
        'See attached.',
        ...part(first),
        ...part(second),
        '--test-boundary--',
    ].join('\r\n');
}

describe.skipIf(isWindows)('Mail — Drive Attachment Integration', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    const mountId = 'default';
    let aliceRootId: string;
    let bobRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        aliceRootId = aliceRoot.id;
        const bobRoot = await driveGet(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, 'root');
        bobRootId = bobRoot.id;
    });

    describe('attach-from-drive', () => {
        test('stages a drive file as a draft attachment', async () => {
            const file = new File(['drive-content'], 'from-drive.txt', { type: 'text/plain' });
            const drivePath = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                aliceRootId,
                file,
            );

            const res = await attachFromDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, {
                sourceOwnerId: drivePath.ownerId,
                sourceMountId: drivePath.mountId,
                sourcePathId: drivePath.id,
            });
            const data = await assertJson<{ tempId: string; filename: string; contentType: string; size: number }>(res);
            expect(data.tempId).toBeString();
            expect(data.filename).toBe('from-drive.txt');
            expect(data.contentType).toStartWith('text/plain');
            expect(data.size).toBe('drive-content'.length);
        });

        test("rejects Alice attaching Bob's private file", async () => {
            const file = new File(['bob-secret'], 'bob-secret.txt', { type: 'text/plain' });
            const bobsFile = await driveUpload<DrivePath>(
                ctx.bob.user.sessionToken,
                ctx.bob.user.id,
                mountId,
                bobRootId,
                file,
            );

            const res = await attachFromDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, {
                sourceOwnerId: bobsFile.ownerId,
                sourceMountId: bobsFile.mountId,
                sourcePathId: bobsFile.id,
            });
            expect([403, 404]).toContain(res.status);
        });

        test('returns 404 for a missing path', async () => {
            const res = await attachFromDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, {
                sourceOwnerId: ctx.alice.user.id,
                sourceMountId: mountId,
                sourcePathId: 'nonexistent-id',
            });
            expect(res.status).toBe(404);
        });

        test('returns 413 when the source file exceeds the mail attachment limit', async () => {
            const content = 'x'.repeat(2 * 1024 * 1024);
            const file = new File([content], 'too-big.txt', { type: 'text/plain' });
            const source = await driveUpload<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                aliceRootId,
                file,
            );

            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
            try {
                const res = await attachFromDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, {
                    sourceOwnerId: source.ownerId,
                    sourceMountId: source.mountId,
                    sourcePathId: source.id,
                });
                expect(res.status).toBe(413);
            } finally {
                await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
            }
        });
    });

    describe('save-attachments-to-drive', () => {
        let messageId: string;

        beforeAll(async () => {
            const eml = buildEmlWithAttachment(ctx.alice.user.email, 'Save-test', 'save-me-to-drive');
            const deliverRes = await deliverEml(ctx, ctx.alice.user.email, eml);
            expect(deliverRes.status).toBe(200);

            const inboxRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/inbox`,
            );
            const inbox = await assertJson<Array<{ id: string; subject: string }>>(inboxRes);
            const msg = inbox.find((m) => m.subject === 'Save-test');
            expect(msg).toBeDefined();
            messageId = msg!.id;
        });

        test('saves a received attachment to the target folder', async () => {
            const res = await saveAttachmentsToDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, messageId, {
                indexes: [0],
                targetOwnerId: ctx.alice.user.id,
                targetMountId: mountId,
                targetParentId: aliceRootId,
            });
            expect(res.status).toBe(200);
            const saved = await assertJson<Array<{ name: string }>>(res);
            expect(saved).toBeArrayOfSize(1);
            expect(saved[0].name).toBe('test-file.bin');
        });

        test("rejects Alice saving to Bob's drive", async () => {
            const res = await saveAttachmentsToDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, messageId, {
                indexes: [0],
                targetOwnerId: ctx.bob.user.id,
                targetMountId: mountId,
                targetParentId: bobRootId,
            });
            expect([403, 404]).toContain(res.status);
        });

        test('rejects an empty indexes array with 400', async () => {
            const res = await saveAttachmentsToDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, messageId, {
                indexes: [],
                targetOwnerId: ctx.alice.user.id,
                targetMountId: mountId,
                targetParentId: aliceRootId,
            });
            expect(res.status).toBe(400);
        });

        test('rejects duplicate indexes with 400', async () => {
            const res = await saveAttachmentsToDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, messageId, {
                indexes: [0, 0],
                targetOwnerId: ctx.alice.user.id,
                targetMountId: mountId,
                targetParentId: aliceRootId,
            });
            expect(res.status).toBe(400);
        });

        test('rejects negative indexes with 400', async () => {
            const res = await saveAttachmentsToDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, messageId, {
                indexes: [-1],
                targetOwnerId: ctx.alice.user.id,
                targetMountId: mountId,
                targetParentId: aliceRootId,
            });
            expect(res.status).toBe(400);
        });

        test('rejects out-of-range indexes with 404', async () => {
            const res = await saveAttachmentsToDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, messageId, {
                indexes: [99],
                targetOwnerId: ctx.alice.user.id,
                targetMountId: mountId,
                targetParentId: aliceRootId,
            });
            expect(res.status).toBe(404);
        });

        test('returns 413 when an attachment exceeds the target drive quota', async () => {
            const bigContent = 'x'.repeat(2 * 1024 * 1024);
            const eml = buildEmlWithAttachment(ctx.alice.user.email, 'Big-attachment', bigContent, 'big.bin');
            const deliverRes = await deliverEml(ctx, ctx.alice.user.email, eml);
            expect(deliverRes.status).toBe(200);

            const inboxRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/inbox`,
            );
            const inbox = await assertJson<Array<{ id: string; subject: string }>>(inboxRes);
            const bigMsg = inbox.find((m) => m.subject === 'Big-attachment');
            expect(bigMsg).toBeDefined();

            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
            try {
                const res = await saveAttachmentsToDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, bigMsg!.id, {
                    indexes: [0],
                    targetOwnerId: ctx.alice.user.id,
                    targetMountId: mountId,
                    targetParentId: aliceRootId,
                });
                expect(res.status).toBe(413);
            } finally {
                await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
            }
        });

        test('rejects a partial-invalid multi-save without persisting the earlier valid attachment', async () => {
            const bigContent = 'x'.repeat(2 * 1024 * 1024);
            const eml = buildEmlWithTwoAttachments(
                ctx.alice.user.email,
                'Partial-save',
                { content: 'first-valid-content', filename: 'first-valid.bin' },
                { content: bigContent, filename: 'second-oversized.bin' },
            );
            const deliverRes = await deliverEml(ctx, ctx.alice.user.email, eml);
            expect(deliverRes.status).toBe(200);

            const inboxRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/mailbox/inbox`,
            );
            const inbox = await assertJson<Array<{ id: string; subject: string }>>(inboxRes);
            const msg = inbox.find((m) => m.subject === 'Partial-save');
            expect(msg).toBeDefined();

            const setQuota = async (mb: number) => {
                const r = await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quotas: { maxUploadSizeMB: mb } }),
                });
                expect(r.status).toBe(200);
            };

            await setQuota(1);
            try {
                const res = await saveAttachmentsToDrive(ctx.alice.user.sessionToken, ctx.alice.user.id, msg!.id, {
                    indexes: [0, 1],
                    targetOwnerId: ctx.alice.user.id,
                    targetMountId: mountId,
                    targetParentId: aliceRootId,
                });
                expect(res.status).toBe(413);
            } finally {
                await setQuota(35);
            }

            // The valid first attachment must NOT have been written before the second failed validation.
            const children = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                'folder',
                aliceRootId,
            );
            expect(children.some((c) => c.name === 'first-valid.bin')).toBe(false);
        });
    });

    describe('drive references on drafts', () => {
        test('saves a draft with driveReferences and hydrates them on reload', async () => {
            const ref = {
                type: 'reference' as const,
                ownerId: ctx.alice.user.id,
                mountId,
                id: 'doc-123',
                name: 'Quarterly Plan.eigendoc',
                driveType: 'doc' as const,
                mimeType: 'application/eigendoc',
            };

            const putRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mail: {
                            subject: 'With ref',
                            to: {
                                value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                                text: 'Bob <bob@test.eigen.is>',
                            },
                            text: 'see attached doc',
                            html: '<p>see attached doc</p>',
                            driveReferences: [ref],
                        },
                    }),
                },
            );
            const saved = await assertJson<EmailDraft>(putRes);
            expect(saved.driveReferences).toBeArrayOfSize(1);
            expect(saved.driveReferences![0].id).toBe('doc-123');

            const getRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${saved.id}`,
            );
            const reloaded = await assertJson<EmailDraft>(getRes);
            expect(reloaded.driveReferences).toBeArrayOfSize(1);
            expect(reloaded.driveReferences![0].id).toBe('doc-123');
            expect(reloaded.driveReferences![0].name).toBe('Quarterly Plan.eigendoc');
        });

        test('sends a draft with driveReferences and bakes them into the Sent copy HTML', async () => {
            const ref = {
                type: 'reference' as const,
                ownerId: ctx.alice.user.id,
                mountId,
                id: 'doc-456',
                name: 'Release Notes.eigendoc',
                driveType: 'doc' as const,
                mimeType: 'application/eigendoc',
            };

            const putRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/draft`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mail: {
                            subject: 'Release',
                            to: {
                                value: [{ address: 'bob@test.eigen.is', name: 'Bob' }],
                                text: 'Bob <bob@test.eigen.is>',
                            },
                            text: 'see ref',
                            html: '<p>see ref</p>',
                            driveReferences: [ref],
                        },
                    }),
                },
            );
            const draft = await assertJson<EmailDraft>(putRes);

            const sendRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/send`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mail: { ...draft, driveReferences: [ref] } }),
                },
            );
            expect(sendRes.status).toBe(200);

            // Grab the Sent-folder message and check its HTML contains a card link pointing at the ref.
            const getRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/mail/${ctx.alice.user.id}/message/${draft.id}`,
            );
            const sent = await assertJson<EmailDraft>(getRes);
            expect(sent.html).toBeTruthy();
            expect(String(sent.html)).toContain('Release Notes');
            expect(String(sent.html)).toContain('doc-456');
        });
    });
});
