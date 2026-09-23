import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { SETUP_LINK_PARAM } from '@workspace/lib/constants/setup';
import { getServerDataPath } from '../config/paths';
import { isSetupRequired } from '../config/server-config';
import { ApiError } from '../core/errors';
import { adminUrl } from '../core/mail-template';

export type SetupLink = { setupUrl: string | null; signInUrl: string };

const TOKEN_FILE = 'setup-token';

// Only the hash is stored, so neither data/ nor a snapshot of it holds a working link.
function sha256(token: string): Buffer {
    return createHash('sha256').update(token).digest();
}

export function createSetupToken(): string {
    const token = randomBytes(32).toString('base64url');
    const file = getServerDataPath(TOKEN_FILE);
    // Removed first, so the mode applies even over a file restored with looser permissions.
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, sha256(token).toString('hex'), { mode: 0o600 });
    return token;
}

export function verifySetupToken(token: string): boolean {
    let stored: Buffer;
    try {
        stored = Buffer.from(fs.readFileSync(getServerDataPath(TOKEN_FILE), 'utf8'), 'hex');
    } catch {
        // A missing file holds no token: ./eigen setup writes a fresh one.
        return false;
    }
    return stored.length === 32 && timingSafeEqual(sha256(token), stored);
}

// Before any S3 call or write: only whoever holds the link ./eigen setup printed may set the server up.
export function requireSetupToken(token: string | undefined): void {
    if (!isSetupRequired()) throw new ApiError(403, 'Setup already completed');
    if (!token || !verifySetupToken(token)) {
        throw new ApiError(
            403,
            'Open the setup link that ./eigen setup printed. Run ./eigen setup again for a fresh one.',
        );
    }
}

export function clearSetupToken(): void {
    fs.rmSync(getServerDataPath(TOKEN_FILE), { force: true });
}

// Each call replaces the previous link, so a rerun of ./eigen setup is how an operator gets a fresh one.
export function createSetupLink(): SetupLink {
    const signInUrl = adminUrl();
    // The slash skips the gateway's /admin redirect.
    return {
        setupUrl: isSetupRequired() ? `${signInUrl}/#${SETUP_LINK_PARAM}=${createSetupToken()}` : null,
        signInUrl,
    };
}
