import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home';
import { driveGet, driveUpload, getTestContext, setMaxUploadSizeMB, TEST_PNG_BYTES, type TestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

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

    test('PUT over the max upload size → 413', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-too-big.txt`;
        const body = 'x'.repeat(2 * 1024 * 1024);
        await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
        try {
            const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
                body,
                headers: { 'Content-Length': String(body.length) },
            });
            expect(res.status).toBe(413);
        } finally {
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
        }
    });

    // A ReadableStream body goes out chunked, with no Content-Length, as macOS Finder sends a PUT.
    const chunked = (bytes: number, chunk = 64 * 1024) => {
        let sent = 0;
        return new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent >= bytes) return controller.close();
                const size = Math.min(chunk, bytes - sent);
                sent += size;
                controller.enqueue(new Uint8Array(size).fill(120));
            },
        });
    };

    test('a chunked PUT over the max upload size → 413, and no file lands', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-chunked-too-big.txt`;
        await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
        try {
            const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: chunked(2 * 1024 * 1024) });
            expect(res.status).toBe(413);
        } finally {
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
        }
        expect((await webdavRequest(ctx.alice.user.email, 'HEAD', url)).status).toBe(404);
    });

    test('a chunked PUT past what is left of the mount → 507, and the file keeps its old bytes', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-chunked-over-quota.txt`;
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'kept' })).status).toBe(201);

        const home = await getHome(ctx.alice.user.id);
        const snapshot = { ...home.drive.getMountConfig(mountId) };
        const usedMB = (await home.drive.size(mountId)) / (1024 * 1024);
        // Room for 512 KB more, under the 35 MB per-file cap, so only the mount can refuse.
        await home.drive.updateMount({ ...snapshot, maxSizeMB: usedMB + 0.5 }, true);
        try {
            const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: chunked(1024 * 1024) });
            expect(res.status).toBe(507);
        } finally {
            await home.drive.updateMount(snapshot, true);
        }
        expect(await (await webdavRequest(ctx.alice.user.email, 'GET', url)).text()).toBe('kept');
    });

    test('a chunked PUT within both bounds lands whole', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-chunked-ok.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: chunked(200 * 1024) });
        expect(res.status).toBe(201);
        expect((await webdavRequest(ctx.alice.user.email, 'HEAD', url)).headers.get('Content-Length')).toBe(
            String(200 * 1024),
        );
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

        const real = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: TEST_PNG_BYTES });
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
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: TEST_PNG_BYTES });
        expect(res.status).toBe(204);

        const path = await pollThumbnail(uploaded.id);
        expect(path.thumbnail).toBeTruthy();
        expect(path.details?.width).toBe(4);
        expect(path.details?.height).toBe(4);
    });
});

describe('WebDAV GET security headers', () => {
    let ctx: TestContext;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    // Finding #14: a served upload must carry the same hardening REST serveFile applies, so a
    // scriptable body can't run script with the viewer's session on the API origin.
    test('GET of an uploaded .html carries nosniff and the sandbox CSP', async () => {
        const html = '<html><body><script>alert(1)</script></body></html>';
        const file = new File([html], 'page.html', { type: 'text/html' });
        await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);

        const res = await webdavRequest(
            ctx.alice.user.email,
            'GET',
            `/webdav/${ctx.alice.user.id}/${mountId}/page.html`,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    });

    test('GET of a plain .txt carries nosniff but no CSP', async () => {
        const file = new File(['just text'], 'plain.txt', { type: 'text/plain' });
        await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);

        const res = await webdavRequest(
            ctx.alice.user.email,
            'GET',
            `/webdav/${ctx.alice.user.id}/${mountId}/plain.txt`,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Content-Security-Policy')).toBeNull();
    });

    test('malformed percent-encoding in the URL → 400', async () => {
        const res = await webdavRequest(
            ctx.alice.user.email,
            'GET',
            `/webdav/${ctx.alice.user.id}/${mountId}/bad%E0.txt`,
        );
        expect(res.status).toBe(400);
    });
});
