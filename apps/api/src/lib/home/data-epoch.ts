import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getServerDataPath } from '../config/paths';

// A tab's epoch is the server's followed by its home's. A restart keeps both; ./eigen restore leaves the server's out and
// a restore of one home rotates that home's, so every older tab of what was restored reloads.
export const DATA_EPOCH_FILE = 'data-epoch';
// Home id to epoch; a home that was never restored on its own has none.
const HOME_EPOCHS_FILE = 'home-data-epochs.json';

let serverEpoch: string | undefined;
let homeEpochs: Map<string, string> | undefined;

function drawEpoch(): string {
    return randomBytes(16).toString('base64url');
}

function loadHomeEpochs(): Map<string, string> {
    if (!homeEpochs) {
        const file = getServerDataPath(HOME_EPOCHS_FILE);
        homeEpochs = new Map(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : []);
    }
    return homeEpochs;
}

export function getDataEpoch(ownerId: string): string {
    if (!serverEpoch) {
        const file = getServerDataPath(DATA_EPOCH_FILE);
        if (existsSync(file)) serverEpoch = readFileSync(file, 'utf8');
        if (!serverEpoch) {
            serverEpoch = drawEpoch();
            writeFileSync(file, serverEpoch);
        }
    }
    return serverEpoch + (loadHomeEpochs().get(ownerId) ?? '');
}

export function rotateHomeDataEpoch(ownerId: string): void {
    const epochs = loadHomeEpochs();
    epochs.set(ownerId, drawEpoch());
    writeFileSync(getServerDataPath(HOME_EPOCHS_FILE), JSON.stringify(Object.fromEntries(epochs)));
}
