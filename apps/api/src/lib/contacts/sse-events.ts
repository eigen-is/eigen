// Builds the contact and label events, which name the changed card or label. A bulk write, such as a
// whole-file import, sends the one contacts:changed instead of an event per card.

import type { SSEventContact, SSEventContactsChanged, SSEventLabel } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

export function buildContactEvent(type: SSEventContact['type'], contactId: string): SSEventContact {
    return { type, contactId };
}

export function buildLabelEvent(type: SSEventLabel['type'], labelId: string): SSEventLabel {
    return { type, labelId };
}

export function buildContactsChangedEvent(): SSEventContactsChanged {
    return { type: SSEventType.CONTACTS_CHANGED };
}
