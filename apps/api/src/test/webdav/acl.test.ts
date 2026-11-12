import { beforeAll, describe, expect, test } from 'bun:test';
import type { TestContext } from '../setup';
import { getTestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

describe('WebDAV ACL', () => {
    let ctx: TestContext;
    let aliceMount: string;
    let baseHrefAlice: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        aliceMount = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        baseHrefAlice = `/webdav/${ctx.alice.user.id}/${aliceMount}`;
    });

    test("Bob cannot PROPFIND alice's mount root", async () => {
        const res = await webdavRequest(ctx.bob.user.email, 'PROPFIND', `${baseHrefAlice}/`);
        expect(res.status).toBe(403);
    });

    // A path Bob can't read answers as if it didn't exist, so he can't probe for names.
    test("Bob gets the same 404 for a name in alice's mount that exists and one that doesn't", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/probed.txt`, { body: 'x' });
        const propfind = (name: string) =>
            webdavRequest(ctx.bob.user.email, 'PROPFIND', `${baseHrefAlice}/${name}`, { headers: { Depth: '0' } });
        const existing = await propfind('probed.txt');
        const missing = await propfind('never-there.txt');
        expect(existing.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(await existing.text()).toBe(await missing.text());
    });

    test("Bob cannot GET a file in alice's mount", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/secret.txt`, { body: 'shh' });
        const res = await webdavRequest(ctx.bob.user.email, 'GET', `${baseHrefAlice}/secret.txt`);
        expect(res.status).toBe(404);
    });

    // Bob can't see the folder, so it answers as a parent that doesn't exist.
    test("Bob cannot PUT into alice's mount", async () => {
        const res = await webdavRequest(ctx.bob.user.email, 'PUT', `${baseHrefAlice}/intruder.txt`, { body: 'x' });
        expect(res.status).toBe(409);
    });

    test("Bob cannot DELETE in alice's mount", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/keepme.txt`, { body: 'a' });
        const res = await webdavRequest(ctx.bob.user.email, 'DELETE', `${baseHrefAlice}/keepme.txt`);
        expect(res.status).toBe(404);
    });

    test("Bob cannot MOVE alice's file out", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/movable.txt`, { body: 'b' });
        const res = await webdavRequest(ctx.bob.user.email, 'MOVE', `${baseHrefAlice}/movable.txt`, {
            headers: { Destination: `http://localhost${baseHrefAlice}/moved.txt` },
        });
        expect(res.status).toBe(404);
    });

    // A LOCK on a name Bob can't see would create it, so he gets a PUT's answer for a folder he can't see.
    test("Bob cannot LOCK alice's file or a new name in her mount, and gets one answer for both", async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/lockable.txt`, { body: 'c' });
        const lockBody = `<?xml version="1.0" encoding="utf-8"?>
<D:lockinfo xmlns:D="DAV:">
  <D:lockscope><D:exclusive/></D:lockscope>
  <D:locktype><D:write/></D:locktype>
</D:lockinfo>`;
        const lock = async (name: string) => {
            const res = await webdavRequest(ctx.bob.user.email, 'LOCK', `${baseHrefAlice}/${name}`, {
                body: lockBody,
                headers: { 'Content-Type': 'application/xml; charset=utf-8' },
            });
            return `${res.status} ${await res.text()}`;
        };
        const existing = await lock('lockable.txt');
        expect(existing).toStartWith('409 ');
        expect(await lock('lock-intruder.txt')).toBe(existing);
        const put = await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHrefAlice}/lockable.txt`, { body: 'd' });
        expect(put.status).toBe(204);
        expect((await webdavRequest(ctx.alice.user.email, 'GET', `${baseHrefAlice}/lock-intruder.txt`)).status).toBe(
            404,
        );
    });
});
