import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { assertJson, authedRequest, driveGet, drivePost, getTestContext } from '../setup';

const SANDBOX_CSP = "sandbox; default-src 'none'";
const MOUNT = 'default';
const BOUNDARY = 'served-types';

// A multipart upload whose part carries exactly the Content-Type given, or none, as a hostile client sends it.
function multipart(fileName: string, partType: string | null, content: string): RequestInit {
    const typeLine = partType === null ? '' : `Content-Type: ${partType}\r\n`;
    const body =
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n${typeLine}\r\n` +
        `${content}\r\n--${BOUNDARY}--\r\n`;
    return {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
        body,
    };
}

describe('the types a served file goes out under', () => {
    let token: string;
    let ownerId: string;
    let folderId: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
        const root = await driveGet<DrivePath>(token, ownerId, MOUNT, 'root');
        const folder = await drivePost<DrivePath>(token, ownerId, MOUNT, `folder/${root.id}`, {
            folderName: `served-types-${crypto.randomUUID()}`,
        });
        folderId = folder.id;
    });

    async function upload(fileName: string, partType: string | null, content = 'x'): Promise<DrivePath> {
        const res = await authedRequest(
            token,
            `/drive/${ownerId}/${MOUNT}/file/${folderId}`,
            multipart(fileName, partType, content),
        );
        const [uploaded] = await assertJson<DrivePath[]>(res);
        return uploaded;
    }

    const embed = (path: DrivePath, init?: RequestInit) =>
        authedRequest(token, `/drive/${ownerId}/${MOUNT}/file/${path.id}/embed/${path.name}`, init);

    test.each([
        'text/xsl',
        'application/xml',
        'text/xml',
        'application/xhtml+xml',
        'image/svg+xml',
        'text/html',
        'text/markdown',
        'application/json',
        'image/png, text/html',
        'not a type',
    ])('an upload typed %p is served inline under the sandbox', async (partType) => {
        const res = await embed(await upload('payload.bin', partType, '<x/>'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-security-policy')).toBe(SANDBOX_CSP);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    test('an upload with no part type is served inline under the sandbox', async () => {
        const res = await embed(await upload('payload.bin', null));
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(res.headers.get('content-security-policy')).toBe(SANDBOX_CSP);
    });

    test.each(['image/png', 'image/jpeg', 'image/gif', 'application/pdf', 'audio/mpeg', 'video/mp4', 'text/plain'])(
        'an upload typed %p is served inline as it is, without the sandbox',
        async (partType) => {
            const res = await embed(await upload('inert.bin', partType));
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe(partType);
            expect(res.headers.get('content-disposition')).toStartWith('inline; ');
            expect(res.headers.get('content-security-policy')).toBeNull();
            expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        },
    );

    test('a video still serves its byte ranges', async () => {
        const res = await embed(await upload('clip.mp4', 'video/mp4', '0123456789'), {
            headers: { Range: 'bytes=2-5' },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get('content-security-policy')).toBeNull();
        expect(await res.text()).toBe('2345');
    });

    test('a sandboxed type still downloads as an attachment', async () => {
        const path = await upload('page.html', 'text/html', '<p>hi</p>');
        const res = await authedRequest(token, `/drive/${ownerId}/${MOUNT}/file/${path.id}/download`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="page.html"');
        expect(await res.text()).toBe('<p>hi</p>');
    });

    test.each([
        ['image/png, text/html', 'application/octet-stream'],
        ['not a type', 'application/octet-stream'],
        ['image/png text/html', 'application/octet-stream'],
        ['image/', 'application/octet-stream'],
        ['TEXT/XSL', 'text/xsl'],
        ['image/png; name="a,text/html"', 'image/png'],
    ])('an upload typed %p stores %p', async (partType, stored) => {
        expect((await upload('typed.bin', partType)).mimeType).toBe(stored);
    });
});
