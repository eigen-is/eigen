import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {invalidateContactCreated, invalidateContactUpdated, invalidateContactDeleted} from './hooks/use-contacts';
import {invalidateLabelCreated, invalidateLabelUpdated, invalidateLabelDeleted} from './hooks/use-labels';

export function handleContactsSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('contacts:')) return false;

    switch (event.type) {
        case SSEventType.CONTACT_CREATED:
            invalidateContactCreated(queryClient);
            return true;

        case SSEventType.CONTACT_UPDATED: {
            if (!('contact' in event)) return false;
            invalidateContactUpdated(queryClient, event.contact.contactId);
            return true;
        }

        case SSEventType.CONTACT_DELETED: {
            if (!('contact' in event)) return false;
            invalidateContactDeleted(queryClient, event.contact.contactId);
            return true;
        }

        case SSEventType.LABEL_CREATED:
            invalidateLabelCreated(queryClient);
            return true;

        case SSEventType.LABEL_UPDATED: {
            if (!('label' in event)) return false;
            invalidateLabelUpdated(queryClient, event.label.labelId);
            return true;
        }

        case SSEventType.LABEL_DELETED: {
            if (!('label' in event)) return false;
            invalidateLabelDeleted(queryClient, event.label.labelId);
            return true;
        }

        default:
            return false;
    }
}
