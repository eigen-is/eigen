import { describe, expect, test } from 'bun:test';
import type { BackupManifest } from '../../types/backup';
import { incompleteReason } from '../../validation';

const mount = (id: string, storageType: BackupManifest['mounts'][number]['storageType']) => ({
    id,
    storageType,
    files: 1,
    bytes: 1,
});

describe('incompleteReason', () => {
    test('a complete home has none: full-s3, a manifest from before levels, a Full one with no s3 mount', () => {
        const mounts = [mount('drive', 'local-key'), mount('bucket', 's3')];
        expect(incompleteReason({ level: 'full-s3', mounts })).toBeNull();
        expect(incompleteReason({ mounts })).toBeNull();
        expect(
            incompleteReason({ level: 'full', mounts: [mount('drive', 'local'), mount('flat', 'local-key')] }),
        ).toBeNull();
    });

    test('a Light one is refused by its level', () => {
        expect(incompleteReason({ level: 'light', mounts: [mount('drive', 'local')] })).toBe(
            'is a light backup: it holds no files and no mail, so it cannot restore a home on its own',
        );
    });

    test('a metadata-only mount is refused by name', () => {
        const mounts = [
            mount('drive', 'local'),
            { ...mount('bucket', 's3'), contents: 'metadata' as const },
            { ...mount('other', 's3'), contents: 'metadata' as const },
        ];
        expect(incompleteReason({ level: 'full', mounts })).toBe(
            'holds only the metadata of mount bucket, other, not its files, so it cannot restore a home on its own',
        );
    });
});
