import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { COLLAB_EPOCH_MESSAGE } from '@workspace/lib/constants/collab';
import * as encoding from 'lib0/encoding';
import { getServerDataPath, SERVER_RUNTIME_FILES } from '../config/paths';

// A tab's epoch is the server's followed by its home's. A restart keeps both; ./eigen restore leaves the server's out and
// a restore of one home rotates that home's, so every older tab of what was restored reloads.
let serverEpoch: string | undefined;
// Home id to epoch; a home that was never restored on its own has none.
let homeEpochs: Map<string, string> | undefined;

function drawEpoch(): string {
    return randomBytes(16).toString('base64url');
}

function loadHomeEpochs(): Map<string, string> {
    if (!homeEpochs) {
        const file = getServerDataPath(SERVER_RUNTIME_FILES.homeEpochs);
        homeEpochs = new Map(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : []);
    }
    return homeEpochs;
}

export function getCollabEpoch(ownerId: string): string {
    if (!serverEpoch) {
        const file = getServerDataPath(SERVER_RUNTIME_FILES.epoch);
        if (existsSync(file)) serverEpoch = readFileSync(file, 'utf8');
        if (!serverEpoch) {
            serverEpoch = drawEpoch();
            writeFileSync(file, serverEpoch);
        }
    }
    return serverEpoch + (loadHomeEpochs().get(ownerId) ?? '');
}

export function rotateHomeCollabEpoch(ownerId: string): void {
    const epochs = loadHomeEpochs();
    epochs.set(ownerId, drawEpoch());
    writeFileSync(getServerDataPath(SERVER_RUNTIME_FILES.homeEpochs), JSON.stringify(Object.fromEntries(epochs)));
}

export function collabEpochMessage(ownerId: string): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_EPOCH_MESSAGE);
    encoding.writeVarString(encoder, getCollabEpoch(ownerId));
    return encoding.toUint8Array(encoder);
}
