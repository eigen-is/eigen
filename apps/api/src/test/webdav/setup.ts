import { app, authedRequest } from '../setup';

export const WEBDAV_PASSWORD = 'testpassword123';

export function basicAuth(email: string, password = WEBDAV_PASSWORD): string {
    return `Basic ${btoa(`${email}:${password}`)}`;
}

export function webdavRequest(
    email: string,
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
    return app.handle(
        new Request(`http://localhost${path}`, {
            method,
            headers: {
                Authorization: basicAuth(email),
                ...options.headers,
            },
            body: options.body,
        }),
    );
}

// /webdav/<ownerId>/ no longer lists mounts (the discovery endpoint was
// removed); fetch via the regular drive API instead.
export async function getDefaultMountId(sessionToken: string, ownerId: string): Promise<string> {
    const res = await authedRequest(sessionToken, `/drive/${ownerId}/mounts`);
    const mounts = (await res.json()) as { id: string }[];
    if (!mounts.length) throw new Error(`No mounts for owner ${ownerId}`);
    return mounts[0].id;
}
