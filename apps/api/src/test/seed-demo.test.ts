import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Contract test for the demo-world seeder. The seeder relies on module-level singletons
// (the Elysia app, the auth DB, the Home map), so it cannot run in-process alongside the
// test harness — spawn it as a subprocess against a throwaway data root and inspect the
// produced files directly with a readonly bun:sqlite handle.
const MAIL_DOMAIN = 'tuimel.test';
const API_DIR = join(import.meta.dir, '../..');

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

describe('seed-demo', () => {
    test('produces a coherent Tuimel Festival world', async () => {
        const root = mkdtempSync(join(tmpdir(), 'eigen-demo-seed-'));
        try {
            // Drop any inherited API_URL so the seeder's own default is exercised.
            const env: Record<string, string | undefined> = {
                ...process.env,
                EIGEN_DATA_ROOT: root,
                MAIL_DOMAIN,
                DOMAIN: MAIL_DOMAIN,
            };
            env['API_URL'] = undefined;
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

            // Auth DB: the persona pool joined the default org as `member` (admin is `owner`).
            const usersDb = join(root, 'server', 'users3.db');
            expect(existsSync(usersDb)).toBe(true);
            const members = query<{ n: number }>(usersDb, "SELECT count(*) AS n FROM member WHERE role = 'member'");
            expect(members[0].n).toBeGreaterThanOrEqual(20);

            // The organization plugin auto-creates a default team; target the one the seeder
            // actually gave a mount (its data dir exists on disk).
            const teams = query<{ id: string }>(usersDb, 'SELECT id FROM team');
            expect(teams.length).toBeGreaterThanOrEqual(1);
            const teamId = teams.map((t) => t.id).find((id) => existsSync(join(root, 'team', id, 'mounts')));
            expect(teamId).toBeDefined();

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

            // Team calendar: seeded events exist on the enabled team calendar.
            const calendarDb = join(root, 'team', teamId!, 'eigen.calendar', 'calendar.db');
            expect(existsSync(calendarDb)).toBe(true);
            const calEvents = query<{ n: number }>(calendarDb, 'SELECT count(*) AS n FROM events');
            expect(calEvents[0].n).toBeGreaterThanOrEqual(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 120_000);
});
