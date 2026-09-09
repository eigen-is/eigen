import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import type { BackupEntry, BackupManifest } from '@workspace/lib/types/backup';
import type { CalendarItem } from '@workspace/lib/types/calendar';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { buildArtifactName, buildHomeFolderName, parseArtifactName } from '../../lib/backup/paths';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import { docUpdates } from '../../lib/collab/schema';
import { getAvatarsDir } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home/get-home';
import { createMountConfig } from '../../lib/mount';
import {
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    driveDelete,
    driveGetList,
    drivePost,
    driveUpload,
    findOrFail,
    getTestContext,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const LOCAL_MOUNT_ID = 'backup-local';
const PROBE_TEXT = 'backup-probe';
// A share to an address with no account is what writes a share_registry row (acl-propagation.ts).
const SHARE_TARGET = 'outsider@external.test';

async function listArchiveFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    for await (const file of new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true, dot: true })) {
        found.push(file.replaceAll('\\', '/'));
    }
    return found.sort();
}

async function sha256Of(filePath: string): Promise<string> {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(await Bun.file(filePath).arrayBuffer()));
    return hasher.digest('hex');
}

function syncUpdateMessage(doc: Y.Doc): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // MESSAGE_SYNC (mirrors collabDocument.ts)
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
    return encoding.toUint8Array(encoder);
}

describe('Backup snapshotHome', () => {
    let ctx: TestCtx;
    let folder: string;
    let manifest: BackupManifest;
    let files: string[];
    let defaultMountId: string;
    let docId: string;
    let liveUpdateCount: number;

    beforeAll(async () => {
        ctx = await getTestContext();
        const alice = ctx.alice.user;
        const home = await getHome(alice.id);

        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(alice.sessionToken, `/drive/${alice.id}/mounts`),
        );
        defaultMountId = mounts[0].id;

        // A second mount on the other local backend, so the walk is exercised on both key shapes.
        const settings = await home.settings.set({
            mounts: { [LOCAL_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Backup Local' } },
        });
        await home.drive.addMount(createMountConfig(LOCAL_MOUNT_ID, settings.mounts![LOCAL_MOUNT_ID]));

        const root = await assertJson<DrivePath>(
            await authedRequest(alice.sessionToken, `/drive/${alice.id}/${defaultMountId}/root`),
        );
        const localRoot = await assertJson<DrivePath>(
            await authedRequest(alice.sessionToken, `/drive/${alice.id}/${LOCAL_MOUNT_ID}/root`),
        );

        // Containers: a doc edited over a live collab connection, a sheet, a chat.
        const doc = await drivePost(alice.sessionToken, alice.id, defaultMountId, `folder/${root.id}/create/doc`, {
            fileName: 'Backup Doc',
        });
        docId = doc.id;
        await drivePost(alice.sessionToken, alice.id, defaultMountId, `folder/${root.id}/create/sheets`, {
            fileName: 'Backup Sheet',
        });
        await drivePost(alice.sessionToken, alice.id, defaultMountId, `folder/${root.id}/create/chat`, {
            fileName: 'Backup Chat',
        });

        const collab = await home.drive.getCollabDocument(defaultMountId, docId);
        const edit = new Y.Doc();
        edit.getText('probe').insert(0, PROBE_TEXT);
        const conn = { send() {}, readyState: 1 } as unknown as Parameters<typeof collab.handleMessage>[0];
        collab.handleMessage(conn, syncUpdateMessage(edit), true);

        const liveDb = await home.drive.openDatabase(defaultMountId, COLLAB_DB_CONFIG, collab.dataDbPathId!);
        liveUpdateCount = liveDb.db.select().from(docUpdates).all().length;

        // Two version snapshots of the doc container.
        for (const _ of [0, 1]) {
            const res = await authedRequest(
                alice.sessionToken,
                `/drive/${alice.id}/${defaultMountId}/file/${docId}/versions/save`,
                { method: 'POST' },
            );
            expect(res.status).toBe(200);
        }

        // A plain file on each mount; the one on the default mount goes to trash.
        const trashed = await driveUpload(
            alice.sessionToken,
            alice.id,
            defaultMountId,
            root.id,
            new File([TEST_PNG_BYTES], 'trashed.png', { type: 'image/png' }),
        );
        await driveDelete(alice.sessionToken, alice.id, defaultMountId, `path/${trashed.id}`);
        await driveUpload(
            alice.sessionToken,
            alice.id,
            LOCAL_MOUNT_ID,
            localRoot.id,
            new File([TEST_PNG_BYTES], 'kept.png', { type: 'image/png' }),
        );

        // A share, so share_registry has a row from alice.
        const shared = await driveUpload(
            alice.sessionToken,
            alice.id,
            defaultMountId,
            root.id,
            new File([TEST_PNG_BYTES], 'shared.png', { type: 'image/png' }),
        );
        const aclRes = await authedRequest(
            alice.sessionToken,
            `/drive/${alice.id}/${defaultMountId}/path/${shared.id}/acl`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ add: [{ id: SHARE_TARGET, read: true, write: false }] }),
            },
        );
        expect(aclRes.status).toBe(200);

        // Mail in Maildir; the inbox sync also persists a mail:new notification.
        for (const subject of ['Backup One', 'Backup Two']) {
            const eml = [`From: sender@external.com`, `To: ${alice.email}`, `Subject: ${subject}`, '', 'body'].join(
                '\r\n',
            );
            const res = await ctx.app.handle(
                new Request(`http://localhost/mail/deliver/${alice.email}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'message/rfc822' },
                    body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
                }),
            );
            expect(res.status).toBe(200);
        }
        await authedRequest(alice.sessionToken, `/mail/${alice.id}/mailbox/`);

        // A contact card and a calendar event.
        await authedRequest(alice.sessionToken, `/contacts/${alice.id}/contacts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firstName: 'Backup', lastName: 'Contact', email: ['backup@test.eigen.is'] }),
        });
        const calendars = await assertJson<CalendarItem[]>(
            await authedRequest(alice.sessionToken, `/calendar/${alice.id}/calendars`),
        );
        const calendarId = findOrFail(calendars, (c) => c.isDefault).id;
        await authedRequest(alice.sessionToken, `/calendar/${alice.id}/calendars/${calendarId}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Backup Event',
                start: new Date('2026-09-10T10:00:00Z').toISOString(),
                end: new Date('2026-09-10T11:00:00Z').toISOString(),
            }),
        });

        await Bun.write(join(getAvatarsDir(), `${alice.id}.webp`), TEST_PNG_BYTES);

        const target = mkdtempSync(join(TEST_DATA_DIR, 'backup-'));
        manifest = await snapshotHome(home, target);
        folder = join(target, buildHomeFolderName(alice.id));
        files = await listArchiveFiles(folder);
    });

    test('writes the folder layout from the spec', () => {
        expect(existsSync(folder)).toBe(true);
        expect(files).toContain('manifest.json');
        expect(files).toContain('auth.json');
        expect(files).toContain('shares.json');
        expect(files).toContain(`avatar/${ctx.alice.user.id}.webp`);
        expect(files).toContain('home/settings.json');
        expect(files).toContain('home/mounts/shared.db');
        expect(files).toContain(`home/mounts/${defaultMountId}/metadata.db`);
        expect(files).toContain(`home/mounts/${LOCAL_MOUNT_ID}/metadata.db`);
        expect(files).toContain('home/eigen.mail/mail.db');
        expect(files).toContain('home/eigen.contacts/contacts.db');
        expect(files).toContain('home/eigen.calendar/calendar.db');
        expect(files).toContain('home/eigen.notifications/notifications.db');
        expect(files.filter((f) => f.startsWith('home/eigen.mail/Maildir/')).length).toBeGreaterThanOrEqual(2);
        expect(files.filter((f) => f.startsWith('home/eigen.contacts/cards/')).length).toBeGreaterThanOrEqual(1);
    });

    test('manifest describes the home', () => {
        const config = getServerConfig()!;
        expect(manifest.formatVersion).toBe(1);
        expect(manifest.kind).toBe('user');
        expect(manifest.ownerId).toBe(ctx.alice.user.id);
        expect(manifest.email).toBe(ctx.alice.user.email);
        expect(manifest.name).toBe(ctx.alice.user.name);
        expect(manifest.appVersion.length).toBeGreaterThan(0);
        expect(manifest.server).toEqual({ domain: config.domain, orgId: config.orgId });
        expect(new Date(manifest.createdAt).getTime()).toBeGreaterThan(0);
        expect(manifest.mounts.map((m) => m.id).sort()).toEqual([LOCAL_MOUNT_ID, defaultMountId].sort());
        expect(findOrFail(manifest.mounts, (m) => m.id === LOCAL_MOUNT_ID).storageType).toBe('local');
    });

    test('entries cover every file except the manifest, with matching size and sha256', async () => {
        const expected = files.filter((f) => f !== 'manifest.json');
        expect(manifest.entries.map((e) => e.path).sort()).toEqual(expected);

        for (const entry of manifest.entries) {
            const abs = join(folder, entry.path);
            expect(Bun.file(abs).size).toBe(entry.bytes);
            expect(await sha256Of(abs)).toBe(entry.sha256);
        }
    });

    test('counts add up', () => {
        const dbEntries = manifest.entries.filter((e: BackupEntry) => e.path.endsWith('.db'));
        expect(manifest.counts.databases).toBe(dbEntries.length);
        expect(manifest.counts.files).toBe(manifest.entries.length - dbEntries.length);
        expect(manifest.counts.bytes).toBe(manifest.entries.reduce((sum, e) => sum + e.bytes, 0));
    });

    test('every copied database passes quick_check', () => {
        const dbs = files.filter((f) => f.endsWith('.db'));
        expect(dbs.length).toBeGreaterThan(4);
        for (const rel of dbs) {
            let db: Database;
            try {
                db = new Database(join(folder, rel), { readonly: true });
            } catch (e) {
                throw new Error(`open ${rel}: ${e}`);
            }
            try {
                const row = db.query('PRAGMA quick_check').get() as { quick_check: string };
                expect(`${rel}: ${row.quick_check}`).toBe(`${rel}: ok`);
            } finally {
                db.close();
            }
        }
    });

    test('the live collab edit is in the copied data.db', () => {
        const dataDb = findOrFail(
            files,
            (f) => f.startsWith(`home/mounts/${defaultMountId}/data/Backup Doc.eigendoc/`) && f.endsWith('data.db'),
        );
        const db = new Database(join(folder, dataDb), { readonly: true });
        try {
            const rows = db.query('SELECT updateData FROM doc_updates').all() as { updateData: Uint8Array }[];
            expect(rows.length).toBeGreaterThanOrEqual(liveUpdateCount);
            const replay = new Y.Doc();
            for (const row of rows) Y.applyUpdate(replay, new Uint8Array(row.updateData));
            expect(replay.getText('probe').toString()).toContain(PROBE_TEXT);
        } finally {
            db.close();
        }
    });

    test('version history and trash are included, caches are not', () => {
        const versions = files.filter((f) => f.includes('/versions/'));
        expect(versions.length).toBe(2);
        expect(files.some((f) => f.includes('/data/.trash/'))).toBe(true);
        expect(files.some((f) => f.includes('/thumbs/'))).toBe(false);
        expect(files.some((f) => f.includes('/tmp/'))).toBe(false);
        expect(files.some((f) => f.includes('/staging/'))).toBe(false);
        expect(files.some((f) => f.includes('/eigen.contacts/avatars/'))).toBe(false);
    });

    test('auth.json carries this user rows only', async () => {
        const auth = (await Bun.file(join(folder, 'auth.json')).json()) as Record<string, { id?: string }[]>;
        expect(Object.keys(auth).sort()).toEqual(
            ['account', 'apikey', 'member', 'team_member', 'two_factor', 'user'].sort(),
        );
        expect(auth['user'].length).toBe(1);
        expect(auth['account'].length).toBeGreaterThanOrEqual(1);
        for (const key of ['apikey', 'member', 'team_member', 'two_factor']) {
            expect(Array.isArray(auth[key])).toBe(true);
        }
    });

    test('shares.json holds the seeded registry row', async () => {
        const shares = (await Bun.file(join(folder, 'shares.json')).json()) as {
            fromUserId: string;
            targetIdentifier: string;
        }[];
        expect(shares.some((s) => s.targetIdentifier === SHARE_TARGET)).toBe(true);
        expect(shares.every((s) => s.fromUserId === ctx.alice.user.id)).toBe(true);
    });

    test('the snapshot leaves the live drive intact', async () => {
        const contents = await driveGetList(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            defaultMountId,
            `folder/${(await assertJson<DrivePath>(await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/${defaultMountId}/root`))).id}`,
        );
        expect(contents.some((c) => c.id === docId)).toBe(true);
    });
});

describe('Backup snapshotHome for a team', () => {
    let folder: string;
    let manifest: BackupManifest;
    let files: string[];

    beforeAll(async () => {
        const ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;
        const teamId = await createTeam(ctx, orgId, `Backup Team ${Date.now()}`);
        await addTeamMount(ctx, teamId, 'Team Files');

        const home = await getHome(teamOwnerId(teamId));
        const target = mkdtempSync(join(TEST_DATA_DIR, 'backup-team-'));
        manifest = await snapshotHome(home, target);
        folder = join(target, buildHomeFolderName(teamOwnerId(teamId)));
        files = await listArchiveFiles(folder);
    });

    test('has no user-only surfaces', () => {
        expect(manifest.kind).toBe('team');
        expect(manifest.email).toBeUndefined();
        expect(files).toContain('manifest.json');
        expect(files).toContain('home/settings.json');
        expect(files).toContain('home/eigen.calendar/calendar.db');
        expect(files).not.toContain('auth.json');
        expect(files).not.toContain('shares.json');
        expect(files.some((f) => f.startsWith('avatar/'))).toBe(false);
        expect(files.some((f) => f.startsWith('home/eigen.mail/'))).toBe(false);
        expect(files.some((f) => f.startsWith('home/eigen.contacts/'))).toBe(false);
        expect(files.some((f) => f.startsWith('home/eigen.notifications/'))).toBe(false);
    });
});

describe('Backup artifact names', () => {
    test('round-trips a user and a team ownerId', () => {
        const at = new Date('2026-09-09T14:03:07Z');
        for (const ownerId of ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', 'team_abc123']) {
            const name = buildArtifactName(ownerId, at);
            expect(name).toBe(`home-${ownerId}-20260909-140307.tar.zst`);
            const parsed = parseArtifactName(name);
            expect(parsed).not.toBeNull();
            expect(parsed!.ownerId).toBe(ownerId);
            expect(parsed!.at.toISOString()).toBe(at.toISOString());
        }
    });

    test('rejects anything that is not an artifact name', () => {
        for (const bad of [
            'home-../../etc/passwd-20260909-140307.tar.zst',
            'home-abc-20260909-140307.tar',
            'home--20260909-140307.tar.zst',
            'nothome-abc-20260909-140307.tar.zst',
            'home-abc-2026099-140307.tar.zst',
            'home-abc-20261309-140307.tar.zst',
        ]) {
            expect(parseArtifactName(bad)).toBeNull();
        }
    });
});
