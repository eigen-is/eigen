import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { COLLAB_EPOCH_MESSAGE } from '@workspace/lib/constants/collab';
import * as encoding from 'lib0/encoding';
import { getServerDataPath } from '../config/paths';

// A tab's epoch is the server's followed by its home's. A restart keeps both; ./eigen restore leaves the server's out and
// a restore of one home rotates that home's, so every older tab of what was restored reloads.
export const COLLAB_EPOCH_FILE = 'collab-epoch';
// Home id to epoch; a home that was never restored on its own has none.
const HOME_EPOCHS_FILE = 'collab-home-epochs.json';

let serverEpoch: string | undefined;
let homeEpochs: Map<string, string> | undefined;

function drawEpoch(): string {
    return randomBytes(16).toString('base64url');
}

function getHomeEpochs(): Map<string, string> {
    if (!homeEpochs) {
        const file = getServerDataPath(HOME_EPOCHS_FILE);
        homeEpochs = new Map(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : []);
    }
    return homeEpochs;
}

export function getCollabEpoch(ownerId: string): string {
    if (!serverEpoch) {
        const file = getServerDataPath(COLLAB_EPOCH_FILE);
        if (existsSync(file)) serverEpoch = readFileSync(file, 'utf8');
        if (!serverEpoch) {
            serverEpoch = drawEpoch();
            writeFileSync(file, serverEpoch);
        }
    }
    return serverEpoch + (getHomeEpochs().get(ownerId) ?? '');
}

export function rotateHomeCollabEpoch(ownerId: string): void {
    const epochs = getHomeEpochs();
    epochs.set(ownerId, drawEpoch());
    writeFileSync(getServerDataPath(HOME_EPOCHS_FILE), JSON.stringify(Object.fromEntries(epochs)));
}

export function collabEpochMessage(ownerId: string): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_EPOCH_MESSAGE);
    encoding.writeVarString(encoder, getCollabEpoch(ownerId));
    return encoding.toUint8Array(encoder);
}
