import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {contactKeys} from './hooks/use-contacts';
import {labelKeys} from './hooks/use-labels';
import {invalidateHomeSize} from '../home';

export function handleContactsSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event.type.startsWith('contacts:')) return false;

    switch (event.type) {
        // API: New contact created → invalidate contacts list, home size
        case SSEventType.CONTACT_CREATED:
            queryClient.invalidateQueries({queryKey: contactKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;

        // API: Contact updated → invalidate contact detail, contacts list, home size
        case SSEventType.CONTACT_UPDATED: {
            if (!('contact' in event)) return false;
            const {contact} = event;
            queryClient.invalidateQueries({queryKey: contactKeys.detail(contact.contactId)});
            queryClient.invalidateQueries({queryKey: contactKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;
        }

        // API: Contact deleted → remove contact detail cache, invalidate contacts list, home size
        case SSEventType.CONTACT_DELETED: {
            if (!('contact' in event)) return false;
            const {contact} = event;
            queryClient.removeQueries({queryKey: contactKeys.detail(contact.contactId)});
            queryClient.invalidateQueries({queryKey: contactKeys.lists()});
            invalidateHomeSize(queryClient);
            return true;
        }

        // API: New label created → invalidate labels list
        case SSEventType.LABEL_CREATED:
            queryClient.invalidateQueries({queryKey: labelKeys.lists()});
            return true;

        // API: Label updated → invalidate label detail, labels list, contacts list (contacts show labels)
        case SSEventType.LABEL_UPDATED: {
            if (!('label' in event)) return false;
            const {label} = event;
            queryClient.invalidateQueries({queryKey: labelKeys.detail(label.labelId)});
            queryClient.invalidateQueries({queryKey: labelKeys.lists()});
            queryClient.invalidateQueries({queryKey: contactKeys.lists()});
            return true;
        }

        // API: Label deleted → remove label detail cache, invalidate labels list, contacts list
        case SSEventType.LABEL_DELETED: {
            if (!('label' in event)) return false;
            const {label} = event;
            queryClient.removeQueries({queryKey: labelKeys.detail(label.labelId)});
            queryClient.invalidateQueries({queryKey: labelKeys.lists()});
            queryClient.invalidateQueries({queryKey: contactKeys.lists()});
            return true;
        }

        default:
            return false;
    }
}
