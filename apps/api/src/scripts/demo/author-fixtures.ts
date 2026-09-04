// One-off authoring script for the stickies board fixture container. Boots the API in-process
// against a throwaway data root (as the test harness does), creates a real stickies board through
// the shipped drive + collab surfaces, then copies its data.db and comments.db bytes into
// scripts/demo/fixtures/. The seeder byte-copies those into the demo world — legal because eigen-doc
// containers reference their internals by name, not pathId.
//
// The budget sheet fixture (`festival-budget.eigensheets`) is NOT authored here — it is
// hand-maintained (edited in a live demo and copied back), so this script must never regenerate it or
// it would clobber those edits. Its frozen bytes are the oldest stored shape we ship: rename a
// persisted field and it needs migrating too (the seed-demo contract test reads it back through the
// shipped reader to catch that). The deck and the site plan are built from content.ts at seed time
// (`demo/deck-build.ts`, `demo/vector-build.ts`), so they need no fixture bytes at all.
//
// Re-run whenever the board content (KANBAN) in content.ts changes:
//   cd apps/api && bun run src/scripts/demo/author-fixtures.ts
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KANBAN, personaByRole } from './content';
import { buildStickiesDoc } from './fixtures-build';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

const scratch = mkdtempSync(join(tmpdir(), 'eigen-demo-authoring-'));
process.env['EIGEN_DATA_ROOT'] = scratch;
process.env['API_URL'] ||= 'http://localhost';
mkdirSync(join(scratch, 'server'), { recursive: true });
mkdirSync(join(scratch, 'home'), { recursive: true });

const { app } = await import('../../app');

const setupRes = await app.handle(
    new Request('http://localhost/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // local-fullnames keeps container internals as named files on disk so they are easy to copy out.
        body: JSON.stringify({
            domain: 'fixtures.test',
            orgName: 'Fixtures',
            storageType: 'local-fullnames',
            adminEmail: 'admin@fixtures.test',
            adminPassword: 'fixtures-pw-123',
            adminName: 'Fixture Author',
        }),
    }),
);
if (!setupRes.ok) throw new Error(`Setup failed (${setupRes.status}): ${await setupRes.text()}`);

const { getHome, shutdownAllHomes } = await import('../../lib/home');
const { drainACLFanOuts } = await import('../../lib/drive/acl-propagation');

const { user } = (await setupRes.json()) as { user: { id: string } };
const home = await getHome(user.id);
const drive = home.drive;
const mountId = 'default';
const root = await drive.getRootFolder(mountId);
if (!root) throw new Error('Default mount root not found');

async function authorContainer(name: string, type: 'stickies', build: (doc: import('yjs').Doc) => void) {
    const container = await drive.create(mountId, root!.id, name, type, home.user);
    const collab = await drive.getCollabDocument(mountId, container.id);
    build(collab.doc);
    await drive.flushContainerDb(mountId, container.id);
    console.log(`authored ${container.name}`);
}

await authorContainer(KANBAN.name, 'stickies', (doc) =>
    buildStickiesDoc(doc, KANBAN.columns, KANBAN.cards, personaByRole('production').key),
);

await drainACLFanOuts();
await shutdownAllHomes();

// Post-shutdown the WAL is checkpointed into each data.db, so the on-disk bytes are complete.
// Walk the scratch tree and copy each container's data.db + comments.db into the repo fixtures.
const files = readdirSync(scratch, { recursive: true, encoding: 'utf8' });
function copyContainerDbs(extension: string, destDirName: string) {
    const dest = join(FIXTURES_DIR, destDirName);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    let copied = 0;
    for (const rel of files) {
        const marker = `${extension}/`;
        const idx = rel.indexOf(marker);
        if (idx === -1) continue;
        const tail = rel.slice(idx + marker.length);
        if (tail === 'data.db' || tail === 'comments.db') {
            cpSync(join(scratch, rel), join(dest, tail));
            copied++;
        }
    }
    if (copied < 2) throw new Error(`Expected data.db + comments.db for ${extension}, copied ${copied}`);
    console.log(`wrote ${destDirName} (${copied} files)`);
}

copyContainerDbs('.eigenstickies', 'festival-kanban.eigenstickies');

rmSync(scratch, { recursive: true, force: true });
console.log('fixtures written to', FIXTURES_DIR);
process.exit(0);
