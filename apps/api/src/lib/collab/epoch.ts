import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { COLLAB_EPOCH_MESSAGE } from '@workspace/lib/constants/collab';
import * as encoding from 'lib0/encoding';
import { getServerDataPath } from '../config/paths';

// A restart keeps it; ./eigen restore leaves it out and a per-home restore rotates it, so every older tab reloads.
export const COLLAB_EPOCH_FILE = 'collab-epoch';

let epoch: string | undefined;

export function getCollabEpoch(): string {
    if (epoch) return epoch;
    const file = getServerDataPath(COLLAB_EPOCH_FILE);
    if (existsSync(file)) epoch = readFileSync(file, 'utf8');
    if (!epoch) {
        epoch = randomBytes(16).toString('base64url');
        writeFileSync(file, epoch);
    }
    return epoch;
}

export function rotateCollabEpoch(): void {
    rmSync(getServerDataPath(COLLAB_EPOCH_FILE), { force: true });
    epoch = undefined;
}

export function collabEpochMessage(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_EPOCH_MESSAGE);
    encoding.writeVarString(encoder, getCollabEpoch());
    return encoding.toUint8Array(encoder);
}
