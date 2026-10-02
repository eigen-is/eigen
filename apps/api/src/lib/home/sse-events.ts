import { teamOwnerId } from '@workspace/lib/types/owner';
import type { SSEventHomeDataEpochs } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { getMemberships } from '../user';
import { getDataEpoch } from './data-epoch';

// The homes a user's tabs show as their own: theirs and every team's. Another home that only shared something is not
// one of them.
export async function buildDataEpochsEvent(userId: string): Promise<SSEventHomeDataEpochs> {
    const { teamIds } = await getMemberships(userId);
    const ownerIds = [userId, ...teamIds.map(teamOwnerId)];
    return {
        type: SSEventType.HOME_DATA_EPOCHS,
        epochs: Object.fromEntries(ownerIds.map((ownerId) => [ownerId, getDataEpoch(ownerId)])),
    };
}
