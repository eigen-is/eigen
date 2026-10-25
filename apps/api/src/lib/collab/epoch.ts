// The frame that tells a collab socket its home's data epoch, sent on every open before the sync. A tab
// reconnects with the epoch it got, so after a restore replaced the home's data it reloads instead of
// syncing its old copy back.

import { COLLAB_EPOCH_MESSAGE } from '@workspace/lib/constants/collab';
import * as encoding from 'lib0/encoding';
import { getDataEpoch } from '../home/data-epoch';

export function collabEpochMessage(ownerId: string): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, COLLAB_EPOCH_MESSAGE);
    encoding.writeVarString(encoder, getDataEpoch(ownerId));
    return encoding.toUint8Array(encoder);
}
