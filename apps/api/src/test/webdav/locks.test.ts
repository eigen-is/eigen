import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { parseXml, xmlChild } from '../../lib/core/xml';
import { getHome } from '../../lib/home';
import type { TestContext } from '../setup';
import { drivePut, getTestContext } from '../setup';
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

    // A LOCK on `url` in `scope` by Alice unless `email` names another user, naming `owner` if given.
    function lockRequest(
        url: string,
        {
            scope = 'exclusive',
            owner,
            timeout,
            email = ctx.alice.user.email,
            headers = {},
        }: {
            scope?: 'exclusive' | 'shared';
            owner?: string;
            timeout?: string;
            email?: string;
            headers?: Record<string, string>;
        } = {},
    ): Promise<Response> {
        const ownerXml = owner ? `<D:owner><D:href>mailto:${owner}@example.com</D:href></D:owner>` : '';
        return webdavRequest(email, 'LOCK', url, {
            body: `<?xml version="1.0" encoding="utf-8" ?>
<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:${scope}/></D:lockscope><D:locktype><D:write/></D:locktype>${ownerXml}</D:lockinfo>`,
            headers: {
                'Content-Type': 'application/xml; charset=utf-8',
                ...(timeout && { Timeout: timeout }),
                ...headers,
            },
        });
    }

    function lockTokenOf(res: Response): string {
        expect(res.status).toBeLessThan(300);
        return (res.headers.get('Lock-Token') ?? '').replace(/^</, '').replace(/>$/, '');
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

    // Office saves a new file by locking its name before the first PUT (RFC 4918 §7.3).
    test('LOCK on a new name creates an empty file it locks → 201, and a PUT with the token writes it', async () => {
        const url = `${baseHref}/lock-new-name.docx`;
        const lock = await lockRequest(url);
        expect(lock.status).toBe(201);
        const token = lockTokenOf(lock);
        expect(token).toMatch(/^urn:uuid:/);
        const get = await webdavRequest(ctx.alice.user.email, 'GET', url);
        expect(`${get.status} ${await get.text()}`).toBe('200 ');
        expect((await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'saved' })).status).toBe(423);
        const put = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
            body: 'saved',
            headers: { If: `(<${token}>)` },
        });
        expect(put.status).toBe(204);
        expect(await (await webdavRequest(ctx.alice.user.email, 'GET', url)).text()).toBe('saved');
    });

    test('LOCK on a new name under a missing folder → 409, and nothing is created', async () => {
        expect((await lockRequest(`${baseHref}/lock-no-such-dir/new.txt`)).status).toBe(409);
        expect((await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/lock-no-such-dir`)).status).toBe(404);
    });

    test('a lock refresh on a missing name → 404, and nothing is created', async () => {
        const url = `${baseHref}/lock-refresh-missing.txt`;
        const res = await webdavRequest(ctx.alice.user.email, 'LOCK', url, { headers: { If: '(<urn:uuid:none>)' } });
        expect(res.status).toBe(404);
        expect((await webdavRequest(ctx.alice.user.email, 'GET', url)).status).toBe(404);
    });

    test('LOCK on a new name in a folder Bob may only read → 403, and nothing is created', async () => {
        const folderHref = `${baseHref}/lock-read-only-for-bob`;
        expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', folderHref)).status).toBe(201);
        const folder = await (await getHome(ctx.alice.user.id)).drive.resolvePath(mountId, '/lock-read-only-for-bob');
        if (!folder) throw new Error('expected the folder');
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${folder.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        expect((await lockRequest(`${folderHref}/bob.txt`, { email: ctx.bob.user.email })).status).toBe(403);
        expect((await webdavRequest(ctx.alice.user.email, 'GET', `${folderHref}/bob.txt`)).status).toBe(404);
    });

    test("a reader's refresh of a lock → 403", async () => {
        const folderHref = `${baseHref}/lock-refresh-reader`;
        expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', folderHref)).status).toBe(201);
        const folder = await (await getHome(ctx.alice.user.id)).drive.resolvePath(mountId, '/lock-refresh-reader');
        if (!folder) throw new Error('expected the folder');
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${folder.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        const { token, url } = await lockFile('lock-refresh-reader/alice.txt');
        const refresh = await webdavRequest(ctx.bob.user.email, 'LOCK', url, { headers: { If: `(<${token}>)` } });
        expect(refresh.status).toBe(403);
    });

    describe('in a folder Alice shares with Bob to write', () => {
        let folderHref: string;

        beforeAll(async () => {
            folderHref = `${baseHref}/lock-shared-with-bob`;
            expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', folderHref)).status).toBe(201);
            const folder = await (await getHome(ctx.alice.user.id)).drive.resolvePath(mountId, '/lock-shared-with-bob');
            if (!folder) throw new Error('expected the folder');
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${folder.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: true }],
            });
        });

        test("Bob with Alice's token can neither lock nor write under her exclusive lock", async () => {
            const url = `${folderHref}/alice-exclusive.txt`;
            await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'alice' });
            const token = lockTokenOf(await lockRequest(url));
            const headers = { If: `(<${token}>)` };
            expect((await lockRequest(url, { email: ctx.bob.user.email, headers })).status).toBe(423);
            const put = await webdavRequest(ctx.bob.user.email, 'PUT', url, { body: 'bob', headers });
            expect(put.status).toBe(423);
            expect(await (await webdavRequest(ctx.alice.user.email, 'GET', url)).text()).toBe('alice');
        });

        // Both find the name missing before either goes on, as two Office clients saving one new name at once can.
        test('of two LOCKs on one new name at once, one creates and locks the file and the other is a 423', async () => {
            const pathStr = '/lock-shared-with-bob/race-new.docx';
            const drive = (await getHome(ctx.alice.user.id)).drive;
            const bothMissing = Promise.withResolvers<void>();
            let missing = 0;
            const resolvePath = drive.resolvePath.bind(drive);
            const spy = spyOn(drive, 'resolvePath').mockImplementation(async (mount: string, path: string) => {
                const found = await resolvePath(mount, path);
                if (path === pathStr && !found && missing < 2) {
                    if (++missing === 2) bothMissing.resolve();
                    await bothMissing.promise;
                }
                return found;
            });
            let answers: { email: string; status: number }[];
            try {
                answers = await Promise.all(
                    [ctx.alice.user.email, ctx.bob.user.email].map(async (email) => ({
                        email,
                        status: (await lockRequest(`${baseHref}${pathStr}`, { email })).status,
                    })),
                );
            } finally {
                bothMissing.resolve();
                spy.mockRestore();
            }

            expect(answers.map((answer) => answer.status).toSorted()).toEqual([201, 423]);
            const folder = await drive.resolvePath(mountId, '/lock-shared-with-bob');
            if (!folder) throw new Error('expected the folder');
            const names = (await drive.getFolderContents(mountId, folder.id)).map((path) => path.name);
            expect(names.filter((name) => name.startsWith('race-new'))).toEqual(['race-new.docx']);
            const file = await drive.resolvePath(mountId, pathStr);
            if (!file) throw new Error('expected the file');
            const winner = answers.find((answer) => answer.status === 201);
            const winnerId = winner?.email === ctx.bob.user.email ? ctx.bob.user.id : ctx.alice.user.id;
            expect(drive.lockManager.listForPath(file.id).map((lock) => lock.userId)).toEqual([winnerId]);
        });

        test('of two shared locks, each holder writes with their own token, and nobody without one', async () => {
            const url = `${folderHref}/both-shared.txt`;
            await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'start' });
            expect((await lockRequest(url, { scope: 'shared' })).status).toBe(200);
            const bobToken = lockTokenOf(await lockRequest(url, { scope: 'shared', email: ctx.bob.user.email }));
            expect((await webdavRequest(ctx.bob.user.email, 'PUT', url, { body: 'bob' })).status).toBe(423);
            const put = await webdavRequest(ctx.bob.user.email, 'PUT', url, {
                body: 'bob',
                headers: { If: `(<${bobToken}>)` },
            });
            expect(put.status).toBe(204);
        });

        test("Alice's own token does not pass Bob's shared lock for an exclusive one, and his lock stays", async () => {
            const url = `${folderHref}/shared-then-exclusive.txt`;
            await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'start' });
            const aliceToken = lockTokenOf(await lockRequest(url, { scope: 'shared' }));
            const bobToken = lockTokenOf(await lockRequest(url, { scope: 'shared', email: ctx.bob.user.email }));
            expect((await lockRequest(url, { headers: { If: `(<${aliceToken}>)` } })).status).toBe(423);
            const put = await webdavRequest(ctx.bob.user.email, 'PUT', url, {
                body: 'bob',
                headers: { If: `(<${bobToken}>)` },
            });
            expect(put.status).toBe(204);
        });

        test("a LOCK on a folder is refused over another user's lock on a file inside it", async () => {
            const inner = `${folderHref}/locked-inside`;
            expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', inner)).status).toBe(201);
            const url = `${inner}/report.docx`;
            await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'alice' });
            const token = lockTokenOf(await lockRequest(url));
            expect((await lockRequest(inner, { email: ctx.bob.user.email })).status).toBe(423);
            expect((await lockRequest(inner, { email: ctx.bob.user.email, headers: { Depth: '0' } })).status).toBe(200);
            const put = await webdavRequest(ctx.alice.user.email, 'PUT', url, {
                body: 'saved',
                headers: { If: `(<${token}>)` },
            });
            expect(put.status).toBe(204);
        });

        test('a refresh by another user with the token, or at another URL, is a 412 and extends nothing', async () => {
            const url = `${folderHref}/refresh-own-only.txt`;
            const otherUrl = `${folderHref}/refresh-other.txt`;
            await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'alice' });
            await webdavRequest(ctx.alice.user.email, 'PUT', otherUrl, { body: 'other' });
            const token = lockTokenOf(await lockRequest(url, { timeout: 'Second-60' }));
            const refresh = (email: string, at: string) =>
                webdavRequest(email, 'LOCK', at, { headers: { If: `(<${token}>)`, Timeout: 'Second-3600' } });
            expect((await refresh(ctx.bob.user.email, url)).status).toBe(412);
            expect((await refresh(ctx.alice.user.email, otherUrl)).status).toBe(412);
            const find = await webdavRequest(ctx.alice.user.email, 'PROPFIND', url, { headers: { Depth: '0' } });
            const seconds = (await find.text()).match(/<D:timeout>Second-(\d+)<\/D:timeout>/)?.[1];
            expect(Number(seconds)).toBeLessThanOrEqual(60);
            expect((await refresh(ctx.alice.user.email, url)).status).toBe(200);
        });

        test('a LOCK on a new name in a folder another user locked is a 423, as a PUT is, and creates nothing', async () => {
            const inner = `${folderHref}/bob-locked-folder`;
            expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', inner)).status).toBe(201);
            lockTokenOf(await lockRequest(inner, { email: ctx.bob.user.email, headers: { Depth: '0' } }));
            const put = await webdavRequest(ctx.alice.user.email, 'PUT', `${inner}/put.docx`, { body: 'x' });
            expect(put.status).toBe(423);
            expect((await lockRequest(`${inner}/new.docx`)).status).toBe(423);
            expect((await webdavRequest(ctx.alice.user.email, 'GET', `${inner}/new.docx`)).status).toBe(404);
        });
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
