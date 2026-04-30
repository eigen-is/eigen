import { beforeAll, describe, expect, test } from 'bun:test';
import { getTestContext, type TestContext } from '../setup';
import { webdavRequest } from './setup';

describe('WebDAV ACL', () => {
    let ctx: TestContext;
    let aliceMount: string;
    let baseHrefAlice: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const dRes = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/`);
        const m = (await dRes.text()).match(new RegExp(`/webdav/${ctx.alice.user.id}/([^/<]+)/`));
        if (!m) throw new Error('mount id not found');
        aliceMount = m[1];
        baseHrefAlice = `/webdav/${ctx.alice.user.id}/${aliceMount}`;
    });

    test("Bob cannot PROPFIND alice's owner discovery", async () => {
        const res = await webdavRequest(ctx.bob.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/`);
        expect(res.status).toBe(403);
    });

    test("Bob cannot PROPFIND alice's mount root", async () => {
        const res = await webdavRequest(ctx.bob.user.email, 'PROPFIND', `${baseHrefAlice}/`);
        expect(res.status).toBe(403);
    });

    test("Bob cannot GET a file in alice's mount", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/secret.txt`, { body: 'shh' });
        const res = await webdavRequest(ctx.bob.user.email, 'GET', `${baseHrefAlice}/secret.txt`);
        expect(res.status).toBe(403);
    });

    test("Bob cannot PUT into alice's mount", async () => {
        const res = await webdavRequest(ctx.bob.user.email, 'PUT', `${baseHrefAlice}/intruder.txt`, { body: 'x' });
        expect(res.status).toBe(403);
    });

    test("Bob cannot DELETE in alice's mount", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/keepme.txt`, { body: 'a' });
        const res = await webdavRequest(ctx.bob.user.email, 'DELETE', `${baseHrefAlice}/keepme.txt`);
        expect(res.status).toBe(403);
    });

    test("Bob cannot MOVE alice's file out", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/movable.txt`, { body: 'b' });
        const res = await webdavRequest(ctx.bob.user.email, 'MOVE', `${baseHrefAlice}/movable.txt`, {
            headers: { Destination: `http://localhost${baseHrefAlice}/moved.txt` },
        });
        expect(res.status).toBe(403);
    });

    test("Bob cannot LOCK alice's file", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/lockable.txt`, { body: 'c' });
        const lockBody = `<?xml version="1.0" encoding="utf-8"?>
<D:lockinfo xmlns:D="DAV:">
  <D:lockscope><D:exclusive/></D:lockscope>
  <D:locktype><D:write/></D:locktype>
</D:lockinfo>`;
        const res = await webdavRequest(ctx.bob.user.email, 'LOCK', `${baseHrefAlice}/lockable.txt`, {
            body: lockBody,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
        expect(res.status).toBe(403);
    });
});
