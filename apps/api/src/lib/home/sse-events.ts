// Builds the data-epochs event the event stream sends when it opens and with every keepalive. It names
// the epoch of each home the user's tabs show as their own, so a tab reloads after a restore replaced one.

import { teamOwnerId } from '@workspace/lib/types/owner';
import type { SSEventHomeDataEpochs } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { getMemberships } from '../user';
import { getDataEpoch } from './data-epoch';

// The homes a user's tabs show as their own are theirs and every team's. A home that only shared
// something with them is not one of them.
export async function buildDataEpochsEvent(userId: string): Promise<SSEventHomeDataEpochs> {
    const { teamIds } = await getMemberships(userId);
    const ownerIds = [userId, ...teamIds.map(teamOwnerId)];
    return {
        type: SSEventType.HOME_DATA_EPOCHS,
        epochs: Object.fromEntries(ownerIds.map((ownerId) => [ownerId, getDataEpoch(ownerId)])),
    };
}
