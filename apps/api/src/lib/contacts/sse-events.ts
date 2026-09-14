import type { SSEventContact, SSEventContactsChanged, SSEventLabel } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

export function buildContactEvent(type: SSEventContact['type'], contactId: string): SSEventContact {
    return { type, contactId };
}

export function buildLabelEvent(type: SSEventLabel['type'], labelId: string): SSEventLabel {
    return { type, labelId };
}

// One event for a bulk write, in place of the per-card burst it replaces.
export function buildContactsChangedEvent(): SSEventContactsChanged {
    return { type: SSEventType.CONTACTS_CHANGED };
}
