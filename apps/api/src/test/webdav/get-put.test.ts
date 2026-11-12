import { afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home';
import { DEFAULT_MOUNT_ID } from '../../lib/mount/helpers';
import { DAV_PASSWORD } from '../dav-test-helpers';
import type { TestContext } from '../setup';
import {
    authedRequest,
    capUserDrive,
    createTestUser,
    driveGet,
    drivePut,
    driveUpload,
    getTestContext,
    setMaxUploadSizeMB,
    TEST_PNG_BYTES,
} from '../setup';
import { getDefaultMountId, webdavRequest, whenAllFindMissing } from './setup';

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

    // A URL names one file, so the PUT that loses the create is refused and its client sends it again as an overwrite.
    test('of two PUTs of one new name at once, one creates the file and the other is a 409', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-create-race.txt`;
        const drive = (await getHome(ctx.alice.user.id)).drive;
        const answers = await whenAllFindMissing(
            drive,
            '/put-create-race.txt',
            ['first', 'second'].map((body) => async () => ({
                body,
                status: (await webdavRequest(ctx.alice.user.email, 'PUT', url, { body })).status,
            })),
        );

        expect(answers.map((answer) => answer.status).toSorted()).toEqual([201, 409]);
        const root = await drive.resolvePath(mountId, '/');
        if (!root) throw new Error('expected the root');
        const names = (await drive.getFolderContents(mountId, root.id)).map((path) => path.name);
        expect(names.filter((name) => name.startsWith('put-create-race'))).toEqual(['put-create-race.txt']);
        const winner = answers.find((answer) => answer.status === 201);
        expect(await (await webdavRequest(ctx.alice.user.email, 'GET', url)).text()).toBe(winner?.body ?? '');
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'again' })).status).toBe(204);
    });

    test('PUT of a name an upload would rewrite, such as one with a backslash → 400, and no file', async () => {
        const base = `/webdav/${ctx.alice.user.id}/${mountId}`;
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', `${base}/put-back%5Cslash.txt`)).status).toBe(400);
        expect((await webdavRequest(ctx.alice.user.email, 'GET', `${base}/put-back_slash.txt`)).status).toBe(404);
    });

    test('PUT with mismatched If-Match → 412', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-new.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
            body: 'no',
            headers: { 'If-Match': '"wrong"' },
        });
        expect(res.status).toBe(412);
    });

    test('of two PUTs with one If-Match, the one that writes second is a 412', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-race.txt`;
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'original' })).status).toBe(201);
        const etag = (await webdavRequest(ctx.alice.user.email, 'HEAD', url)).headers.get('ETag') ?? '';
        const drive = (await getHome(ctx.alice.user.id)).drive;
        const file = await drive.resolvePath(mountId, '/put-race.txt');
        if (!file) throw new Error('expected the file');
        const { mount } = await drive.resolveFile(mountId, file.id);

        // Hold the file's lock until both PUTs have passed every check before it and wait on it.
        const hold = Promise.withResolvers<void>();
        const held = mount.withPathLock(file.id, () => hold.promise);
        const bothWaiting = Promise.withResolvers<void>();
        let waiting = 0;
        const withPathLock = mount.withPathLock.bind(mount);
        const lock = spyOn(mount, 'withPathLock').mockImplementation(<T>(pathId: string, fn: () => Promise<T>) => {
            if (pathId === file.id && ++waiting === 2) bothWaiting.resolve();
            return withPathLock(pathId, fn);
        });
        let statuses: number[];
        try {
            const puts = Promise.all(
                ['first', 'second'].map((body) =>
                    webdavRequest(ctx.alice.user.email, 'PUT', url, { body, headers: { 'If-Match': etag } }),
                ),
            );
            await bothWaiting.promise;
            hold.resolve();
            await held;
            statuses = (await puts).map((res) => res.status);
        } finally {
            hold.resolve();
            lock.mockRestore();
        }

        expect(statuses.toSorted()).toEqual([204, 412]);
        const kept = await (await webdavRequest(ctx.alice.user.email, 'GET', url)).text();
        expect(kept).toBe(statuses[0] === 204 ? 'first' : 'second');
    });

    // A PUT without If-Match lands after the first one lets go of the file's lock and before it answers.
    // The first still answers its own etag and Last-Modified, so its next PUT is a 412 and doesn't
    // overwrite the other change. The other change is dated years back, so a Last-Modified read from
    // the row after it shows.
    test("a PUT answers its own write's etag and Last-Modified, not those of a write landing right after it", async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-own-etag.txt`;
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'original' })).status).toBe(201);
        const etag = (await webdavRequest(ctx.alice.user.email, 'HEAD', url)).headers.get('ETag') ?? '';
        const drive = (await getHome(ctx.alice.user.id)).drive;
        const file = await drive.resolvePath(mountId, '/put-own-etag.txt');
        if (!file) throw new Error('expected the file');
        const { mount } = await drive.resolveFile(mountId, file.id);
        const writeFileFromTemp = mount.writeFileFromTemp.bind(mount);
        const write = spyOn(mount, 'writeFileFromTemp').mockImplementationOnce(async (...args) => {
            const written = await writeFileFromTemp(...args);
            expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'theirs' })).status).toBe(204);
            await drive.touchUpdatedAt(mountId, file.id, theirsUpdatedAt);
            return written;
        });
        const theirsUpdatedAt = new Date('2001-02-03T04:05:06Z');
        const startedAt = Math.floor(Date.now() / 1000) * 1000;
        let mine: Response;
        try {
            mine = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
                body: 'mine',
                headers: { 'If-Match': etag },
            });
        } finally {
            write.mockRestore();
        }
        expect(mine.status).toBe(204);
        expect(Date.parse(mine.headers.get('Last-Modified') ?? '')).toBeGreaterThanOrEqual(startedAt);

        const next = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
            body: 'mine again',
            headers: { 'If-Match': mine.headers.get('ETag') ?? '' },
        });
        expect(next.status).toBe(412);
        expect(await (await webdavRequest(ctx.alice.user.email, 'GET', url)).text()).toBe('theirs');
    });

    test('PUT with If-None-Match: * on existing → 412', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-new.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
            body: 'no',
            headers: { 'If-None-Match': '*' },
        });
        expect(res.status).toBe(412);
    });

    test('PUT with an If-Match on a missing file → 412, and no file lands', async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-if-match-missing.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
            body: 'no',
            headers: { 'If-Match': '"deadbeef"' },
        });
        expect(res.status).toBe(412);
        expect((await webdavRequest(ctx.alice.user.email, 'HEAD', url)).status).toBe(404);
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
        const usedMB = (await home.drive.size(mountId)) / (1024 * 1024);
        // Room for 512 KB more, under the 35 MB per-file cap, so only the mount can refuse.
        const restore = await capUserDrive(ctx.alice.user.id, mountId, usedMB + 0.5);
        try {
            const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: chunked(1024 * 1024) });
            expect(res.status).toBe(507);
        } finally {
            await restore();
        }
        expect(await (await webdavRequest(ctx.alice.user.email, 'GET', url)).text()).toBe('kept');
    });

    test("a reader's PUT on a full mount is refused with 403", async () => {
        const dir = `/webdav/${ctx.alice.user.id}/${mountId}/put-reader-dir`;
        const url = `${dir}/over-quota.txt`;
        expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', dir)).status).toBe(201);
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'kept' })).status).toBe(201);
        const home = await getHome(ctx.alice.user.id);
        const folder = await home.drive.resolvePath(mountId, '/put-reader-dir');
        if (!folder) throw new Error('expected the folder');
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${folder.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        const usedMB = (await home.drive.size(mountId)) / (1024 * 1024);
        const restore = await capUserDrive(ctx.alice.user.id, mountId, usedMB + 0.5);
        try {
            const body = 'x'.repeat(1024 * 1024);
            const res = await webdavRequest(ctx.bob.user.email, 'PUT', url, {
                body,
                headers: { 'Content-Length': String(body.length) },
            });
            expect(res.status).toBe(403);
        } finally {
            await restore();
        }
    });

    test("a 0-byte PUT (Finder's name reservation) lands even in a mount past its cap", async () => {
        const url = `/webdav/${ctx.alice.user.id}/${mountId}/put-empty-over-quota.txt`;
        const filler = `/webdav/${ctx.alice.user.id}/${mountId}/put-empty-filler.txt`;
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', filler, { body: 'filler' })).status).toBe(201);
        const home = await getHome(ctx.alice.user.id);
        const usedMB = (await home.drive.size(mountId)) / (1024 * 1024);
        const restore = await capUserDrive(ctx.alice.user.id, mountId, usedMB / 2);
        try {
            const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
                body: '',
                headers: { 'Content-Length': '0' },
            });
            expect(res.status).toBe(201);
        } finally {
            await restore();
        }
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

// A PUT over a slow link can outlast the Home's idle timeout. The request holds the Home, so its databases stay
// open until the write lands, and the idle runs again once it is done.
describe('WebDAV PUT holds its Home', () => {
    const USER_IDLE_MS = 5 * 60_000;

    beforeAll(() => getTestContext());
    afterEach(() => jest.useRealTimers());

    test('a PUT whose body arrives after the idle timeout lands, and the Home idles after it', async () => {
        const user = await createTestUser(`dav-hold-${crypto.randomUUID()}@test.eigen.is`, DAV_PASSWORD, 'Holder');
        const home = await getHome(user.id);
        // The rest of the body arrives only once the write waits for it, which is when the clock jumps.
        const writeStarted = Promise.withResolvers<void>();
        const createFile = home.drive.createNamedFile.bind(home.drive);
        const gatedWrite = spyOn(home.drive, 'createNamedFile').mockImplementation((...args) => {
            writeStarted.resolve();
            return createFile(...args);
        });
        let closingMidBody: boolean | undefined;
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (sent++ === 0) {
                    controller.enqueue(new TextEncoder().encode('first half, '));
                    return;
                }
                await writeStarted.promise;
                jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
                closingMidBody = home.closing;
                controller.enqueue(new TextEncoder().encode('second half'));
                controller.close();
            },
        });
        jest.useFakeTimers();
        // A request re-arms the idle on the fake clock, so only the PUT's hold can keep the Home past it.
        home.touch();

        let res: Response;
        try {
            res = await webdavRequest(user.email, 'PUT', `/webdav/${user.id}/${DEFAULT_MOUNT_ID}/slow.txt`, { body });
        } finally {
            gatedWrite.mockRestore();
        }
        expect(res.status).toBe(201);
        expect(closingMidBody).toBe(false);
        expect(home.closing).toBe(false);

        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(true);
        jest.useRealTimers();
        await home.close();
    });
});

// A plain Drive upload streams its body in too, so it holds the Home the same way.
describe('Drive upload holds its Home', () => {
    const USER_IDLE_MS = 5 * 60_000;

    beforeAll(() => getTestContext());
    afterEach(() => jest.useRealTimers());

    test('an upload whose body arrives after the idle timeout lands, and the Home idles after it', async () => {
        const user = await createTestUser(`up-hold-${crypto.randomUUID()}@test.eigen.is`, DAV_PASSWORD, 'Holder');
        const home = await getHome(user.id);
        const root = await driveGet(user.sessionToken, user.id, DEFAULT_MOUNT_ID, 'root');
        const writeStarted = Promise.withResolvers<void>();
        const uploadFiles = home.drive.uploadFiles.bind(home.drive);
        const gatedUpload = spyOn(home.drive, 'uploadFiles').mockImplementation((...args) => {
            writeStarted.resolve();
            return uploadFiles(...args);
        });
        const boundary = 'hold-boundary';
        const encoder = new TextEncoder();
        let closingMidBody: boolean | undefined;
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (sent++ === 0) {
                    controller.enqueue(
                        encoder.encode(
                            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\nContent-Type: text/plain\r\n\r\nfirst half, `,
                        ),
                    );
                    return;
                }
                await writeStarted.promise;
                jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
                closingMidBody = home.closing;
                controller.enqueue(encoder.encode(`second half\r\n--${boundary}--\r\n`));
                controller.close();
            },
        });
        jest.useFakeTimers();
        // A request re-arms the idle on the fake clock, so only the upload's hold can keep the Home past it.
        home.touch();

        let res: Response;
        try {
            res = await authedRequest(user.sessionToken, `/drive/${user.id}/${DEFAULT_MOUNT_ID}/file/${root.id}`, {
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                body,
            });
        } finally {
            gatedUpload.mockRestore();
        }
        expect(res.status).toBe(200);
        expect(closingMidBody).toBe(false);
        expect(home.closing).toBe(false);

        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(true);
        jest.useRealTimers();
        await home.close();
    });
});
