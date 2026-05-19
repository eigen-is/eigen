import type { SSEventContact, SSEventLabel } from '@workspace/lib/types/sse';

export function buildContactEvent(type: SSEventContact['type'], contactId: string): SSEventContact {
    return { type, contactId };
}

export function buildLabelEvent(type: SSEventLabel['type'], labelId: string): SSEventLabel {
    return { type, labelId };
}
