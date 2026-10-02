import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseStringRecord } from '@workspace/lib/validation';
import { getServerDataPath, SERVER_RUNTIME_FILES } from '../config/paths';
import { LocalFilesystem } from '../core/local-filesystem';

// A tab's epoch is the server's followed by its home's. A restart keeps both; ./eigen restore leaves the server's out and
// a restore of one home rotates that home's, so every older tab of what was restored reloads.
let serverEpoch: string | undefined;
// Home id to epoch; a home that was never restored on its own has none.
let homeEpochs: Map<string, string> | undefined;
// One write at a time, each of the map as it stands by then: two restores finishing together must not rename the
// older map over the newer one.
let homeEpochsSaved: Promise<void> = Promise.resolve();

const serverFs = new LocalFilesystem(getServerDataPath());

function drawEpoch(): string {
    return randomBytes(16).toString('base64url');
}

// A file that does not parse reads as no restores yet: the tabs of a restored home reload once more, where a throw
// here would fail every stream and collab open. The next rotation writes it whole again.
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
            serverEpoch = drawEpoch();
            // A write lost to a crash draws another epoch at the next start: every tab reloads once.
            serverFs.writeAtomic(SERVER_RUNTIME_FILES.epoch, serverEpoch).catch(console.error);
        }
    }
    return serverEpoch + (loadHomeEpochs().get(ownerId) ?? '');
}

export async function rotateHomeDataEpoch(ownerId: string): Promise<void> {
    const epochs = loadHomeEpochs();
    epochs.set(ownerId, drawEpoch());
    // A write that failed is its own caller's error, not the next one's.
    const save = homeEpochsSaved
        .catch(() => {})
        .then(() => serverFs.writeAtomic(SERVER_RUNTIME_FILES.homeEpochs, JSON.stringify(Object.fromEntries(epochs))));
    homeEpochsSaved = save;
    await save;
}
