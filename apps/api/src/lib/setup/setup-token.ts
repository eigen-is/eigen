import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { getServerDataPath } from '../config/paths';

type SetupTokenFile = { hash: string; createdAt: string };

const TOKEN_FILE = 'setup-token.json';

// Only the hash is stored, so neither data/ nor a snapshot of it holds a working link.
function sha256(token: string): Buffer {
    return createHash('sha256').update(token).digest();
}

export function createSetupToken(): string {
    const token = randomBytes(32).toString('base64url');
    const file = getServerDataPath(TOKEN_FILE);
    // Removed first, so the mode applies even over a file restored with looser permissions.
    fs.rmSync(file, { force: true });
    const content: SetupTokenFile = { hash: sha256(token).toString('hex'), createdAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
    return token;
}

export function verifySetupToken(token: string): boolean {
    const file = getServerDataPath(TOKEN_FILE);
    if (!fs.existsSync(file)) return false;
    const { hash }: SetupTokenFile = JSON.parse(fs.readFileSync(file, 'utf8'));
    return timingSafeEqual(sha256(token), Buffer.from(hash, 'hex'));
}

export function clearSetupToken(): void {
    fs.rmSync(getServerDataPath(TOKEN_FILE), { force: true });
}
