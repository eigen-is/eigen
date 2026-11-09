// Writes the stickies board that the demo seed copies into its world, byte for byte, which works because a document
// finds its parts by name. It boots the API on a throwaway data root, makes a real board through Drive and collab, and
// copies out its databases. Run it by hand from apps/api when the board's content changes. The other demo documents
// are built at seed time, so they need no fixture.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KANBAN, personaByRole } from './content';
import { buildStickiesDoc } from './fixtures-build';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

const scratch = mkdtempSync(join(tmpdir(), 'eigen-demo-authoring-'));
process.env['EIGEN_DATA_ROOT'] = scratch;
process.env['API_URL'] ||= 'http://localhost';
process.env['DOMAIN'] ||= 'fixtures.test';
mkdirSync(join(scratch, 'server'), { recursive: true });
mkdirSync(join(scratch, 'home'), { recursive: true });

const { app } = await import('../../app');
const { createSetupToken } = await import('../../lib/setup/setup-token');

const setupRes = await app.handle(
    new Request('http://localhost/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // local-fullnames keeps container internals as named files on disk so they are easy to copy out.
        body: JSON.stringify({
            setupToken: createSetupToken(),
            orgName: 'Fixtures',
            storageType: 'local-fullnames',
            adminUsername: 'author',
            adminPassword: 'fixtures-pw-123',
            adminName: 'Fixture Author',
        }),
    }),
);
if (!setupRes.ok) throw new Error(`Setup failed (${setupRes.status}): ${await setupRes.text()}`);

const { getHome, shutdownAllHomes } = await import('../../lib/home');
const { drainHomeDeliveries } = await import('../../lib/home/home-relay');

const { user } = (await setupRes.json()) as { user: { id: string } };
const home = await getHome(user.id);
const drive = home.drive;
const mountId = 'default';
const root = await drive.getRootFolder(mountId);
if (!root) throw new Error('Default mount root not found');
const rootId = root.id;

async function authorContainer(name: string, type: 'stickies', build: (doc: import('yjs').Doc) => void) {
    const container = await drive.create(mountId, rootId, name, type, home.user);
    const collab = await drive.getCollabDocument(mountId, container.id);
    build(collab.doc);
    await drive.flushContainerDb(mountId, container.id);
    console.log(`authored ${container.name}`);
}

await authorContainer(KANBAN.name, 'stickies', (doc) =>
    buildStickiesDoc(doc, KANBAN.columns, KANBAN.cards, personaByRole('production').key),
);

await drainHomeDeliveries();
await shutdownAllHomes();

// The shutdown checkpointed each database's WAL, so the bytes on disk are complete.
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
