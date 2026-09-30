import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { DATA_EPOCHS_KEY, reloadReplacedHome } from './reload-replaced-home';

const loadedEpochs = new Map<string, string>(readStoredEpochs());

function readStoredEpochs(): [string, string][] {
    try {
        const stored: unknown = JSON.parse(window.sessionStorage.getItem(DATA_EPOCHS_KEY) ?? '{}');
        if (typeof stored !== 'object' || stored === null) return [];
        return Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    } catch {
        return [];
    }
}

export function handleHomeSSEvent(event: SSEvent): boolean {
    if (event?.type !== SSEventType.HOME_DATA_EPOCHS) return false;

    let changed = false;
    let replaced = false;
    for (const [ownerId, epoch] of Object.entries(event.epochs)) {
        const loaded = loadedEpochs.get(ownerId);
        if (loaded === epoch) continue;
        // A home it has not heard of is new to it (a team joined), not replaced.
        if (loaded !== undefined) replaced = true;
        loadedEpochs.set(ownerId, epoch);
        changed = true;
    }
    if (!changed) return true;
    // A page kept by the leave prompt asks only once: the map already holds the epoch it reloaded for.
    if (replaced) {
        reloadReplacedHome();
        return true;
    }
    try {
        window.sessionStorage.setItem(DATA_EPOCHS_KEY, JSON.stringify(Object.fromEntries(loadedEpochs)));
    } catch {}
    return true;
}
