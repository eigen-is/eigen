import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

type ContactEventType =
    typeof SSEventType.CONTACT_CREATED
    | typeof SSEventType.CONTACT_UPDATED
    | typeof SSEventType.CONTACT_DELETED;

type LabelEventType =
    typeof SSEventType.LABEL_CREATED
    | typeof SSEventType.LABEL_UPDATED
    | typeof SSEventType.LABEL_DELETED;

export function buildContactEvent(type: ContactEventType, contactId: string): SSEvent {
    return {type, contactId} as SSEvent;
}

export function buildLabelEvent(type: LabelEventType, labelId: string): SSEvent {
    return {type, labelId} as SSEvent;
}
