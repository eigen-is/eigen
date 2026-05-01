import { requireNonGuest } from '../core/access';
import { ApiError } from '../core/errors';
import { getUserByEmail, type User } from '../user';
import { auth } from './auth';

// HTTP Basic auth shared by CalDAV and WebDAV routers. Browsers/clients send
// `Authorization: Basic base64(email:password)`; we hand the credentials to
// `verifyProtocolAuth` which checks app passwords first, then primary password.
export async function authenticateBasic(request: Request): Promise<User> {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Basic ')) {
        throw new ApiError(401, 'Unauthorized');
    }

    let decoded: string;
    try {
        decoded = atob(authHeader.slice(6));
    } catch {
        throw new ApiError(401, 'Unauthorized');
    }
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
        throw new ApiError(401, 'Unauthorized');
    }

    const email = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);

    return verifyProtocolAuth(email, password);
}

export async function verifyProtocolAuth(email: string, password: string): Promise<User> {
    const user = await getUserByEmail(email);
    if (!user) throw new ApiError(401, 'Unauthorized');
    requireNonGuest(user);

    // 1. Try app password (API key)
    const keyResult = await auth.api.verifyApiKey({ body: { key: password } });
    if (keyResult.valid && keyResult.key?.referenceId === user.id) {
        return user;
    }

    // 2. Fall back to primary password (only works when 2FA is not enabled)
    try {
        await auth.api.signInEmail({ body: { email, password } });
        return user;
    } catch {
        throw new ApiError(401, 'Unauthorized');
    }
}
