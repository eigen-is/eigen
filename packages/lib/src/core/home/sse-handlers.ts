import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { reloadReplacedHome } from './reload-replaced-home';

// The data epoch of every home this tab has heard of. Kept in the tab's sessionStorage, which outlives a reload: an
// editor tab reloads as soon as the restore closes its socket, and its stream first connects once the restore is done,
// so the first epoch that page hears is already the new one.
const STORAGE_KEY = 'eigen-data-epochs';
const loadedEpochs = new Map<string, string>(readStoredEpochs());

function readStoredEpochs(): [string, string][] {
    try {
        const stored: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '{}');
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
    // Before the reload: the page it brings up must not reload again, and one kept by the leave prompt asks only once.
    try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(loadedEpochs)));
    } catch {}
    if (replaced) reloadReplacedHome();
    return true;
}
