import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { materializeMount } from '../../lib/backup/materialize-mount';
import { ApiError } from '../../lib/core';
import { TEST_DATA_DIR } from '../setup';

describe('materializeMount', () => {
    // restoreHome refuses such an archive from its manifest; this is the second lock, at the point of
    // harm: rewriting an s3 mount's rows to fresh keys over bodies the archive never held would read
    // every file as missing at backup.
    test('refuses a mount whose archive holds only its metadata', () => {
        const homeDir = mkdtempSync(join(TEST_DATA_DIR, 'materialize-metadata-'));
        const mountDir = join(homeDir, 'mounts', 'bucket');
        mkdirSync(mountDir, { recursive: true });
        writeFileSync(join(mountDir, 'metadata.db'), '');
        const summary = { id: 'bucket', storageType: 's3' as const, files: 0, bytes: 0, contents: 'metadata' as const };

        let error: unknown;
        try {
            materializeMount(homeDir, summary, '1');
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({
            status: 400,
            message: 'Mount bucket holds only its metadata in the archive, not its files, so it cannot be restored',
        });
        expect(existsSync(join(mountDir, 'staging'))).toBe(false);
    });
});
