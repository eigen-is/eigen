import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSetupCopyName, listSetupCopies, parseSetupCopyName } from '../../lib/config/setup-copies';
import { TEST_DATA_DIR } from '../setup';

// The copies in a data root of their own, so no other test's server folder is listed.
function listIn(names: string[]): ReturnType<typeof listSetupCopies> {
    const root = mkdtempSync(join(TEST_DATA_DIR, 'setup-copies-'));
    mkdirSync(join(root, 'server'));
    for (const name of names) writeFileSync(join(root, 'server', name), '');
    const before = process.env['EIGEN_DATA_ROOT'];
    process.env['EIGEN_DATA_ROOT'] = root;
    try {
        return listSetupCopies();
    } finally {
        process.env['EIGEN_DATA_ROOT'] = before;
        rmSync(root, { recursive: true, force: true });
    }
}

describe('the copies of users3.db a setup keeps', () => {
    test('a name reads back the time it was made with, and another name reads as none', () => {
        const at = new Date('2026-10-28T10:11:12.345Z');
        expect(parseSetupCopyName(buildSetupCopyName(at))).toEqual(at);
        for (const name of ['users3.db', 'users3.backup-.db', 'users3.backup-12.db-wal', 'eigen.backup-12.db']) {
            expect(parseSetupCopyName(name)).toBeNull();
        }
    });

    test('they list newest first', () => {
        const [first, second, third] = [1, 2, 3].map((hour) => new Date(Date.UTC(2026, 9, 28, hour)));
        const names = [second, third, first].map((at) => buildSetupCopyName(at));
        expect(listIn([...names, 'users3.db'])).toEqual(
            [third, second, first].map((at) => ({ name: buildSetupCopyName(at), createdAt: at.toISOString() })),
        );
    });

    test('a name whose time no date can hold is skipped, so it cannot fail ./eigen status', () => {
        const at = new Date('2026-10-28T10:00:00Z');
        const odd = 'users3.backup-99999999999999999.db';
        expect(parseSetupCopyName(odd)).toBeNull();
        expect(listIn([odd, buildSetupCopyName(at)])).toEqual([
            { name: buildSetupCopyName(at), createdAt: at.toISOString() },
        ]);
    });
});
