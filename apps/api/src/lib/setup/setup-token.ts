import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { SETUP_LINK_PARAM } from '@workspace/lib/constants/setup';
import { getServerDataPath, SERVER_RUNTIME_FILES } from '../config/paths';
import { isSetupRequired } from '../config/server-config';
import { ApiError } from '../core/errors';
import { adminUrl } from '../core/mail-template';

export type SetupLink = { setupUrl: string | null; signInUrl: string };

// Only the hash is stored, so neither data/ nor a snapshot of it holds a working link.
function sha256(token: string): Buffer {
    return Bun.CryptoHasher.hash('sha256', token);
}

export function createSetupToken(): string {
    const token = randomBytes(32).toString('base64url');
    const file = getServerDataPath(SERVER_RUNTIME_FILES.setupToken);
    // Removed first, so the mode applies even over a file restored with looser permissions.
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, sha256(token).toString('hex'), { mode: 0o600 });
    return token;
}

export function verifySetupToken(token: string): boolean {
    let stored: Buffer;
    try {
        stored = Buffer.from(fs.readFileSync(getServerDataPath(SERVER_RUNTIME_FILES.setupToken), 'utf8'), 'hex');
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
    fs.rmSync(getServerDataPath(SERVER_RUNTIME_FILES.setupToken), { force: true });
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
