import { spyOn } from 'bun:test';
import type { Drive } from '../../lib/drive/drive';
import { basicAuth, davRequest } from '../dav-test-helpers';
import { authedRequest } from '../setup';

export { basicAuth };

export function webdavRequest(
    email: string,
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
    return davRequest(method, path, { email, headers: options.headers, body: options.body });
}

// Runs the requests so each finds `pathStr` missing before any goes on, as clients creating one new name at once can.
export async function whenAllFindMissing<T>(
    drive: Drive,
    pathStr: string,
    requests: (() => Promise<T>)[],
): Promise<T[]> {
    const allMissing = Promise.withResolvers<void>();
    let missing = 0;
    const resolvePath = drive.resolvePath.bind(drive);
    const spy = spyOn(drive, 'resolvePath').mockImplementation(async (mountId: string, path: string) => {
        const found = await resolvePath(mountId, path);
        if (path === pathStr && !found && missing < requests.length) {
            if (++missing === requests.length) allMissing.resolve();
            await allMissing.promise;
        }
        return found;
    });
    try {
        return await Promise.all(requests.map((request) => request()));
    } finally {
        allMissing.resolve();
        spy.mockRestore();
    }
}

// /webdav/<ownerId>/ lists no mounts, so this fetches them through the regular drive API.
export async function getDefaultMountId(sessionToken: string, ownerId: string): Promise<string> {
    const res = await authedRequest(sessionToken, `/drive/${ownerId}/mounts`);
    const mounts = (await res.json()) as { id: string }[];
    if (!mounts.length) throw new Error(`No mounts for owner ${ownerId}`);
    return mounts[0].id;
}
