// The data epoch is a random stamp that changes only when a restore replaces a home's data. An open
// browser tab remembers the stamp it started with. The event stream announces the current one and a
// collab socket checks it when it connects; when it differs, the tab reloads. Without it, a tab that
// was open (or offline) during a restore would sync its old state back over the restored data.
//
// The stamp is the server's part followed by the home's part. The server's part changes when the
// whole server is restored, the home's part when only that home is restored.

import { existsSync, readFileSync } from 'node:fs';
import { parseStringRecord } from '@workspace/lib/validation';
import { getServerDataPath, SERVER_RUNTIME_FILES } from '../config/paths';
import { LocalFilesystem } from '../core/local-filesystem';

// Backups leave the server's stamp file out, so a server restored from one draws a new stamp.
let serverEpoch: string | undefined;
// Owner id to stamp. A home that was never restored on its own has none.
let homeEpochs: Map<string, string> | undefined;
// Saves run one after another, each writing the whole map as it is then, so two restores that
// finish together can't write an older map over a newer one.
let homeEpochsSaved: Promise<void> = Promise.resolve();

const serverFs = new LocalFilesystem(getServerDataPath());

// A file that can't be read counts as "no restores yet": the tabs of a restored home then reload
// one more time, which is better than every event stream and collab socket failing. The next
// restore writes the file whole again.
function readHomeEpochs(file: string): Record<string, string> {
    if (!existsSync(file)) return {};
    const epochs = parseStringRecord(readFileSync(file, 'utf8'));
    if (!epochs) console.error(`[data-epoch] ${file} does not parse, so every home starts without an epoch of its own`);
    return epochs ?? {};
}

function loadHomeEpochs(): Map<string, string> {
    homeEpochs ??= new Map(Object.entries(readHomeEpochs(getServerDataPath(SERVER_RUNTIME_FILES.homeEpochs))));
    return homeEpochs;
}

export function getDataEpoch(ownerId: string): string {
    if (!serverEpoch) {
        const file = getServerDataPath(SERVER_RUNTIME_FILES.epoch);
        if (existsSync(file)) serverEpoch = readFileSync(file, 'utf8');
        if (!serverEpoch) {
            serverEpoch = crypto.randomUUID();
            // If a crash loses this write, the next start draws a new stamp and every tab reloads once.
            serverFs.writeAtomic(SERVER_RUNTIME_FILES.epoch, serverEpoch).catch(console.error);
        }
    }
    return serverEpoch + (loadHomeEpochs().get(ownerId) ?? '');
}

// Called by a restore of one home, after its data is back in place.
export async function rotateHomeDataEpoch(ownerId: string): Promise<void> {
    const epochs = loadHomeEpochs();
    epochs.set(ownerId, crypto.randomUUID());
    // A failed earlier save is that restore's error; this save still runs.
    const save = homeEpochsSaved
        .catch(() => {})
        .then(() => serverFs.writeAtomic(SERVER_RUNTIME_FILES.homeEpochs, JSON.stringify(Object.fromEntries(epochs))));
    homeEpochsSaved = save;
    await save;
}
