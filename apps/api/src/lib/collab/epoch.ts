import { COLLAB_EPOCH_MESSAGE } from '@workspace/lib/constants/collab';
import * as encoding from 'lib0/encoding';
import { getDataEpoch } from '../home/data-epoch';

export function collabEpochMessage(ownerId: string): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_EPOCH_MESSAGE);
    encoding.writeVarString(encoder, getDataEpoch(ownerId));
    return encoding.toUint8Array(encoder);
}
