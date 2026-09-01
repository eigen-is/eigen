import { clientIpKey, requireNonGuest } from '../core/access';
import { ApiError } from '../core/errors';
import { getUserByEmail, type User } from '../user';
import { auth } from './auth';
import { checkProtocolAuthLimit, clearProtocolAuthFailures, recordProtocolAuthFailure } from './protocol-rate-limit';

// HTTP Basic auth shared by CalDAV, CardDAV, and WebDAV routers. Browsers/clients send
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

    // X-Real-IP is Caddy-set and non-spoofable on the edge /dav + /webdav routes.
    return verifyProtocolAuth(email, password, clientIpKey(request, null));
}

// `ip` is the client's address, not the caller's. The /dav + /webdav routes read Caddy's
// X-Real-IP; the SASL path (postfix → dovecot → eigen-checkpassword → routes/internal.ts) forwards
// dovecot's `IP`, which for a submission login is the SMTP client postfix reported as `rip`. It
// stays optional because dovecot leaves `IP` unset for internal sessions such as doveadm, and then
// only the email bucket fills. Where Docker's port publishing hides the source behind the bridge
// gateway, a whole port shares one bucket. That only gates the primary-password path (a valid app
// password is checked first), which is why the per-IP cap sits as high as 50.
export async function verifyProtocolAuth(email: string, password: string, ip?: string): Promise<User> {
    const user = await getUserByEmail(email);

    // 1. App password (API key) — checked BEFORE the failure limiter. A valid app password is the
    // intended protocol credential (and the only one a 2FA user can use), so it must never be refused
    // because the email's failure bucket is saturated by a stale sibling client or a targeted flood.
    // Verifying it is a cheap SHA-256 lookup; only the expensive scrypt password path below is gated.
    if (user) {
        requireNonGuest(user);
        const keyResult = await auth.api.verifyApiKey({ body: { key: password } });
        if (keyResult.valid && keyResult.key?.referenceId === user.id) {
            clearProtocolAuthFailures(email);
            return user;
        }
    }

    // Everything past here is a guess against the primary password (or an unknown email) — gate it.
    checkProtocolAuthLimit(email, ip);

    if (!user) {
        recordProtocolAuthFailure(email, ip);
        throw new ApiError(401, 'Unauthorized');
    }

    // 2. Hard-gate 2FA users off the primary-password fallback. better-auth's /sign-in/email
    // after-hook RESOLVES with `{ twoFactorRedirect: true }` (HTTP 200, not a throw) for a
    // 2FA-enabled account, so the fallback below would fall through to `return user` and bypass
    // 2FA. App passwords (step 1) are the intended protocol path for these accounts.
    if (user.twoFactorEnabled) {
        recordProtocolAuthFailure(email, ip);
        throw new ApiError(401, 'Unauthorized');
    }

    // 3. Fall back to primary password.
    try {
        await auth.api.signInEmail({ body: { email, password } });
    } catch {
        recordProtocolAuthFailure(email, ip);
        throw new ApiError(401, 'Unauthorized');
    }
    clearProtocolAuthFailures(email);
    return user;
}
