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

// /webdav/<ownerId>/ no longer lists mounts (the discovery endpoint was
// removed); fetch via the regular drive API instead.
export async function getDefaultMountId(sessionToken: string, ownerId: string): Promise<string> {
    const res = await authedRequest(sessionToken, `/drive/${ownerId}/mounts`);
    const mounts = (await res.json()) as { id: string }[];
    if (!mounts.length) throw new Error(`No mounts for owner ${ownerId}`);
    return mounts[0].id;
}
