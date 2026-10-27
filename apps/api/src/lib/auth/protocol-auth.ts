// Sign-in for the protocols that cannot use a browser session. authenticateBasic reads HTTP Basic auth for the DAV
// servers, such as CalDAV and WebDAV, and the mail server's login check reaches verifyProtocolAuth through an
// internal route. The password is an app password or, for an account without 2FA, the account password. Guests
// are refused, and failed attempts are rate limited per email and per IP.

import { ApiError } from '../core/errors';
import type { User } from '../user';
import { getUserByEmail } from '../user';
import { clientIpKey, requireNonGuest } from './access';
import { APP_PASSWORD_LENGTH, auth } from './auth';
import { checkProtocolAuthLimit, clearProtocolAuthFailures, recordProtocolAuthFailure } from './protocol-rate-limit';

// Better Auth logs every missed key lookup at ERROR, so only a value shaped like an app password is looked up.
const APP_PASSWORD_SHAPE = new RegExp(`^[A-Za-z]{${APP_PASSWORD_LENGTH}}$`);

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

    // Caddy sets X-Real-IP on the /dav and /webdav routes, so a client cannot fake it.
    return verifyProtocolAuth(email, password, clientIpKey(request, null));
}

// `ip` is the client's address, not the caller's. The DAV routes read it from Caddy's X-Real-IP. A mail login
// arrives from Dovecot's checkpassword script, which forwards Dovecot's `TCPREMOTEIP`: for an SMTP submission
// login that is the client Postfix reported. Dovecot leaves it unset for its own internal sessions, so `ip` is
// optional and then only the email bucket fills. Where Docker's port publishing hides the source behind the bridge
// gateway, all clients of that port share one bucket.
export async function verifyProtocolAuth(email: string, password: string, ip?: string): Promise<User> {
    const user = await getUserByEmail(email);

    // 1. An app password, checked before the failure limit. It is the credential protocol clients are meant to use,
    // and the only one a 2FA account has, so a bucket filled by a stale client or a flood must not refuse it. Its
    // check is a cheap hash lookup, so only the slow account-password check below is limited.
    if (user) {
        requireNonGuest(user);
        if (APP_PASSWORD_SHAPE.test(password)) {
            const keyResult = await auth.api.verifyApiKey({ body: { key: password } });
            if (keyResult.valid && keyResult.key?.referenceId === user.id) {
                clearProtocolAuthFailures(email);
                return user;
            }
        }
    }

    // Past here every attempt is a guess at the account password, or an unknown email, so the limit applies.
    checkProtocolAuthLimit(email, ip);

    if (!user) {
        recordProtocolAuthFailure(email, ip);
        throw new ApiError(401, 'Unauthorized');
    }

    // 2. A 2FA account never signs in with its account password here. For such an account signInEmail does not
    // throw: it resolves with `{ twoFactorRedirect: true }`, so step 3 would return the user and skip the second
    // factor. These accounts use an app password.
    if (user.twoFactorEnabled) {
        recordProtocolAuthFailure(email, ip);
        throw new ApiError(401, 'Unauthorized');
    }

    // 3. The account password.
    try {
        await auth.api.signInEmail({ body: { email, password } });
    } catch {
        recordProtocolAuthFailure(email, ip);
        throw new ApiError(401, 'Unauthorized');
    }
    clearProtocolAuthFailures(email);
    return user;
}
