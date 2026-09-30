import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { reloadReplacedHome } from './reload-replaced-home';

// The data epoch of every home this tab has heard of, as it first heard it. Module state lives as long as the page.
const loadedEpochs = new Map<string, string>();

export function handleHomeSSEvent(event: SSEvent): boolean {
    if (event?.type !== SSEventType.HOME_DATA_EPOCHS) return false;

    for (const [ownerId, epoch] of Object.entries(event.epochs)) {
        const loaded = loadedEpochs.get(ownerId);
        if (loaded !== undefined && loaded !== epoch) {
            reloadReplacedHome();
            return true;
        }
        loadedEpochs.set(ownerId, epoch);
    }
    return true;
}
