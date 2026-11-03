import { afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import { getHome } from '../../lib/home';
import { DAV_PASSWORD } from '../dav-test-helpers';
import type { TestUser } from '../setup';
import { createTestUser, getTestContext } from '../setup';
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

    async function lockedFile(user: TestUser, timeout: string): Promise<{ url: string; token: string }> {
        const mountId = await getDefaultMountId(user.sessionToken, user.id);
        const url = `/webdav/${user.id}/${mountId}/locked.txt`;
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

    test('a lock left to expire lets the Home idle after its expiry and the idle time', async () => {
        const user = await createTestUser(`dav-lock-expire-${crypto.randomUUID()}@test.eigen.is`, DAV_PASSWORD, 'E');
        const home = await getHome(user.id);
        jest.useFakeTimers();
        await lockedFile(user, 'Second-3600');

        jest.advanceTimersByTime(3_600_000 - 1000);
        expect(home.closing).toBe(false);
        jest.advanceTimersByTime(1000 + USER_IDLE_MS - 1000);
        expect(home.closing).toBe(false);
        jest.advanceTimersByTime(2000);
        expect(home.closing).toBe(true);
        jest.useRealTimers();
        await home.close();
    });

    test('a LOCK on a closing Home is refused with its 503', async () => {
        const user = await createTestUser(`dav-lock-closing-${crypto.randomUUID()}@test.eigen.is`, DAV_PASSWORD, 'C');
        const home = await getHome(user.id);
        const closing = home.close();
        expect(() =>
            home.drive.lockManager.acquire({ pathId: 'p', depth: 0, scope: 'exclusive', userId: user.id }),
        ).toThrow('Home is closing');
        await closing;
    });
});
