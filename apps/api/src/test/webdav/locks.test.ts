import { beforeAll, describe, expect, test } from 'bun:test';
import { parseXml, xmlChild } from '../../lib/core/xml';
import { getTestContext, type TestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

describe('WebDAV LOCK/UNLOCK', () => {
    let ctx: TestContext;
    let mountId: string;
    let baseHref: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        baseHref = `/webdav/${ctx.alice.user.id}/${mountId}`;
    });

    // A LOCK on `url` in `scope`, naming `owner` if given.
    function lockRequest(
        url: string,
        {
            scope = 'exclusive',
            owner,
            timeout,
        }: { scope?: 'exclusive' | 'shared'; owner?: string; timeout?: string } = {},
    ): Promise<Response> {
        const ownerXml = owner ? `<D:owner><D:href>mailto:${owner}@example.com</D:href></D:owner>` : '';
        return webdavRequest(ctx.alice.user.email, 'LOCK', url, {
            body: `<?xml version="1.0" encoding="utf-8" ?>
<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:${scope}/></D:lockscope><D:locktype><D:write/></D:locktype>${ownerXml}</D:lockinfo>`,
            headers: { 'Content-Type': 'application/xml; charset=utf-8', ...(timeout && { Timeout: timeout }) },
        });
    }

    async function lockFile(name: string, ownerName = 'Alice'): Promise<{ token: string; url: string }> {
        const url = `${baseHref}/${name}`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'lockable' });
        const lock = await lockRequest(url, { owner: ownerName, timeout: 'Second-60' });
        expect(lock.status).toBe(200);
        const token = lock.headers.get('Lock-Token')!.replace(/^</, '').replace(/>$/, '');
        return { token, url };
    }

    test('LOCK returns 200 + activelock body + Lock-Token header', async () => {
        const { token } = await lockFile('lock-basic.txt');
        expect(token).toMatch(/^urn:uuid:/);
    });

    test('PUT without If: <token> on locked file → 423', async () => {
        const { url } = await lockFile('lock-put-blocked.txt');
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'change' });
        expect(res.status).toBe(423);
    });

    test('PUT with matching If: <token> succeeds', async () => {
        const { token, url } = await lockFile('lock-put-allowed.txt');
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
            body: 'change',
            headers: { If: `(<${token}>)` },
        });
        expect(res.status).toBe(204);
    });

    test('LOCK refresh extends expiry', async () => {
        const { token, url } = await lockFile('lock-refresh.txt');
        const refresh = await webdavRequest(ctx.alice.user.email, 'LOCK', url, {
            headers: { If: `(<${token}>)`, Timeout: 'Second-120' },
        });
        expect(refresh.status).toBe(200);
        const body = await refresh.text();
        expect(body).toContain(token);
    });

    test('the owner comes back as the XML the client sent, in the LOCK answer and in lockdiscovery', async () => {
        const url = `${baseHref}/lock-owner-xml.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        const lock = await lockRequest(url, { owner: 'Alice' });
        expect(lock.status).toBe(200);
        const find = await webdavRequest(ctx.alice.user.email, 'PROPFIND', url, { headers: { Depth: '0' } });
        for (const body of [await lock.text(), await find.text()]) {
            expect(body).toMatch(/<D:owner><D:href[^>]*>mailto:Alice@example\.com<\/D:href><\/D:owner>/);
        }
    });

    test('a LOCK body that is not well-formed → 400, and no lock is taken', async () => {
        const url = `${baseHref}/lock-malformed.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'LOCK', url, {
            body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>',
        });
        expect(res.status).toBe(400);
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'y' })).status).toBe(204);
    });

    test('a LOCK whose root is not DAV:lockinfo → 400, and no lock is taken', async () => {
        const url = `${baseHref}/lock-root.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        for (const body of [
            '<lockinfo><lockscope><exclusive/></lockscope><locktype><write/></locktype></lockinfo>',
            '<F:lockinfo xmlns:F="urn:foreign" xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></F:lockinfo>',
        ]) {
            expect((await webdavRequest(ctx.alice.user.email, 'LOCK', url, { body })).status).toBe(400);
        }
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'y' })).status).toBe(204);
    });

    test('a text-only owner comes back as text, character references decoded', async () => {
        const url = `${baseHref}/lock-owner-text.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'LOCK', url, {
            body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>Alice &#65536; &lt;a&gt;</D:owner></D:lockinfo>',
        });
        expect(res.status).toBe(200);
        const prop = parseXml(await res.text());
        const lockdiscovery = prop && xmlChild(prop, 'DAV:', 'lockdiscovery');
        const activelock = lockdiscovery && xmlChild(lockdiscovery, 'DAV:', 'activelock');
        const owner = activelock && xmlChild(activelock, 'DAV:', 'owner');
        expect(owner?.children).toEqual(['Alice \u{10000} <a>']);
    });

    test('a shared lockscope under another prefix for DAV: is shared', async () => {
        const url = `${baseHref}/lock-shared-prefix.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        const body =
            '<x:lockinfo xmlns:x="DAV:"><x:lockscope><x:shared/></x:lockscope><x:locktype><x:write/></x:locktype></x:lockinfo>';
        const first = await webdavRequest(ctx.alice.user.email, 'LOCK', url, { body });
        expect(first.status).toBe(200);
        expect(await first.text()).toContain('<D:lockscope><D:shared/></D:lockscope>');
        expect((await webdavRequest(ctx.alice.user.email, 'LOCK', url, { body })).status).toBe(200);
    });

    // Every child re-declares the long URI it uses, so a body under the cap serializes to an owner many times its size.
    test('an owner that serializes past the body cap → 400, and no lock is taken', async () => {
        const url = `${baseHref}/lock-owner-big.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        const uri = `urn:${'a'.repeat(30_000)}`;
        const body = `<D:lockinfo xmlns:D="DAV:" xmlns:a="${uri}"><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>${'<a:x/>'.repeat(34)}</D:owner></D:lockinfo>`;
        expect(body.length).toBeLessThan(65_536);
        expect((await webdavRequest(ctx.alice.user.email, 'LOCK', url, { body })).status).toBe(400);
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'y' })).status).toBe(204);
    });

    test('UNLOCK with mismatched token → 409', async () => {
        const { url } = await lockFile('lock-unlock-mismatch.txt');
        const res = await webdavRequest(ctx.alice.user.email, 'UNLOCK', url, {
            headers: { 'Lock-Token': '<urn:uuid:nonexistent>' },
        });
        expect(res.status).toBe(409);
    });

    test('PROPFIND on locked resource shows active lock', async () => {
        const { token, url } = await lockFile('lock-propfind.txt');
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', url, {
            headers: { Depth: '0' },
        });
        const body = await res.text();
        expect(body).toContain('<D:lockdiscovery>');
        expect(body).toContain(token);
    });

    test('UNLOCK with matching token → 204', async () => {
        const { token, url } = await lockFile('lock-unlock-ok.txt');
        const res = await webdavRequest(ctx.alice.user.email, 'UNLOCK', url, {
            headers: { 'Lock-Token': `<${token}>` },
        });
        expect(res.status).toBe(204);
    });

    test('DELETE releases the source lock from LockManager', async () => {
        // Dynamic import: get-home transitively loads server-config, whose top-level
        // ensureLoaded() captures EIGEN_DATA_ROOT at import time. Importing it before
        // ../setup runs would freeze the wrong data dir and break setup-complete.
        const { getHome } = await import('../../lib/home/get-home');
        const { token, url } = await lockFile('lock-delete-release.txt');
        const home = await getHome(ctx.alice.user.id);
        const path = await home.drive.resolvePath(mountId, '/lock-delete-release.txt');
        expect(path).not.toBeNull();
        const pathId = path!.id;
        expect(home.drive.lockManager.listForPath(pathId)).toHaveLength(1);
        const del = await webdavRequest(ctx.alice.user.email, 'DELETE', url, {
            headers: { If: `(<${token}>)` },
        });
        expect(del.status).toBe(204);
        expect(home.drive.lockManager.listForPath(pathId)).toHaveLength(0);
    });

    test('LOCK on a missing name → 404, and nothing is created', async () => {
        const url = `${baseHref}/lock-new-name.docx`;
        expect((await lockRequest(url)).status).toBe(404);
        expect((await webdavRequest(ctx.alice.user.email, 'GET', url)).status).toBe(404);
    });

    // 33 requests, each paying a password hash (ROADMAP: DAV auth per request).
    test('a 33rd shared lock on one path → 423', async () => {
        const url = `${baseHref}/lock-shared-cap.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        for (let i = 0; i < 32; i++) expect((await lockRequest(url, { scope: 'shared' })).status).toBe(200);
        expect((await lockRequest(url, { scope: 'shared' })).status).toBe(423);
    }, 10_000);

    test('LOCK body over 64KB → 413', async () => {
        const url = `${baseHref}/lock-big-body.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        expect((await lockRequest(url, { owner: 'a'.repeat(70_000) })).status).toBe(413);
    });

    test('LOCK with absurd Timeout is capped to 24h', async () => {
        const url = `${baseHref}/lock-timeout-cap.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        const res = await lockRequest(url, { owner: 'alice', timeout: 'Second-2147483647' });
        expect(res.status).toBe(200);
        const body = await res.text();
        const match = body.match(/<D:timeout>Second-(\d+)<\/D:timeout>/);
        expect(match).not.toBeNull();
        expect(Number(match![1])).toBeLessThanOrEqual(86_400);
    });
});
