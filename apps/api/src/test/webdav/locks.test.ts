import { beforeAll, describe, expect, test } from 'bun:test';
import { getTestContext, type TestContext } from '../setup';
import { webdavRequest } from './setup';

describe('WebDAV LOCK/UNLOCK', () => {
    let ctx: TestContext;
    let mountId: string;
    let baseHref: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const dRes = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/`);
        const m = (await dRes.text()).match(new RegExp(`/webdav/${ctx.alice.user.id}/([^/<]+)/`));
        if (!m) throw new Error('mount id not found');
        mountId = m[1];
        baseHref = `/webdav/${ctx.alice.user.id}/${mountId}`;
    });

    async function lockFile(name: string, ownerName = 'Alice'): Promise<{ token: string; url: string }> {
        const url = `${baseHref}/${name}`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'lockable' });
        const lockBody = `<?xml version="1.0" encoding="utf-8" ?>
<D:lockinfo xmlns:D="DAV:">
  <D:lockscope><D:exclusive/></D:lockscope>
  <D:locktype><D:write/></D:locktype>
  <D:owner><D:href>mailto:${ownerName}@example.com</D:href></D:owner>
</D:lockinfo>`;
        const lock = await webdavRequest(ctx.alice.user.email, 'LOCK', url, {
            body: lockBody,
            headers: { 'Content-Type': 'application/xml; charset=utf-8', Timeout: 'Second-60' },
        });
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
});
