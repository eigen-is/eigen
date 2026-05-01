import { beforeAll, describe, expect, test } from 'bun:test';
import { driveGet, driveUpload, getTestContext, type TestContext } from '../setup';
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
