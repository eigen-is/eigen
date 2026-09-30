import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { buildServerFolderName } from '../../lib/backup/paths';
import { snapshotServer } from '../../lib/backup/snapshot-server';
import { verifyFolder } from '../../lib/backup/verify';
import {
    getAvatarsDir,
    getOrgDataPath,
    getServerDataPath,
    SERVER_DATABASES,
    SERVER_FILES,
    SERVER_RUNTIME_FILES,
} from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { listWaitlist } from '../../lib/waitlist/waitlist';
import { getTestContext, TEST_DATA_DIR } from '../setup';

// What setup leaves in data/server/ beside the allowlist, and an older server's auth database.
const STRAY_FILES = ['users3.backup-20260101-000000.db', 'auth.db'];
const ORG_PROBE = 'org-probe.txt';
const AVATAR_PROBE = 'snapshot-server-probe.webp';

describe('Backup snapshotServer', () => {
    const at = new Date('2026-09-30T02:03:04Z');
    let folder: string;
    let manifest: BackupManifest;
    let orgId: string;

    beforeAll(async () => {
        await getTestContext();
        orgId = getServerConfig()!.orgId;
        // Opens waitlist.db, so all three databases are on disk.
        await listWaitlist();
        for (const name of STRAY_FILES) writeFileSync(getServerDataPath(name), 'stray');
        mkdirSync(getOrgDataPath(orgId), { recursive: true });
        writeFileSync(join(getOrgDataPath(orgId), ORG_PROBE), 'org file');
        writeFileSync(join(getAvatarsDir(), AVATAR_PROBE), 'avatar');

        const target = mkdtempSync(join(TEST_DATA_DIR, 'server-snapshot-'));
        manifest = await snapshotServer(target, at);
        folder = join(target, buildServerFolderName(at));
    });

    afterAll(() => {
        for (const name of STRAY_FILES) rmSync(getServerDataPath(name), { force: true });
        rmSync(join(getOrgDataPath(orgId), ORG_PROBE), { force: true });
        rmSync(join(getAvatarsDir(), AVATAR_PROBE), { force: true });
    });

    test('writes a server manifest into server-{stamp}/', () => {
        expect(folder.endsWith('server-20260930-020304')).toBe(true);
        expect(manifest.kind).toBe('server');
        expect(manifest.server.orgId).toBe(orgId);
        expect(manifest.counts.databases).toBe(Object.keys(SERVER_DATABASES).length);
        expect(existsSync(join(folder, 'manifest.json'))).toBe(true);
    });

    test('takes the allowlist from server/ and leaves runtime and stray files out', () => {
        const allowed = new Set<string>([...Object.values(SERVER_DATABASES), ...Object.values(SERVER_FILES)]);
        const taken = new Set(
            manifest.entries.filter((e) => e.path.startsWith('server/')).map((e) => e.path.split('/')[1]),
        );
        for (const name of taken) expect(allowed.has(name)).toBe(true);
        for (const name of Object.values(SERVER_DATABASES)) expect(taken.has(name)).toBe(true);
        for (const name of [...STRAY_FILES, ...Object.values(SERVER_RUNTIME_FILES)])
            expect(taken.has(name)).toBe(false);
        expect(manifest.entries.map((e) => e.path)).toContain(`server/${SERVER_FILES.avatars}/${AVATAR_PROBE}`);
    });

    test('copies the org folder as plain files', () => {
        const rel = `org/${orgId}/${ORG_PROBE}`;
        expect(manifest.entries.map((e) => e.path)).toContain(rel);
        expect(readFileSync(join(folder, rel), 'utf8')).toBe('org file');
    });

    test('the three databases pass quick_check and the folder verifies', async () => {
        for (const name of Object.values(SERVER_DATABASES)) {
            const db = new Database(join(folder, 'server', name), { readonly: true });
            try {
                expect(db.query<{ quick_check: string }, []>('PRAGMA quick_check').get()?.quick_check).toBe('ok');
            } finally {
                db.close();
            }
        }
        const record = await verifyFolder(folder);
        expect(record.failures).toEqual([]);
        expect(record.status).toBe('verified');
    });

    test('verify judges the server databases: a broken one fails stage 2, naming it', async () => {
        const copy = join(mkdtempSync(join(TEST_DATA_DIR, 'server-broken-')), buildServerFolderName(at));
        cpSync(folder, copy, { recursive: true });
        const rel = `server/${SERVER_DATABASES.users}`;
        const bytes = readFileSync(join(copy, rel));
        bytes.fill(0xff, 4096, Math.min(bytes.length, 12288));
        writeFileSync(join(copy, rel), bytes);
        // Re-stated so stage 1 passes and only SQLite's verdict is left to fail.
        const copied: BackupManifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
        const entry = copied.entries.find((e) => e.path === rel)!;
        entry.bytes = bytes.length;
        entry.sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
        writeFileSync(join(copy, 'manifest.json'), JSON.stringify(copied));

        const record = await verifyFolder(copy);
        expect(record.status).toBe('failed');
        expect(record.failures.some((f) => f.startsWith(`${rel}: quick_check`))).toBe(true);
    });
});
