import type { DrivePath } from '@workspace/lib/types/drive';
import { authedRequest, type TestUser } from './setup';

// The two whole-file import requests every domain answers, spelled once: the file's own bytes under its
// media type, and the JSON body naming a Drive file the user may read. `domain` is the route's first
// segment ('mail', 'contacts', 'calendar'), and what a domain adds to either — the calendar's target
// calendar — rides in `query` and `extra`.

export const importRaw = (
    user: TestUser,
    domain: string,
    contentType: string,
    body: BodyInit,
    options: { query?: string; headers?: Record<string, string> } = {},
): Promise<Response> =>
    authedRequest(user.sessionToken, `/${domain}/${user.id}/import${options.query ?? ''}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, ...options.headers },
        body,
    });

export const importFromDriveRequest = (
    user: TestUser,
    domain: string,
    source: DrivePath,
    extra: Record<string, string> = {},
): Promise<Response> =>
    authedRequest(user.sessionToken, `/${domain}/${user.id}/import-from-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...extra,
            sourceOwnerId: source.ownerId,
            sourceMountId: source.mountId,
            sourcePathId: source.id,
        }),
    });
