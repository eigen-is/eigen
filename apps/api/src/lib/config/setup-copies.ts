// A setup that finds accounts in users3.db copies the database before it clears them, into the server's folder beside
// it. The copy may be the only one of real accounts, so nothing deletes it, and ./eigen status lists each one for the
// owner. This module spells a copy's name, which holds the time it was made, reads it back, and lists the copies.

import * as fs from 'node:fs';
import { getServerDataPath } from './paths';

export type SetupCopy = { name: string; createdAt: string };

const SETUP_COPY_NAME = /^users3\.backup-(\d+)\.db$/;

export function buildSetupCopyName(at: Date): string {
    return `users3.backup-${at.getTime()}.db`;
}

// The time in a copy's name, or null for any other name. A time past what a Date holds is null too: toISOString()
// would throw on it, and one odd file would fail the whole status.
export function parseSetupCopyName(name: string): Date | null {
    const ms = SETUP_COPY_NAME.exec(name)?.[1];
    const at = new Date(Number(ms));
    return ms && !Number.isNaN(at.getTime()) ? at : null;
}

// Newest first.
export function listSetupCopies(): SetupCopy[] {
    return fs
        .readdirSync(getServerDataPath())
        .flatMap((name) => {
            const at = parseSetupCopyName(name);
            return at ? [{ name, at }] : [];
        })
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .map(({ name, at }) => ({ name, createdAt: at.toISOString() }));
}
