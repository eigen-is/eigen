import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import { loadYjsState } from '../../lib/collab/yjs-loader';
import { openLocalDatabase } from '../../lib/core';
import { readSheetsFromDoc } from '../../lib/document/sheets';
import { readDeckFromDoc } from '../../lib/document/slides';
import { BRANDING, BUDGET, KANBAN, PHOTOS, personaByRole, SPONSOR_DECK, TEAM_NAME } from '../../scripts/demo/content';

// Contract test for the demo-world seeder. The seeder relies on module-level singletons
// (the Elysia app, the auth DB, the Home map), so it cannot run in-process alongside the
// test harness — spawn it as a subprocess against a throwaway data root and inspect the
// produced files directly with a readonly bun:sqlite handle.
const MAIL_DOMAIN = 'tuimel.test';
const API_DIR = join(import.meta.dir, '../../..');

// Read-write open (not readonly): the WAL-mode managed DBs need to (re)create their -shm on open,
// which readonly forbids. The seeder process has exited, so there is no lock contention, and the
// data root is a throwaway temp dir.
function query<T>(dbPath: string, sql: string): T[] {
    const db = new Database(dbPath);
    try {
        return db.query(sql).all() as T[];
    } finally {
        db.close();
    }
}

// Open a container's collab data.db (via a temp copy — openLocalDatabase writes WAL journals)
// and return its Y.Doc, using the same loader the shipped readers use.
async function loadCollabDoc(dataDbPath: string) {
    const tmp = join(mkdtempSync(join(tmpdir(), 'seed-demo-ydoc-')), 'data.db');
    cpSync(dataDbPath, tmp);
    return loadYjsState(await openLocalDatabase(COLLAB_DB_CONFIG, tmp)).doc;
}

function collectCommentMarkIds(json: JSONContent, out: Set<string>): void {
    for (const mark of json.marks ?? []) {
        if (mark.type === 'comment' && typeof mark.attrs?.['cardId'] === 'string') out.add(mark.attrs['cardId']);
    }
    for (const child of json.content ?? []) collectCommentMarkIds(child, out);
}

// Resolve a top-level container's data.db path from metadata.db (used for both the seeded doc
// and the stickies board — each container's data.db is a child path row, not the container itself).
function findContainerDataDb(metadataDb: string, mountsDir: string, mountId: string, containerName: string): string {
    const containerRow = query<{ id: string }>(
        metadataDb,
        `SELECT id FROM paths WHERE name = '${containerName}' AND trashedAt IS NULL`,
    );
    expect(containerRow.length).toBe(1);
    const dataDbRow = query<{ file: string }>(
        metadataDb,
        `SELECT file FROM paths WHERE parentId = '${containerRow[0].id}' AND name = 'data.db'`,
    );
    expect(dataDbRow.length).toBe(1);
    return join(mountsDir, mountId, 'data', dataDbRow[0].file);
}

describe('seed-demo', () => {
    test('produces a coherent Tuimel Festival world', async () => {
        const root = mkdtempSync(join(tmpdir(), 'eigen-demo-seed-'));
        try {
            // Env mirrors the real demo box: production mode, EIGEN_DEMO, and an https API_URL —
            // which makes better-auth __Secure--prefix its cookies, pinning the seeder's handling.
            const env: Record<string, string | undefined> = {
                ...process.env,
                EIGEN_DATA_ROOT: root,
                MAIL_DOMAIN,
                DOMAIN: MAIL_DOMAIN,
                PRODUCTION: '1',
                EIGEN_DEMO: '1',
                API_URL: 'https://localhost',
            };
            const proc = Bun.spawn(['bun', 'src/scripts/seed-demo.ts'], {
                cwd: API_DIR,
                env,
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);
            if (exitCode !== 0) {
                throw new Error(`seeder exited ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
            }

            // End-of-seed sentinel: the reset script's restart gate, written as the final step.
            expect(existsSync(join(root, 'server', '.demo-seeded'))).toBe(true);

            // Auth DB: the persona pool joined the default org as `member` (admin is `owner`).
            const usersDb = join(root, 'server', 'users3.db');
            expect(existsSync(usersDb)).toBe(true);
            const members = query<{ n: number }>(usersDb, "SELECT count(*) AS n FROM member WHERE role = 'member'");
            expect(members[0].n).toBeGreaterThanOrEqual(20);

            // Avatars: every org member got a portrait through the real avatar path — user.image
            // is set and the served webp exists under data/server/avatars (deterministic, offline).
            const membersMissingImage = query<{ n: number }>(
                usersDb,
                "SELECT count(*) AS n FROM member m JOIN user u ON u.id = m.user_id WHERE m.role = 'member' AND (u.image IS NULL OR u.image = '')",
            );
            expect(membersMissingImage[0].n).toBe(0);
            const avatarFiles = readdirSync(join(root, 'server', 'avatars')).filter((f) => f.endsWith('.webp'));
            expect(avatarFiles.length).toBeGreaterThanOrEqual(20);

            // The organization plugin auto-creates a default team, whose home can also materialize a
            // mounts/ dir during seeding — select the seeder's crew team by its name, not by disk layout.
            const teams = query<{ id: string }>(usersDb, `SELECT id FROM team WHERE name = '${TEAM_NAME}'`);
            expect(teams.length).toBe(1);
            const teamId = teams[0].id;
            expect(existsSync(join(root, 'team', teamId, 'mounts'))).toBe(true);

            // Team avatar: the festival logo fixture went through the same 512px-cover pipeline
            // as the avatar route — file existence under server/avatars is the source of truth.
            expect(existsSync(join(root, 'server', 'avatars', `team_${teamId}.webp`))).toBe(true);

            // Sample a persona: home dir exists, mail is indexed into mail.db.
            const personas = query<{ id: string }>(
                usersDb,
                "SELECT u.id AS id FROM member m JOIN user u ON u.id = m.user_id WHERE m.role = 'member' LIMIT 1",
            );
            expect(personas.length).toBe(1);
            const personaHome = join(root, 'home', personas[0].id);
            expect(existsSync(personaHome)).toBe(true);

            const mailDb = join(personaHome, 'eigen.mail', 'mail.db');
            expect(existsSync(mailDb)).toBe(true);
            const mail = query<{ n: number }>(mailDb, 'SELECT count(*) AS n FROM emails');
            expect(mail[0].n).toBeGreaterThanOrEqual(1);

            // Team drive: file history populated (actors were threaded through every mutation).
            const mountsDir = join(root, 'team', teamId!, 'mounts');
            expect(existsSync(mountsDir)).toBe(true);
            // mounts/ also holds shared.db — pick the mount's own subdirectory.
            const mountId = readdirSync(mountsDir, { withFileTypes: true }).find((d) => d.isDirectory())?.name;
            expect(mountId).toBeDefined();
            const metadataDb = join(mountsDir, mountId!, 'metadata.db');
            expect(existsSync(metadataDb)).toBe(true);
            const events = query<{ n: number }>(metadataDb, 'SELECT count(*) AS n FROM file_events');
            expect(events[0].n).toBeGreaterThanOrEqual(1);

            // Team drive images/: every site photo landed as a real .webp blob on disk (each row's
            // `file` is the storage key under the mount's data dir, non-trivial size = real image data).
            const imagesFolder = query<{ id: string }>(
                metadataDb,
                "SELECT id FROM paths WHERE name = 'images' AND trashedAt IS NULL",
            );
            expect(imagesFolder.length).toBe(1);
            const photoRows = query<{ name: string; file: string }>(
                metadataDb,
                `SELECT name, file FROM paths WHERE parentId = '${imagesFolder[0].id}' AND trashedAt IS NULL`,
            );
            expect(photoRows.length).toBe(PHOTOS.length);
            for (const photo of photoRows) {
                expect(photo.name).toEndWith('.webp');
                const blob = join(mountsDir, mountId!, 'data', photo.file);
                expect(existsSync(blob)).toBe(true);
                expect(statSync(blob).size).toBeGreaterThan(10_000);
            }

            // Team drive branding/: the logo landed as a real blob on disk.
            const brandingFolder = query<{ id: string }>(
                metadataDb,
                "SELECT id FROM paths WHERE name = 'branding' AND trashedAt IS NULL",
            );
            expect(brandingFolder.length).toBe(1);
            const brandingRows = query<{ name: string; file: string }>(
                metadataDb,
                `SELECT name, file FROM paths WHERE parentId = '${brandingFolder[0].id}' AND trashedAt IS NULL`,
            );
            expect(brandingRows.length).toBe(BRANDING.length);
            for (const asset of brandingRows) {
                const blob = join(mountsDir, mountId!, 'data', asset.file);
                expect(existsSync(blob)).toBe(true);
                expect(statSync(blob).size).toBeGreaterThan(0);
            }

            // Personal notes: the sampled persona's own drive has a "my notes" eigendoc container.
            const personaMetaDb = join(personaHome, 'mounts', 'default', 'metadata.db');
            expect(existsSync(personaMetaDb)).toBe(true);
            const notesDoc = query<{ n: number }>(
                personaMetaDb,
                "SELECT count(*) AS n FROM paths WHERE name = 'my notes.eigendoc' AND trashedAt IS NULL",
            );
            expect(notesDoc[0].n).toBe(1);

            // Budget sheet: hand-maintained fixture placed onto the team drive with real data.db bytes.
            // Decoded through the shipped reader, not just size-checked — the fixture bytes predate
            // every stored-shape change, so a rename that skips them has to fail here.
            const sheetDataDb = findContainerDataDb(metadataDb, mountsDir, mountId!, `${BUDGET.name}.eigensheets`);
            expect(statSync(sheetDataDb).size).toBeGreaterThan(0);
            const { sheets } = readSheetsFromDoc(await loadCollabDoc(sheetDataDb));
            expect(sheets.length).toBeGreaterThanOrEqual(1);
            expect(sheets[0].celldata?.length ?? 0).toBeGreaterThan(0);

            // Sponsor deck: its embedded image (media/logo.svg) landed as a real blob, so the
            // byte-copied deck stays whole (the deck references it by name).
            const deck = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE name = '${SPONSOR_DECK.name}.eigenslides' AND trashedAt IS NULL`,
            );
            expect(deck.length).toBe(1);
            const deckMedia = query<{ id: string }>(
                metadataDb,
                `SELECT id FROM paths WHERE parentId = '${deck[0].id}' AND name = 'media' AND trashedAt IS NULL`,
            );
            expect(deckMedia.length).toBe(1);
            const deckImages = query<{ name: string; file: string }>(
                metadataDb,
                `SELECT name, file FROM paths WHERE parentId = '${deckMedia[0].id}' AND trashedAt IS NULL`,
            );
            expect(deckImages.length).toBeGreaterThanOrEqual(1);
            for (const img of deckImages) {
                const blob = join(mountsDir, mountId!, 'data', img.file);
                expect(existsSync(blob)).toBe(true);
                expect(statSync(blob).size).toBeGreaterThan(0);
            }

            // ...and the deck itself reads back through the shipped reader with canonical geometry on
            // every object. yMapToObject materializes only OBJECT_FIELDS, so a fixture still carrying
            // pre-rename keys (w/h/rotation) yields undefined width/height/angle rather than throwing —
            // it would silently render collapsed in the demo. Assert the numbers, not just the read.
            const deckDoc = await loadCollabDoc(
                findContainerDataDb(metadataDb, mountsDir, mountId!, `${SPONSOR_DECK.name}.eigenslides`),
            );
            const deckData = readDeckFromDoc(deckDoc);
            expect(deckData.slideOrder.length).toBeGreaterThanOrEqual(1);
            const deckObjects = Object.values(deckData.objects);
            expect(deckObjects.length).toBeGreaterThanOrEqual(1);
            for (const obj of deckObjects) {
                for (const field of ['x', 'y', 'width', 'height', 'angle'] as const) {
                    expect(Number.isFinite(obj[field])).toBe(true);
                }
                expect(obj.width).toBeGreaterThan(0);
                expect(obj.height).toBeGreaterThan(0);
            }
            // Every slide's objectIds resolve, and each image object points at a media file that landed.
            const deckMediaNames = new Set(deckImages.map((img) => img.name));
            for (const slide of Object.values(deckData.slides)) {
                for (const objId of slide.objectIds) expect(deckData.objects[objId]).toBeDefined();
            }
            for (const obj of deckObjects) {
                if (obj.type === 'image') expect(deckMediaNames.has(obj.mediaName)).toBe(true);
            }

            // Team calendar: seeded events exist on the enabled team calendar.
            const calendarDb = join(root, 'team', teamId!, 'eigen.calendar', 'calendar.db');
            expect(existsSync(calendarDb)).toBe(true);
            const calEvents = query<{ n: number }>(calendarDb, 'SELECT count(*) AS n FROM events');
            expect(calEvents[0].n).toBeGreaterThanOrEqual(1);

            // The festival is all-day and MUST be stored as UTC midnight with an exclusive end (the
            // frontend buckets all-day events by their UTC date — local midnight would shift the
            // festival a day early in a UTC+ timezone). It always lands on a Saturday and spans Sat+Sun.
            const allDay = query<{ startTime: number; endTime: number }>(
                calendarDb,
                'SELECT startTime, endTime FROM events WHERE allDay = 1',
            );
            expect(allDay.length).toBeGreaterThanOrEqual(1);
            for (const ev of allDay) {
                const start = new Date(ev.startTime * 1000);
                const end = new Date(ev.endTime * 1000);
                expect(start.getUTCHours()).toBe(0);
                expect(start.getUTCMinutes()).toBe(0);
                expect(start.getUTCDay()).toBe(6); // Saturday, in UTC
                expect(end.getTime() - start.getTime()).toBe(2 * 86_400_000); // spans Sat + Sun
            }

            // Doc comments: the panel renders exclusively from the doc's `comments` Y.Map, and
            // only cards anchored by a comment mark in the text. Assert both for the seeded doc.
            const docDataDb = findContainerDataDb(metadataDb, mountsDir, mountId!, 'production plan.eigendoc');
            const ydoc = await loadCollabDoc(docDataDb);
            const cards = [...ydoc.getMap<import('yjs').Map<unknown>>('comments').values()].map((card) => ({
                id: card.get('id') as string,
                color: card.get('color') as string,
                chatName: card.get('chatName') as string,
                creator: card.get('creator') as string,
            }));
            expect(cards.length).toBeGreaterThanOrEqual(3);
            const defaultCardColor = EIGEN_STICKIES_COLORS[0][1].value;
            for (const card of cards) {
                expect(card.color).toBe(defaultCardColor);
                expect(card.chatName).toEndWith('.eigenchat');
                expect(card.creator).toContain('@');
            }
            const anchored = new Set<string>();
            collectCommentMarkIds(yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default')), anchored);
            for (const card of cards) {
                expect(anchored.has(card.id)).toBe(true);
            }

            // Stickies board: every card gets the same default color plus a real linked chat
            // (same pattern as doc comments), so no card ever renders uncolored or unlinked.
            const boardDataDb = findContainerDataDb(metadataDb, mountsDir, mountId!, `${KANBAN.name}.eigenstickies`);
            const board = await loadCollabDoc(boardDataDb);
            const tasks = [...board.getMap<import('yjs').Map<unknown>>('tasks').values()].map((task) => ({
                color: task.get('color') as string,
                chatName: task.get('chatName') as string,
                creator: task.get('creator') as string,
            }));
            expect(tasks.length).toBeGreaterThanOrEqual(8);
            for (const task of tasks) {
                expect(task.color).toBe(defaultCardColor);
                expect(task.chatName).toEndWith('.eigenchat');
                expect(task.creator).toContain('@');
            }

            // Assignment: the volunteer coordinator got the bell notification the assign route persists.
            const assignees = query<{ id: string }>(
                usersDb,
                `SELECT id FROM user WHERE email = '${personaByRole('volunteers').key}@${MAIL_DOMAIN}'`,
            );
            expect(assignees.length).toBe(1);
            const notifications = query<{ n: number }>(
                join(root, 'home', assignees[0].id, 'eigen.notifications', 'notifications.db'),
                "SELECT count(*) AS n FROM notifications WHERE type = 'assigned'",
            );
            expect(notifications[0].n).toBeGreaterThanOrEqual(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 120_000);
});
