import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { driveGet, driveUpload, getTestContext, type TestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

// Smallest valid 4×4 PNG — same payload preview.test.ts uses.
const PNG_BYTES = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0, 38, 147, 9, 41,
    0, 0, 0, 9, 112, 72, 89, 115, 0, 0, 3, 232, 0, 0, 3, 232, 1, 181, 123, 82, 107, 0, 0, 0, 17, 73, 68, 65, 84, 120,
    156, 99, 248, 207, 192, 0, 71, 8, 22, 94, 14, 0, 174, 147, 15, 241, 166, 148, 72, 35, 0, 0, 0, 0, 73, 69, 78, 68,
    174, 66, 96, 130,
]);

describe('WebDAV GET/HEAD', () => {
    let ctx: TestContext;
    let mountId: string;
    let testFilePath: string;
    const testFileContent = 'hello webdav\n';
    let testFileEtag: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const file = new File([testFileContent], 'webdav-test.txt', { type: 'text/plain' });
        await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, root.id, file);

        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(testFileContent);
        testFileEtag = `"${hasher.digest('hex')}"`;

        testFilePath = `/webdav/${ctx.alice.user.id}/${mountId}/webdav-test.txt`;
    });

    test('GET returns the bytes with correct ETag', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'GET', testFilePath);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(testFileContent);
        expect(res.headers.get('ETag')).toBe(testFileEtag);
        expect(res.headers.get('Last-Modified')).toMatch(/GMT$/);
        expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    });

    test('HEAD returns the same headers without body', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'HEAD', testFilePath);
        expect(res.status).toBe(200);
        expect(res.headers.get('ETag')).toBe(testFileEtag);
        expect(await res.text()).toBe('');
    });

    test('GET with Range returns 206 + slice', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'GET', testFilePath, {
            headers: { Range: 'bytes=0-4' },
        });
        expect(res.status).toBe(206);
        expect(await res.text()).toBe('hello');
        expect(res.headers.get('Content-Range')).toBe(`bytes 0-4/${testFileContent.length}`);
    });

    test('GET with stale If-None-Match returns 304', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'GET', testFilePath, {
            headers: { 'If-None-Match': testFileEtag },
        });
        expect(res.status).toBe(304);
    });

    test('GET with mismatched If-Match returns 412', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'GET', testFilePath, {
            headers: { 'If-Match': '"deadbeef"' },
        });
        expect(res.status).toBe(412);
    });

    test('GET with conflicting If-Match (fails) and If-None-Match (matches) → 412', async () => {
        // RFC 7232 §6: If-Match is evaluated before If-None-Match.
        // If-Match fails → 412, regardless of what If-None-Match would do.
        const res = await webdavRequest(ctx.alice.user.email, 'GET', testFilePath, {
            headers: { 'If-Match': '"deadbeef"', 'If-None-Match': testFileEtag },
        });
        expect(res.status).toBe(412);
    });

    test('ETag is byte-stable across requests', async () => {
        const a = await webdavRequest(ctx.alice.user.email, 'HEAD', testFilePath);
        const b = await webdavRequest(ctx.alice.user.email, 'HEAD', testFilePath);
        expect(a.headers.get('ETag')).toBe(b.headers.get('ETag'));
    });
});

describe('WebDAV PUT', () => {
    let ctx: TestContext;
    let mountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
    });

    test('PUT creates a new file', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-new.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'created\n' });
        expect(res.status).toBe(201);
        const get = await webdavRequest(ctx.alice.user.email, 'GET', url);
        expect(await get.text()).toBe('created\n');
    });

    test('PUT overwrites an existing file', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-new.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'overwritten\n' });
        expect(res.status).toBe(204);
        const get = await webdavRequest(ctx.alice.user.email, 'GET', url);
        expect(await get.text()).toBe('overwritten\n');
    });

    test('PUT with mismatched If-Match → 412', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-new.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
            body: 'no',
            headers: { 'If-Match': '"wrong"' },
        });
        expect(res.status).toBe(412);
    });

    test('PUT with If-None-Match: * on existing → 412', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-new.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
            body: 'no',
            headers: { 'If-None-Match': '*' },
        });
        expect(res.status).toBe(412);
    });

    test('PUT with no parent → 409', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/no/such/dir/x.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'nope' });
        expect(res.status).toBe(409);
    });

    test('PUT then GET round-trips ETag', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-roundtrip.txt`;
        const putRes = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'roundtrip-data' });
        const putEtag = putRes.headers.get('ETag');
        expect(putEtag).toMatch(/^".+"$/);
        const getRes = await webdavRequest(ctx.alice.user.email, 'HEAD', url);
        expect(getRes.headers.get('ETag')).toBe(putEtag);
    });
});

describe('WebDAV hidden names', () => {
    let ctx: TestContext;
    let baseHref: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        baseHref = `/webdav/${ctx.alice.user.id}/${mountId}`;
    });

    test('PUT a .DS_Store succeeds and PROPFIND hides it', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/.DS_Store`, { body: 'x' });
        const list = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${baseHref}/`, {
            headers: { Depth: '1' },
        });
        expect(await list.text()).not.toContain('.DS_Store');
    });

    test('PUT an Office ~$ lock file succeeds and stays GET-able', async () => {
        const url = `${baseHref}/~$Report.docx`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'lockfile' });
        expect([201, 204]).toContain(res.status);
        const get = await webdavRequest(ctx.alice.user.email, 'GET', url);
        expect(get.status).toBe(200);
        expect(await get.text()).toBe('lockfile');
    });
});

describe('WebDAV PUT thumbnails', () => {
    let ctx: TestContext;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    async function findChild(name: string): Promise<DrivePath> {
        const children = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
        );
        const child = children.find((c) => c.name === name);
        if (!child) throw new Error(`No child '${name}' in root`);
        return child;
    }

    async function pollThumbnail(pathId: string): Promise<DrivePath> {
        let path = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${pathId}`);
        for (let i = 0; i < 40 && !path.thumbnail; i++) {
            await Bun.sleep(50);
            path = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${pathId}`);
        }
        return path;
    }

    test('Finder two-step copy (empty PUT, then real bytes) generates a thumbnail', async () => {
        // Mirrors macOS Finder's WebDAVFS sequence: a 0-byte placeholder PUT
        // creates the resource, then a follow-up PUT writes the real content.
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/finder-two-step.png`;

        const placeholder = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: '' });
        expect(placeholder.status).toBe(201);

        const real = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: PNG_BYTES });
        expect(real.status).toBe(204);

        const child = await findChild('finder-two-step.png');
        const path = await pollThumbnail(child.id);
        expect(path.thumbnail).toBeTruthy();
        expect(path.details?.width).toBe(4);
        expect(path.details?.height).toBe(4);
    });

    test('overwriting an existing image regenerates the thumbnail', async () => {
        // The generic overwrite path (writeFileContent) — not just WebDAV —
        // must regenerate the thumbnail when bytes change.
        const file = new File(['placeholder'], 'overwrite-image.png', { type: 'image/png' });
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
        // Placeholder is non-image bytes labelled image/png — sharp won't
        // produce a thumbnail, so it stays null.
        const before = await driveGet<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `path/${uploaded.id}`,
        );
        expect(before.thumbnail).toBeNull();

        const url = `/webdav/${ctx.alice.user.id}/${mountId}/overwrite-image.png`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: PNG_BYTES });
        expect(res.status).toBe(204);

        const path = await pollThumbnail(uploaded.id);
        expect(path.thumbnail).toBeTruthy();
        expect(path.details?.width).toBe(4);
        expect(path.details?.height).toBe(4);
    });
});
