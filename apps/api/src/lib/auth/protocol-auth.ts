// Sign-in for the protocols that cannot use a browser session. authenticateBasic reads HTTP Basic auth for the DAV
// servers, such as CalDAV and WebDAV, and the mail server's login check reaches verifyProtocolAuth through an
// internal route. The password is an app password or, for an account without 2FA, the account password. A
// guest's address is refused like an unknown one, and failed attempts are rate limited per email and per IP.

import { ApiError } from '../core/errors';
import type { User } from '../user';
import { getUserByEmail, isGuest } from '../user';
import { clientIpKey } from './access';
import { APP_PASSWORD_LENGTH, auth } from './auth';
import { checkProtocolAuthLimit, clearProtocolAuthFailures, recordProtocolAuthFailure } from './protocol-rate-limit';

// Better Auth logs every missed key lookup at ERROR, so only a value shaped like an app password is looked up.
const APP_PASSWORD_SHAPE = new RegExp(`^[A-Za-z]{${APP_PASSWORD_LENGTH}}$`);

export async function authenticateBasic(request: Request): Promise<User> {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Basic ')) {
        throw new ApiError(401, 'Unauthorized');
    }

    // Clients encode the credentials as UTF-8, so a password with accents survives; atob would read them as Latin-1.
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
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
    const found = await getUserByEmail(email);
    // A guest signs in only with an emailed code, so here a guest's address is refused like an unknown one.
    const user = isGuest(found) ? null : found;

    // 1. An app password, checked before the failure limit. It is the credential protocol clients are meant to use,
    // and the only one a 2FA account has, so a bucket filled by a stale client or a flood must not refuse it. Its
    // check is a cheap hash lookup, so only the slow account-password check below is limited.
    if (user && APP_PASSWORD_SHAPE.test(password)) {
        const keyResult = await auth.api.verifyApiKey({ body: { key: password } });
        if (keyResult.valid && keyResult.key?.referenceId === user.id) {
            clearProtocolAuthFailures(email);
            return user;
        }
    }

    // Past here every attempt is a guess at the account password, so the limit applies.
    checkProtocolAuthLimit(email, ip);

    // 2. The account password. Every refusal gives the same answer and records the same failure.
    const signedIn = await checkAccountPassword(user, password);
    if (signedIn) {
        clearProtocolAuthFailures(email);
        return signedIn;
    }
    recordProtocolAuthFailure(email, ip);
    throw new ApiError(401, 'Unauthorized');
}

// The user when the password matches the hash on their credential account, else null. A protocol client signs in
// on every request or poll, so this creates no session and does not count as a sign-in. A 2FA account never uses
// its account password here, because the protocols have no second factor, and a banned account is refused as the
// browser sign-in refuses it. Every refusal spends one password hash, the cost of a wrong password, so the time to
// answer does not tell an unknown address, a 2FA account or a ban apart.
async function checkAccountPassword(user: User | null, password: string): Promise<User | null> {
    const context = await auth.$context;
    const usable = user && !user.twoFactorEnabled && !isBanned(user);
    const account = usable ? await context.internalAdapter.findCredentialAccount(user.id) : null;
    if (!user || !account?.password) {
        await context.password.hash(password);
        return null;
    }
    return (await context.password.verify({ hash: account.password, password })) ? user : null;
}

// better-auth's rule: a ban whose expiry has passed no longer holds.
function isBanned(user: User): boolean {
    return Boolean(user.banned) && !(user.banExpires && user.banExpires < new Date());
}
