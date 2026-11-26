// The open contact on the contacts page: its bar's actions, such as edit, label or delete, and its card. A team
// member shows in the same card. The card is what Print prints.

import { useLabels } from '@workspace/lib/contacts';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { ContactDetailCard } from '@workspace/ui/components/user';
import { PersonDetailToolbar } from './person-detail-toolbar';

type ContactDetailToolbarProps = {
    contact: Contact;
    filterType?: string;
    filterId?: string;
    labels?: Label[];
    onToggleLabel?: (contacts: Contact[], labelId: string) => void;
    onDeleteClick: () => void;
};

export function ContactDetailToolbar({
    contact,
    filterType,
    filterId,
    labels,
    onToggleLabel,
    onDeleteClick,
}: ContactDetailToolbarProps) {
    return (
        <PersonDetailToolbar
            contact={contact}
            editSearch={{ filterType: filterType || 'filter', filterId: filterId || 'all', contactId: contact.id }}
            labels={labels}
            onToggleLabel={onToggleLabel}
            onDeleteClick={onDeleteClick}
        />
    );
}

type ContactDetailProps = {
    contact: Contact;
};

export function ContactDetail({ contact }: ContactDetailProps) {
    const { data: labels = [], error: labelsError } = useLabels();

    const contactLabels = contact.labels ? labels.filter((label) => contact.labels?.includes(label.id)) : [];

    return (
        <div data-document="contact-detail">
            {labelsError && <p className="text-sm text-destructive">Error loading labels</p>}
            <ContactDetailCard contact={contact} labels={contactLabels} />
        </div>
    );
}
