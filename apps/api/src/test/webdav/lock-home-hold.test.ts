import { afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import { LOCK_DEFAULT_TTL_MS } from '../../lib/drive/lock-manager';
import { getHome } from '../../lib/home';
import { DAV_PASSWORD } from '../dav-test-helpers';
import type { TestUser } from '../setup';
import { authedRequest, createTestUser, getTestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

const USER_IDLE_MS = 5 * 60_000;

// A WebDAV-only client, such as Word, sends nothing between its lock refreshes, longer than the Home's
// idle time. An idle close would drop its lock, and anyone could overwrite the file. So a live lock
// holds the Home, and the Home idles only once the last lock is gone.
describe('a WebDAV lock holds its Home', () => {
    beforeAll(async () => {
        await getTestContext();
    });

    afterEach(() => jest.useRealTimers());

    async function lockedFile(
        user: TestUser,
        timeout: string,
        name = 'locked.txt',
    ): Promise<{ url: string; token: string }> {
        const mountId = await getDefaultMountId(user.sessionToken, user.id);
        const url = `/webdav/${user.id}/${mountId}/${name}`;
        expect((await webdavRequest(user.email, 'PUT', url, { body: 'v1' })).status).toBe(201);
        const lock = await webdavRequest(user.email, 'LOCK', url, {
            body: `<?xml version="1.0" encoding="utf-8" ?>
<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>`,
            headers: { 'Content-Type': 'application/xml; charset=utf-8', Timeout: timeout },
        });
        expect(lock.status).toBe(200);
        const token = lock.headers.get('Lock-Token')?.replace(/^</, '').replace(/>$/, '');
        if (!token) throw new Error('LOCK answered no Lock-Token');
        return { url, token };
    }

    test('past the idle time the lock still holds, and after UNLOCK the Home idles', async () => {
        const user = await createTestUser(`dav-lock-hold-${crypto.randomUUID()}@test.eigen.is`, DAV_PASSWORD, 'L');
        const home = await getHome(user.id);
        jest.useFakeTimers();
        const { url, token } = await lockedFile(user, 'Second-3600');

        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(false);
        expect((await webdavRequest(user.email, 'PUT', url, { body: 'intruder' })).status).toBe(423);
        const refresh = await webdavRequest(user.email, 'LOCK', url, {
            headers: { If: `(<${token}>)`, Timeout: 'Second-3600' },
        });
        expect(refresh.status).toBe(200);

        const unlock = await webdavRequest(user.email, 'UNLOCK', url, { headers: { 'Lock-Token': `<${token}>` } });
        expect(unlock.status).toBe(204);
        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(true);
        jest.useRealTimers();
        await home.close();
    });

    // The last request, the LOCK, is long ago when the lock expires, so its release closes the Home at once.
    test('a lock left to expire holds the Home until its expiry, and no longer', async () => {
        const user = await createTestUser(`dav-lock-expire-${crypto.randomUUID()}@test.eigen.is`, DAV_PASSWORD, 'E');
        const home = await getHome(user.id);
        jest.useFakeTimers();
        await lockedFile(user, 'Second-3600');

        jest.advanceTimersByTime(3_600_000 - 1000);
        expect(home.closing).toBe(false);
        jest.advanceTimersByTime(2000);
        jest.advanceTimersByTime(1);
        expect(home.closing).toBe(true);
        jest.useRealTimers();
        await home.close();
    });

    // A lock on a file in a folder that goes away, by a WebDAV DELETE or MOVE or by the trash in the web
    // app, can never be refreshed or unlocked at its URL again. It must not hold the Home.
    type LockedFolder = { folderUrl: string; folderName: string; token: string };

    async function lockedFileInFolder(user: TestUser): Promise<LockedFolder> {
        const mountId = await getDefaultMountId(user.sessionToken, user.id);
        const folderName = `folder-${crypto.randomUUID()}`;
        const folderUrl = `/webdav/${user.id}/${mountId}/${folderName}`;
        expect((await webdavRequest(user.email, 'MKCOL', folderUrl)).status).toBe(201);
        const { token } = await lockedFile(user, 'Second-3600', `${folderName}/locked.txt`);
        return { folderUrl, folderName, token };
    }

    // The folder goes only with the token of the lock inside it.
    const removals: [string, (user: TestUser, folder: LockedFolder) => Promise<void>][] = [
        [
            'a WebDAV DELETE of the folder',
            async (user, { folderUrl, token }) => {
                const removed = await webdavRequest(user.email, 'DELETE', folderUrl, {
                    headers: { If: `(<${token}>)` },
                });
                expect(removed.status).toBe(204);
            },
        ],
        [
            'a WebDAV MOVE of the folder',
            async (user, { folderUrl, token }) => {
                const moved = await webdavRequest(user.email, 'MOVE', folderUrl, {
                    headers: { Destination: `${folderUrl}-moved`, If: `(<${token}>)` },
                });
                expect(moved.status).toBe(201);
            },
        ],
        [
            'a trash of the folder in the web app',
            async (user, { folderName }) => {
                const mountId = await getDefaultMountId(user.sessionToken, user.id);
                const folder = await (await getHome(user.id)).drive.resolvePath(mountId, `/${folderName}`);
                if (!folder) throw new Error('folder not found');
                const res = await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/path/${folder.id}`, {
                    method: 'DELETE',
                });
                expect(res.status).toBe(200);
            },
        ],
    ];
    for (const [removal, remove] of removals) {
        test(`${removal} releases the lock on a file inside it, and the Home idles`, async () => {
            const user = await createTestUser(`dav-lock-gone-${crypto.randomUUID()}@test.eigen.is`, DAV_PASSWORD, 'G');
            const home = await getHome(user.id);
            jest.useFakeTimers();
            const folder = await lockedFileInFolder(user);
            await remove(user, folder);

            jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
            expect(home.closing).toBe(true);
            jest.useRealTimers();
            await home.close();
        });
    }

    test('a LOCK on a closing Home is refused with its 503', async () => {
        const user = await createTestUser(`dav-lock-closing-${crypto.randomUUID()}@test.eigen.is`, DAV_PASSWORD, 'C');
        const home = await getHome(user.id);
        const closing = home.close();
        expect(() =>
            home.drive.lockManager.acquire({
                pathId: 'p',
                depth: 0,
                scope: 'exclusive',
                userId: user.id,
                ttlMs: LOCK_DEFAULT_TTL_MS,
                ifHeader: null,
                ancestorPathIds: [],
                descendantPathIds: [],
            }),
        ).toThrow('Home is closing');
        await closing;
    });
});
