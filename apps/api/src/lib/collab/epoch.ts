import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { COLLAB_EPOCH_MESSAGE } from '@workspace/lib/constants/collab';
import * as encoding from 'lib0/encoding';
import { getServerDataPath } from '../config/paths';

// In data/server/, so a restart keeps it and a snapshot carries it; ./eigen restore removes it from the data it puts
// back, so the first start after a restore draws a new one.
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

export function collabEpochMessage(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_EPOCH_MESSAGE);
    encoding.writeVarString(encoder, getCollabEpoch());
    return encoding.toUint8Array(encoder);
}
