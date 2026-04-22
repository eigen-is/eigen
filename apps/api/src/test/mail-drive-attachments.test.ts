import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types';
import { assertJson, authedRequest, driveGet, driveUpload, getTestContext } from './setup';

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('Mail — Drive Attachment Integration', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    const mountId = 'default';
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    test('stages a drive file as a draft attachment', async () => {
        const file = new File(['drive-content'], 'from-drive.txt', { type: 'text/plain' });
        const drivePath = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            file,
        );

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/draft/attachment-from-drive`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sourceOwnerId: drivePath.ownerId,
                    sourceMountId: drivePath.mountId,
                    sourcePathId: drivePath.id,
                }),
            },
        );

        const data = await assertJson<{ tempId: string; filename: string; contentType: string; size: number }>(res);
        expect(data.tempId).toBeString();
        expect(data.filename).toBe('from-drive.txt');
        expect(data.contentType).toStartWith('text/plain');
        expect(data.size).toBe('drive-content'.length);
    });

    test('saves a received attachment to Drive', async () => {
        const attachmentContent = Buffer.from('save-me-to-drive').toString('base64');
        const eml = [
            'From: sender@example.com',
            `To: ${ctx.alice.user.email}`,
            'Subject: Has attachment',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="test-boundary"',
            '',
            '--test-boundary',
            'Content-Type: text/plain',
            '',
            'See attached.',
            '--test-boundary',
            'Content-Type: application/octet-stream',
            'Content-Disposition: attachment; filename="test-file.bin"',
            'Content-Transfer-Encoding: base64',
            '',
            attachmentContent,
            '--test-boundary--',
        ].join('\r\n');

        const deliverRes = await ctx.app.handle(
            new Request(`http://localhost/mail/deliver/${ctx.alice.user.email}`, {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(deliverRes.status).toBe(200);

        const inboxRes = await authedRequest(ctx.alice.user.sessionToken, `/mail/${ctx.alice.user.id}/mailbox/inbox`);
        const inbox = await assertJson<Array<{ id: string; subject: string }>>(inboxRes);
        const msg = inbox.find((m) => m.subject === 'Has attachment');
        expect(msg).toBeDefined();

        const saveRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/mail/${ctx.alice.user.id}/message/${msg!.id}/attachments/save-to-drive`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    indexes: [0],
                    targetOwnerId: ctx.alice.user.id,
                    targetMountId: mountId,
                    targetParentId: rootId,
                }),
            },
        );

        expect(saveRes.status).toBe(200);
        const saved = await assertJson<Array<{ name: string }>>(saveRes);
        expect(saved).toBeArray();
        expect(saved.length).toBe(1);
        expect(saved[0].name).toBe('test-file.bin');
    });
});
